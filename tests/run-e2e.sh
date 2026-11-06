#!/usr/bin/env bash
# Usage: HERMES_AGENT_DIR=/path/to/hermes-agent tests/run-e2e.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export HERMES_AGENT_DIR="${HERMES_AGENT_DIR:-/usr/local/lib/hermes-agent}"
FX="$HERE/fixtures"; mkdir -p "$FX"
[ -f "$FX/mountains.png" ] || ffmpeg -loglevel error -y -f lavfi -i "mandelbrot=s=1920x1080" -frames:v 1 "$FX/mountains.png"
[ -f "$FX/clip.mp4" ] || ffmpeg -loglevel error -y -f lavfi -i "testsrc2=s=1280x720:r=30" -t 4 -pix_fmt yuv420p -c:v libx264 "$FX/clip.mp4"
[ -f "$FX/life.webm" ] || ffmpeg -loglevel error -y -f lavfi -i "life=s=640x360:mold=10:r=25:ratio=0.1" -t 3 -c:v libvpx-vp9 -b:v 500k "$FX/life.webm"
cd "$HERMES_AGENT_DIR"
xvfb-run -a -s "-screen 0 1600x1000x24" node --import "$HERE/resolve-hook.mjs" --experimental-strip-types "$HERE/e2e-desktop.mts"
