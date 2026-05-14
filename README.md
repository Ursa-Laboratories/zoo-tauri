# Zoo

`Zoo` is the local web UI for `CubOS`. It edits YAML configs, visualizes deck state, controls gantry motion, and triggers protocol execution through CubOS.

See also:

- `docs/repo-overview.md`
- `../docs/architecture/system-overview.md`
- `../docs/reference/api-contracts.md`

## Dependency Model

- Zoo imports `CubOS` as an installed package.
- Zoo should stay a thin layer over CubOS loaders, schemas, registries, and motion logic.
- The checked-in dependency currently points at a Git branch in `pyproject.toml`. Confirm branch strategy before changing it.
- Zoo uses CubOS' current three-config runtime surface: gantry, deck, and protocol. Mounted instruments are edited and saved inside gantry YAML.

## Local Config Storage

- Zoo reads and writes YAML configs from `configs/` by default.
- The active directory is exposed through `/api/settings` as `config_dir`.
- Operators can point Zoo at another config directory through the settings UI or API.
- Gantry YAMLs are read back through CubOS validation before Zoo returns or saves them; missing current fields must be filled and saved in the gantry editor.

## Run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cd frontend
npm ci
cd ..
python -m zoo
```

## Desktop App

This Tauri copy packages the existing React UI with the same Zoo FastAPI backend as a sidecar. The backend still owns CubOS validation, YAML loading, gantry access, and protocol execution; the desktop shell only starts and stops that process.

Prerequisites:

- Rust/Cargo for Tauri builds
- Node.js/npm for the frontend
- uv for reproducible Python build commands
- Python environment with Zoo dependencies installed
- PyInstaller for packaging the Python backend sidecar

Install and run in development:

```bash
npm install
cd frontend
npm ci
cd ..
python -m pip install -e ".[dev]"
npm run tauri:dev
```

Build a downloadable desktop bundle:

```bash
npm run tauri:build:mac
```

The build command creates `src-tauri/target/release/bundle/macos/Zoo.app` and a plain compressed DMG at `src-tauri/target/release/bundle/dmg/Zoo_0.1.0_aarch64.dmg`. The desktop shell starts the backend on `127.0.0.1:8742` with browser auto-open disabled. Desktop config files default to the app data directory so they remain writable after installation.

Build a Windows installer on a Windows runner:

```bash
npm run tauri:build:windows
```

The Windows workflow in `.github/workflows/windows-build.yml` uploads the generated NSIS setup executable as an artifact.

Defaults:

- host: `127.0.0.1`
- port: `8742`
- browser auto-open: enabled

## Test And Build

- Backend tests: `pytest tests/`
- Frontend lint: `cd frontend && npm run lint`
- Frontend tests: `cd frontend && npm run test`
- Frontend build: `cd frontend && npm run build`

## Notes

- If `frontend/dist/` is missing, `python -m zoo` builds it automatically.
- Gantry operations are hardware-touching and should be treated as high risk.
- `frontend/README.md` is still the stock Vite template and is not authoritative documentation.
