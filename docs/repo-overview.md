# Zoo Repo Overview

## Purpose

`Zoo` is a local web UI for `CubOS`. It edits YAML configs, visualizes deck state, controls gantry motion, and triggers protocol execution through CubOS APIs and classes.

The gantry control surface also exposes a calibration wizard that turns CubOS'
`setup/calibrate_gantry.py` flow into a guided UI. Operators still use CubOS
movement semantics through Zoo jog/home/connect endpoints; the wizard saves the
calibrated YAML through the same schema-validated gantry config path.
The wizard is intentionally serial: after the operator selects the reference
and lowest instrument, Zoo runs the blocking controller-prep/home steps, locks
controls during automatic home/center/retract moves, and only exposes the next
operator action when the current step completes.

## Key Directories

| Path | Purpose |
| --- | --- |
| `zoo/app.py` | FastAPI app factory |
| `zoo/__main__.py` | Startup entrypoint |
| `zoo/config.py` | `ZOO_*` settings and config-directory handling |
| `zoo/routers/` | REST endpoints for gantry, deck, protocol, raw, settings |
| `zoo/services/` | YAML file helpers |
| `frontend/src/` | React + TypeScript application |
| `frontend/src/components/gantry/` | Gantry jog/readout controls and calibration wizard |
| `configs/` | Default local config store, empty by default in this checkout |
| `tests/` | Backend tests |

## Main Entrypoints

- `python -m zoo`
- `uvicorn zoo.app:create_app --factory`
- `cd frontend && npm run dev`

## How To Run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cd frontend
npm ci
cd ..
python -m zoo
```

## How To Test

Backend:

```bash
pytest tests/
```

Frontend:

```bash
cd frontend
npm run lint
npm run test
npm run build
```

## Lint And Format

- Frontend lint command exists: `npm run lint`
- No backend formatter or linter configuration was confirmed in the first pass

## Deployment Or Release Role

- Local operator-facing UI
- Depends on the published or installable `CubOS` package

## Dependencies On Other Repos Or Services

- Depends on `CubOS` from Git in `pyproject.toml`
- Requires Node.js for frontend development and build
- Talks directly to local gantry hardware through CubOS when operators use motion endpoints
- Gantry calibration delegates work-coordinate and soft-limit operations to CubOS `Gantry` methods; Zoo only sequences the operator UI and YAML save. During XY origining, Zoo may temporarily disable stale soft limits and restores them on cancel, single-instrument XY completion, disconnect, or successful soft-limit programming.

## Known Pitfalls

- The repo currently has an empty default `configs/` directory; first-time users need to populate or redirect it.
- `python -m zoo` may build the frontend automatically if `frontend/dist/` is absent.
- The shared gantry instance is process-local and serial access is deliberately locked.
- `raw` endpoints bypass schema-aware editing and can write malformed YAML if used carelessly.
- The checked-in frontend README is a template and not authoritative project documentation.
- CubOS staging no longer uses a separate mounted-instrument config in Zoo; instruments belong in gantry YAML.
- Calibration can write a new gantry YAML and optionally program live GRBL soft-limit settings, so it should not be exercised without hardware clearance and an E-stop within reach.
