"""Deck config API endpoints — thin layer over CubOS deck loader."""

from copy import deepcopy
import logging
from typing import Any, Dict, Optional

from deck import load_deck_from_yaml
from deck.labware.well_plate import WellPlate
from deck.loader import _derive_wells_from_calibration
from deck.yaml_schema import WellPlateYamlEntry
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ValidationError

from zoo.config import get_settings
from zoo.services.yaml_io import list_configs, read_yaml, resolve_config_path, write_yaml

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/deck", tags=["deck"])


# ── Response models (API shape only, no validation duplication) ────────


class WellPosition(BaseModel):
    x: float
    y: float
    z: float


class LabwareResponse(BaseModel):
    key: str
    config: Dict[str, Any]
    wells: Optional[Dict[str, WellPosition]] = None
    location: Optional[WellPosition] = None
    geometry: Optional[Dict[str, Optional[float]]] = None
    positions: Optional[Dict[str, WellPosition]] = None


class DeckResponse(BaseModel):
    filename: str
    labware: list[LabwareResponse]


# ── Routes ─────────────────────────────────────────────────────────────


@router.get("/configs")
def list_deck_configs() -> list[str]:
    return list_configs(get_settings().configs_dir, "deck")


@router.get("/{filename}")
def get_deck(filename: str) -> DeckResponse:
    path = resolve_config_path(get_settings().configs_dir, "deck", filename)
    if not path.is_file():
        raise HTTPException(404, f"Config not found: {filename}")

    # Use CubOS's loader for validation + well derivation.
    try:
        deck = load_deck_from_yaml(path)
    except (ValueError, ValidationError) as e:
        raise HTTPException(400, str(e))

    raw = read_yaml(path)
    items: list[LabwareResponse] = []
    for key, labware in deck.labware.items():
        config = _normalize_labware_config(raw.get("labware", {}).get(key, {}), labware, key)
        if hasattr(labware, "iter_positions"):
            positions = _serialize_positions(labware.iter_positions())
        else:
            log.warning("Labware %s (%s) has no iter_positions — positions will be empty", key, type(labware).__name__)
            positions = {}
        wells = positions if isinstance(labware, WellPlate) else None
        if hasattr(labware, "get_initial_position"):
            location = _serialize_point(labware.get_initial_position())
        else:
            location = None
        items.append(
            LabwareResponse(
                key=key,
                config=config,
                wells=wells,
                location=location,
                geometry=_serialize_geometry(getattr(labware, "geometry", None)),
                positions={name: point for name, point in positions.items() if name != "location"} or None,
            )
        )

    return DeckResponse(filename=filename, labware=items)


@router.post("/preview-wells")
def preview_wells(body: dict) -> Dict[str, WellPosition]:
    """Compute well positions from a well plate config using CubOS's
    calibration logic, without requiring the config to be saved first."""
    try:
        entry = WellPlateYamlEntry.model_validate(body)
        resolved_z = entry.a1_point.z
        if resolved_z is None:
            raise ValueError("Calibration A1 must include z for preview.")
        wells = _derive_wells_from_calibration(entry, resolved_z=resolved_z)
        return {
            wid: WellPosition(x=round(c.x, 3), y=round(c.y, 3), z=round(c.z, 3))
            for wid, c in wells.items()
        }
    except (ValueError, ValidationError) as e:
        raise HTTPException(400, str(e))


@router.put("/{filename}")
def put_deck(filename: str, body: dict) -> DeckResponse:
    path = resolve_config_path(get_settings().configs_dir, "deck", filename)
    write_yaml(path, body)
    return get_deck(filename)


def _serialize_point(point: Any) -> Optional[WellPosition]:
    if point is None:
        return None
    return WellPosition(x=point.x, y=point.y, z=point.z)


def _serialize_positions(positions: Dict[str, Any]) -> Dict[str, WellPosition]:
    return {
        name: WellPosition(x=coord.x, y=coord.y, z=coord.z)
        for name, coord in positions.items()
        if coord is not None
    }


def _serialize_geometry(geometry: Any) -> Optional[Dict[str, Optional[float]]]:
    if geometry is None:
        return None
    return {
        "length_mm": _geometry_dimension(geometry, "length", "length_mm"),
        "width_mm": _geometry_dimension(geometry, "width", "width_mm"),
        "height_mm": _geometry_dimension(geometry, "height", "height_mm"),
    }


def _geometry_dimension(geometry: Any, current_name: str, legacy_name: str) -> Optional[float]:
    value = getattr(geometry, current_name, None)
    if value is not None:
        return value
    return getattr(geometry, legacy_name, None)


_LABWARE_TYPE_MAP: Dict[str, str] = {
    "WellPlate": "well_plate",
    "Vial": "vial",
    "TipRack": "tip_rack",
    "WellPlateHolder": "well_plate_holder",
    "VialHolder": "vial_holder",
    "TipDisposal": "tip_disposal",
}


def _normalize_labware_config(raw_config: Any, labware: Any, deck_key: str) -> Dict[str, Any]:
    if not isinstance(raw_config, dict):
        log.warning("Labware %s has non-dict raw config (%r) — using empty config", deck_key, type(raw_config).__name__)
        config: Dict[str, Any] = {}
    else:
        config = deepcopy(raw_config)

    inferred_type = config.get("type") or _infer_labware_type(labware, deck_key)
    if inferred_type:
        config["type"] = inferred_type

    if "name" not in config and hasattr(labware, "name"):
        config["name"] = getattr(labware, "name")
    if "model_name" not in config and hasattr(labware, "model_name"):
        config["model_name"] = getattr(labware, "model_name")
    if "name" not in config:
        config["name"] = deck_key

    return config


def _infer_labware_type(labware: Any, deck_key: str) -> Optional[str]:
    class_name = labware.__class__.__name__
    labware_type = _LABWARE_TYPE_MAP.get(class_name)
    if labware_type is None:
        log.warning("Unknown labware class %r for key %s — type will not be inferred", class_name, deck_key)
    return labware_type
