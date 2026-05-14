# Zoo Repo Overview

## Purpose

`Zoo` is a local web UI for `CubOS`. It edits YAML configs, visualizes deck state, controls gantry motion, and triggers protocol execution through CubOS APIs and classes.

## Key Directories

| Path | Purpose |
| --- | --- |
| `zoo/app.py` | FastAPI app factory |
| `zoo/__main__.py` | Startup entrypoint |
| `zoo/config.py` | `ZOO_*` settings and config-directory handling |
| `zoo/routers/` | REST endpoints for gantry, deck, protocol, raw, settings |
| `zoo/services/` | YAML file helpers |
| `frontend/src/` | React + TypeScript application |
| `src-tauri/` | Tauri desktop shell that starts the Zoo backend sidecar |
| `scripts/package_backend.py` | PyInstaller helper for creating the Tauri sidecar binary |
| `configs/` | Default local config store, empty by default in this checkout |
| `tests/` | Backend tests |

## Main Entrypoints

- `python -m zoo`
- `python -m zoo.desktop_backend`
- `uvicorn zoo.app:create_app --factory`
- `cd frontend && npm run dev`
- `npm run tauri:dev`

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

Desktop:

```bash
npm run tauri:dev
npm run tauri:build:mac
npm run tauri:build:windows
```

The macOS desktop build emits `src-tauri/target/release/bundle/macos/Zoo.app` and a compressed DMG in `src-tauri/target/release/bundle/dmg/`. The Windows build must run on Windows and emits an NSIS setup executable in `src-tauri/target/release/bundle/nsis/`.

## Lint And Format

- Frontend lint command exists: `npm run lint`
- No backend formatter or linter configuration was confirmed in the first pass

## Deployment Or Release Role

- Local operator-facing UI
- Downloadable desktop app through Tauri
- Depends on the published or installable `CubOS` package

## Dependencies On Other Repos Or Services

- Depends on `CubOS` from Git in `pyproject.toml`
- Requires Node.js for frontend development and build
- Requires Rust/Cargo and PyInstaller for desktop packaging
- Talks directly to local gantry hardware through CubOS when operators use motion endpoints

## Known Pitfalls

- The repo currently has an empty default `configs/` directory; first-time users need to populate or redirect it.
- `python -m zoo` may build the frontend automatically if `frontend/dist/` is absent.
- The shared gantry instance is process-local and serial access is deliberately locked.
- `raw` endpoints bypass schema-aware editing and can write malformed YAML if used carelessly.
- The checked-in frontend README is a template and not authoritative project documentation.
- CubOS staging no longer uses a separate mounted-instrument config in Zoo; instruments belong in gantry YAML.
- The Tauri shell deliberately keeps hardware and protocol behavior inside the Python Zoo backend sidecar.
