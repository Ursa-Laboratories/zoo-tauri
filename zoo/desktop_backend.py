"""Desktop backend entry point for the Tauri sidecar."""

import uvicorn

from zoo.config import ZooSettings


def main() -> None:
    settings = ZooSettings(open_browser=False)
    uvicorn.run(
        "zoo.app:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    main()
