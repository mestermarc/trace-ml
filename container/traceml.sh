#!/usr/bin/env bash
# Helper for the TraceML Podman dev container (run from Linux / WSL, anywhere in the repo).
#
#   container/traceml.sh build        # build the image
#   container/traceml.sh shell        # interactive bash in the container
#   container/traceml.sh install      # npm ci inside the container
#   container/traceml.sh check        # typecheck + tests + build
#   container/traceml.sh test         # tests only
#   container/traceml.sh fake-runs --runs 100 --clean
#   container/traceml.sh run <any command...>
set -euo pipefail

IMAGE=traceml-dev
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD="${1:-shell}"
[ $# -gt 0 ] && shift

command -v podman >/dev/null || { echo "podman not found (Debian/Ubuntu: sudo apt install podman)" >&2; exit 1; }

if [ "$CMD" = build ]; then
  exec podman build -t "$IMAGE" -f "$REPO/container/Containerfile" "$@" "$REPO"
fi

# In-container paths come from the image (WORKSPACE / UV_CACHE_DIR in the Containerfile).
image_env() {
  podman image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE" 2>/dev/null | sed -n "s/^$1=//p" | head -n1
}
WORKDIR="$(image_env WORKSPACE)"
UV_CACHE="$(image_env UV_CACHE_DIR)"
if [ -z "$WORKDIR" ] || [ -z "$UV_CACHE" ]; then
  echo "Image '$IMAGE' not found or outdated. Run: container/traceml.sh build" >&2
  exit 1
fi

# The checkout is bind-mounted; node_modules and the uv cache live in named volumes, so the
# container's platform-specific binaries (esbuild, vitest) never mix with the host's.
# keep-id maps your host user to the image user (USER_UID / USER_GID, 1000 by default).
TTY=()
[ -t 0 ] && [ -t 1 ] && TTY=(-it)
RUN=(podman run --rm "${TTY[@]}"
  --userns=keep-id:uid=1000,gid=1000
  -v "$REPO:$WORKDIR"
  -v "traceml-node-modules:$WORKDIR/node_modules"
  -v "traceml-uv-cache:$UV_CACHE"
  -w "$WORKDIR"
  "$IMAGE")

case "$CMD" in
  shell)     exec "${RUN[@]}" bash -l ;;
  install)   exec "${RUN[@]}" npm ci ;;
  check)     exec "${RUN[@]}" npm run check ;;
  test)      exec "${RUN[@]}" npm test ;;
  fake-runs) exec "${RUN[@]}" uv run --no-project scripts/fake_runs.py "$@" ;;
  run)       exec "${RUN[@]}" "$@" ;;
  *) echo "Unknown command '$CMD'. Use: build | shell | install | check | test | fake-runs | run" >&2; exit 1 ;;
esac
