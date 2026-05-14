"""Gantry config + position API endpoints."""

import copy
import inspect
import logging
import threading
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from gantry import Gantry
from gantry.grbl_settings import normalize_expected_grbl_settings
from gantry.yaml_schema import GantryYamlSchema
from instruments.base_instrument import BaseInstrument
from instruments.pipette.models import PIPETTE_MODELS
from instruments.registry import (
    get_instrument_class,
    get_supported_types,
    get_supported_vendors,
)
from pydantic import BaseModel

from zoo.config import get_settings
from zoo.models.gantry import GantryPosition, GantryResponse
from zoo.services.yaml_io import list_configs, read_yaml, resolve_config_path, write_yaml

router = APIRouter(prefix="/api/gantry", tags=["gantry"])

# Single Gantry instance shared across requests.
_gantry: Optional[Gantry] = None
# Serialize all serial port access so position polls and jogs don't collide.
_serial_lock = threading.Lock()
# Last known good position — returned when the lock is busy.
_last_position: Optional[GantryPosition] = None
# Non-blocking warning surfaced after connect when the controller settings do
# not match the selected gantry YAML. The connection stays open for calibration.
_calibration_warning: Optional[str] = None

# Primitive types that can be represented in YAML / JSON form fields.
_PRIMITIVE_TYPES = {str, int, float, bool}

# Base-class params rendered separately by the UI (offsets, depth, etc.).
_BASE_PARAMS = {
    p for p in inspect.signature(BaseInstrument.__init__).parameters if p != "self"
}


class PipetteModelInfo(BaseModel):
    name: str
    family: str
    channels: int
    max_volume: float
    min_volume: float


class InstrumentTypeInfo(BaseModel):
    type: str
    vendors: List[str]
    is_mock: bool


class InstrumentFieldInfo(BaseModel):
    name: str
    type: str
    required: bool
    default: Any = None
    choices: Optional[List[str]] = None


def _type_name(annotation: Any) -> str:
    """Convert a Python type annotation to a simple string."""
    name = getattr(annotation, "__name__", None)
    if name:
        return name
    return str(annotation)


def _is_primitive(annotation: Any) -> bool:
    """Check if an annotation is a JSON-serialisable primitive."""
    if annotation in _PRIMITIVE_TYPES:
        return True
    args = getattr(annotation, "__args__", ())
    if args and type(None) in args:
        return any(a in _PRIMITIVE_TYPES for a in args if a is not type(None))
    return False


def _build_instrument_fields(type_key: str) -> List[InstrumentFieldInfo]:
    """Introspect an instrument class's __init__ to build field metadata."""
    cls = get_instrument_class(type_key)
    sig = inspect.signature(cls.__init__)
    fields: List[InstrumentFieldInfo] = []
    for param_name, param in sig.parameters.items():
        if param_name == "self" or param_name in _BASE_PARAMS:
            continue
        annotation = param.annotation if param.annotation != inspect.Parameter.empty else str
        if not _is_primitive(annotation):
            continue
        required = param.default is inspect.Parameter.empty
        default = None if required else param.default
        choices = None
        if param_name == "pipette_model":
            choices = sorted(PIPETTE_MODELS.keys())
        fields.append(
            InstrumentFieldInfo(
                name=param_name,
                type=_type_name(annotation),
                required=required,
                default=default,
                choices=choices,
            )
        )
    return fields


def _float_or(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _normalize_gantry_yaml(data: Dict[str, Any]) -> Dict[str, Any]:
    """Lift older Zoo gantry YAMLs into CubOS staging's gantry schema.

    Zoo still validates through CubOS after this compatibility pass. The pass
    is intentionally narrow: it removes the retired homing strategy and fills
    fields that CubOS now requires so operators can save a corrected file.
    """
    normalized = copy.deepcopy(data)
    normalized.setdefault("gantry_type", "cub")
    working_volume = dict(normalized.get("working_volume") or {})
    z_max = _float_or(working_volume.get("z_max"), 80.0)
    if z_max <= 0:
        z_max = 80.0

    cnc = dict(normalized.get("cnc") or {})
    cnc["homing_strategy"] = "standard"
    if cnc.get("y_axis_motion") not in {"head", "bed"}:
        cnc["y_axis_motion"] = "head"

    total_z_range = max(
        _float_or(
            cnc.get("total_z_range", cnc.get("total_z_height")),
            z_max,
        ),
        z_max,
    )
    if cnc.get("safe_z") is None and cnc.get("structure_clearance_z") is not None:
        cnc["safe_z"] = cnc["structure_clearance_z"]
    if cnc.get("safe_z") is not None:
        safe_z = _float_or(cnc.get("safe_z"), z_max)
        cnc["safe_z"] = max(
            _float_or(working_volume.get("z_min"), 0.0),
            min(safe_z, z_max),
        )
    cnc["total_z_range"] = total_z_range
    cnc.pop("total_z_height", None)
    cnc.pop("structure_clearance_z", None)

    normalized["cnc"] = cnc
    normalized["working_volume"] = working_volume
    normalized.setdefault("grbl_settings", {})
    if not isinstance(normalized.get("instruments"), dict):
        normalized["instruments"] = {}
    else:
        normalized.setdefault("instruments", {})
        for instrument in normalized["instruments"].values():
            if isinstance(instrument, dict):
                instrument.pop("measurement_height", None)
                instrument.pop("safe_approach_height", None)
    return normalized


def _validated_gantry_config(data: Dict[str, Any]) -> GantryYamlSchema:
    return GantryYamlSchema.model_validate(_normalize_gantry_yaml(data))


def _api_gantry_config(config: GantryYamlSchema) -> Dict[str, Any]:
    """Return the stable Zoo API shape while CubOS owns schema validation."""
    data = config.model_dump(mode="json", exclude_none=True)
    cnc = dict(data.get("cnc") or {})
    total_z_range = cnc.pop("total_z_range", None)
    safe_z = cnc.pop("safe_z", None)
    if total_z_range is not None:
        cnc["total_z_height"] = total_z_range
    if safe_z is not None:
        cnc["structure_clearance_z"] = safe_z
    elif total_z_range is not None:
        cnc["structure_clearance_z"] = total_z_range
    data["cnc"] = cnc
    data.pop("gantry_type", None)
    return data


def _runtime_connect_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Return a Gantry config that will not block connect on calibration drift."""
    runtime_config = copy.deepcopy(config)
    runtime_config.pop("grbl_settings", None)
    return runtime_config


def _calibration_mismatch_warning(
    gantry: Gantry,
    config: Dict[str, Any],
) -> Optional[str]:
    expected = normalize_expected_grbl_settings(config.get("grbl_settings"))
    if not expected:
        return None

    try:
        live = gantry.read_grbl_settings()
    except Exception as exc:
        return (
            "Calibration status unknown: connected, but Zoo could not read "
            f"controller GRBL settings after connect ({exc}). Run calibration "
            "again before trusting coordinates or running protocols."
        )

    mismatches = []
    for code, expected_value in expected.items():
        live_raw = live.get(code)
        if live_raw is None:
            mismatches.append(f"{code}: expected {expected_value:g}, got missing")
            continue
        try:
            live_value = float(live_raw)
        except (TypeError, ValueError):
            mismatches.append(f"{code}: expected {expected_value:g}, got {live_raw}")
            continue
        if abs(live_value - float(expected_value)) > 0.001:
            mismatches.append(f"{code}: expected {expected_value:g}, got {live_value:g}")

    if not mismatches:
        return None
    return (
        "Calibration needed: connected, but controller GRBL settings differ "
        "from the selected gantry YAML. Run calibration again before trusting "
        "coordinates or running protocols. "
        + "; ".join(mismatches)
    )


@router.get("/configs")
def list_gantry_configs() -> list[str]:
    return list_configs(get_settings().configs_dir, "gantry")


@router.get("/instrument-types")
def list_instrument_types() -> List[InstrumentTypeInfo]:
    return [
        InstrumentTypeInfo(
            type=key,
            vendors=get_supported_vendors(key),
            is_mock=key.startswith("mock_"),
        )
        for key in get_supported_types()
    ]


@router.get("/pipette-models")
def list_pipette_models() -> List[PipetteModelInfo]:
    return [
        PipetteModelInfo(
            name=cfg.name,
            family=cfg.family.value,
            channels=cfg.channels,
            max_volume=cfg.max_volume,
            min_volume=cfg.min_volume,
        )
        for cfg in PIPETTE_MODELS.values()
    ]


@router.get("/instrument-schemas")
def get_instrument_schemas() -> Dict[str, List[InstrumentFieldInfo]]:
    """Return per-type field schemas introspected from CubOS instrument classes."""
    return {
        type_key: _build_instrument_fields(type_key)
        for type_key in get_supported_types()
    }


@router.get("/position")
def get_position() -> GantryPosition:
    global _last_position
    if _gantry is None:
        return GantryPosition(connected=False, status="Not connected")
    acquired = _serial_lock.acquire(blocking=False)
    if not acquired:
        # Lock is busy (move or jog in progress). Read cached status from the
        # driver — it updates last_status during wait_for_completion, so the
        # status word stays fresh even while the lock is held.
        status = _gantry._extract_status()
        if _last_position is not None:
            return GantryPosition(
                x=_last_position.x,
                y=_last_position.y,
                z=_last_position.z,
                work_x=_last_position.work_x,
                work_y=_last_position.work_y,
                work_z=_last_position.work_z,
                status=status,
                connected=True,
                calibration_warning=_calibration_warning,
            )
        return GantryPosition(
            connected=True,
            status=status,
            calibration_warning=_calibration_warning,
        )
    try:
        info = _gantry.get_position_info()
        coords = info["coords"]
        wpos = info["work_pos"]
        _last_position = GantryPosition(
            x=coords["x"],
            y=coords["y"],
            z=coords["z"],
            work_x=wpos["x"] if wpos else None,
            work_y=wpos["y"] if wpos else None,
            work_z=wpos["z"] if wpos else None,
            status=info["status"],
            connected=True,
            calibration_warning=_calibration_warning,
        )
        return _last_position
    except Exception:
        if _last_position is not None:
            return _last_position
        return GantryPosition(connected=True, status="Query failed")
    finally:
        _serial_lock.release()


@router.post("/home")
def home() -> GantryPosition:
    """Home the gantry using the strategy from the loaded config.

    Dispatch lives in ``cubos.Gantry.home()``, which reads
    ``config['cnc']['homing_strategy']`` and routes through CubOS's
    current standard homing behavior.
    """
    if _gantry is None:
        raise HTTPException(400, "Gantry not connected")
    with _serial_lock:
        try:
            _gantry.home()
        except Exception as e:
            raise HTTPException(500, f"Homing failed: {e}")
    return get_position()


class JogRequest(BaseModel):
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0


@router.post("/jog")
def jog(req: JogRequest) -> dict:
    """Jog the gantry by a relative offset using GRBL's $J= command."""
    if _gantry is None:
        raise HTTPException(400, "Gantry not connected")
    if req.x == 0 and req.y == 0 and req.z == 0:
        return {"status": "ok"}
    with _serial_lock:
        try:
            _gantry.jog(x=req.x, y=req.y, z=req.z)
        except Exception as e:
            logging.warning("Jog error (non-fatal): %s", e)
    return {"status": "ok"}


class MoveToRequest(BaseModel):
    x: float
    y: float
    z: float


_move_error: Optional[str] = None


def _move_worker(x: float, y: float, z: float) -> None:
    """Run move_to in a background thread so position polls can interleave."""
    global _move_error
    _move_error = None
    try:
        with _serial_lock:
            _gantry.move_to(x=x, y=y, z=z)
    except Exception as e:
        _move_error = str(e)
        logging.error("Move failed: %s", e)


@router.post("/move-to")
def move_to(req: MoveToRequest) -> dict:
    """Move the gantry to absolute coordinates using safe_move."""
    if _gantry is None:
        raise HTTPException(400, "Gantry not connected")
    thread = threading.Thread(target=_move_worker, args=(req.x, req.y, req.z), daemon=True)
    thread.start()
    return {"status": "ok"}


@router.post("/unlock")
def unlock() -> GantryPosition:
    """Send GRBL $X unlock command to clear alarm state."""
    if _gantry is None:
        raise HTTPException(400, "Gantry not connected")
    with _serial_lock:
        try:
            _gantry.unlock()
        except Exception as e:
            raise HTTPException(500, f"Unlock failed: {e}")
    return get_position()


class ConnectRequest(BaseModel):
    filename: Optional[str] = None


@router.post("/connect")
def connect(body: Optional[ConnectRequest] = None) -> GantryPosition:
    """Open the serial connection and verify the mill is responding.

    Holds ``_serial_lock`` for the entire connect sequence — the Mill's
    auto-detect, GRBL verification, WPos-mode enforcement, and WCO seeding
    all chatter on the serial port. The frontend polls ``/position`` every
    200 ms, and until we're holding the lock, every one of those polls
    will race us for GRBL's response bytes. Seen in the wild: a concurrent
    ``?`` from the poll consumed the response to our ``G90``, causing
    ``_enforce_wpos_mode`` to fail, which snowballed into
    ``current_coordinates`` timing out, which tripped the outer
    ``except``, which nulled ``_gantry`` — UI shows "Not connected"
    immediately after a user click-Home race.

    Also defers the module-level ``_gantry`` assignment until connect has
    fully succeeded, so position polls see ``None`` (and return a clean
    "Not connected") during the connect window instead of trying to touch
    a half-initialized mill.
    """
    global _gantry, _calibration_warning
    with _serial_lock:
        try:
            settings = get_settings()
            config = {}
            if body and body.filename:
                path = resolve_config_path(settings.configs_dir, "gantry", body.filename)
                if not path.is_file():
                    raise HTTPException(404, f"Config not found: {body.filename}")
                config = _validated_gantry_config(read_yaml(path)).model_dump(
                    mode="json",
                    exclude_none=True,
                )
            else:
                gantry_configs = list_configs(settings.configs_dir, "gantry")
                if gantry_configs:
                    path = resolve_config_path(settings.configs_dir, "gantry", gantry_configs[0])
                    config = _validated_gantry_config(read_yaml(path)).model_dump(
                        mode="json",
                        exclude_none=True,
                    )
            # Stage the Gantry locally; publish to the module global only on
            # success so /position sees _gantry=None until we're ready, and
            # so a transient failure on reconnect doesn't clobber a prior
            # working connection.
            staged = Gantry(config=_runtime_connect_config(config))
            staged.connect()
            calibration_warning = _calibration_mismatch_warning(staged, config)
            # Seed WCO cache — GRBL sends WCO in one of the first few status reports.
            for _ in range(10):
                info = staged.get_position_info()
                if info["work_pos"] is not None:
                    break
                time.sleep(0.1)
        except Exception as e:
            raise HTTPException(500, f"Failed to connect: {e}")
        _gantry = staged
        _calibration_warning = calibration_warning
    # get_position() acquires _serial_lock itself; call it outside the
    # `with` block so we don't try to re-acquire a non-reentrant lock,
    # which would fall through to the cached path and return a degraded
    # response (no coords) on the very first post-connect frame.
    return get_position()


@router.post("/disconnect")
def disconnect() -> GantryPosition:
    global _gantry, _calibration_warning
    if _gantry is None:
        return GantryPosition(connected=False, status="Disconnected")
    # Clear the module global inside the lock so concurrent /position
    # polls don't see _gantry set to a mill object that's mid-disconnect.
    with _serial_lock:
        try:
            _gantry.disconnect()
        finally:
            _gantry = None
            _calibration_warning = None
    return GantryPosition(connected=False, status="Disconnected")


@router.get("/{filename}")
def get_gantry(filename: str) -> GantryResponse:
    path = resolve_config_path(get_settings().configs_dir, "gantry", filename)
    if not path.is_file():
        raise HTTPException(404, f"Config not found: {filename}")
    data = read_yaml(path)
    config = _validated_gantry_config(data)
    return GantryResponse(filename=filename, config=_api_gantry_config(config))


@router.put("/{filename}")
def put_gantry(filename: str, body: dict) -> GantryResponse:
    path = resolve_config_path(get_settings().configs_dir, "gantry", filename)
    config = _validated_gantry_config(body)
    write_yaml(path, config.model_dump(mode="json", exclude_none=True))
    return get_gantry(filename)
