# Upstream Zoo Sync

`zoo-tauri` keeps Zoo's core code by merging from `Ursa-Laboratories/Zoo`.

The workflow `.github/workflows/sync-zoo-upstream.yml` runs hourly, can be run manually, and also accepts a `repository_dispatch` event named `zoo-updated`.

On a clean upstream merge it:

1. Creates or updates `sync/zoo-main`.
2. Runs backend tests, frontend lint, frontend tests, and frontend build.
3. Opens or updates a PR into `main`.

If the upstream merge conflicts, it opens or comments on a `Zoo upstream sync conflict` issue. Resolve conflicts manually and keep Tauri-specific behavior in place:

- The desktop shell remains responsible only for starting and stopping the Python sidecar.
- CubOS/Zoo still owns validation, schemas, protocols, and hardware behavior.
- Tauri frontend requests must still target the local sidecar API in packaged desktop builds.

To trigger immediately from the Zoo repository, add a Zoo-side workflow that sends a repository dispatch event to `Ursa-Laboratories/zoo-tauri` after pushes to Zoo `main`. That workflow needs a secret token with permission to dispatch events to `zoo-tauri`.

```yaml
name: Notify zoo-tauri

on:
  push:
    branches: [main]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch zoo-tauri sync
        env:
          TOKEN: ${{ secrets.ZOO_TAURI_DISPATCH_TOKEN }}
        run: |
          curl -fsSL \
            -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "Authorization: Bearer $TOKEN" \
            https://api.github.com/repos/Ursa-Laboratories/zoo-tauri/dispatches \
            -d '{"event_type":"zoo-updated"}'
```
