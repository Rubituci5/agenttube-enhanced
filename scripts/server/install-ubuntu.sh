#!/usr/bin/env bash
# Ubuntu 24.04: install native Node/Python/FFmpeg runtime for AgentTube.
# Does not connect YouTube or activate the scheduler.
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
MODELS="$ROOT/data/models/kokoro"
VENV="$MODELS/venv"
if [[ "$(uname -s)" != Linux ]]; then echo 'Ubuntu Linux only' >&2; exit 2; fi
if [[ "$EUID" == 0 ]]; then echo 'Run as the dedicated agenttube user, not root' >&2; exit 2; fi
for bin in node npm python3 ffmpeg ffprobe espeak-ng curl g++; do
  command -v "$bin" >/dev/null || { echo "Missing $bin. Install Node.js 22, python3-venv, ffmpeg, espeak-ng, libsndfile1, curl and build-essential first." >&2; exit 2; }
done
node -e 'if (+process.versions.node.split(".")[0]<20) process.exit(1)' || { echo "Node.js 20+ required" >&2; exit 2; }
mkdir -p "$MODELS" data/videos data/music/cc0 data/audio data/stock uploads/thumbnails logs temp/processing config
npm ci --omit=dev --no-audit --no-fund
python3 -m venv "$VENV"
"$VENV/bin/python" -m pip install --no-input --disable-pip-version-check --upgrade pip
"$VENV/bin/python" -m pip install --no-input --disable-pip-version-check 'kokoro-onnx==0.6.1' 'misaki-fork==0.9.6' 'soundfile==0.14.0' 'numpy>=2,<3'
download_once(){
 local url="$1" target="$2" min="$3"
 if [[ -f "$target" && "$(wc -c < "$target")" -ge "$min" ]]; then
   echo "Existing $(basename "$target")"; return
 fi
 local temp="$target.part"
 curl --fail --location --retry 3 --connect-timeout 20 --max-time 360 --output "$temp" "$url"
 [[ "$(wc -c < "$temp")" -ge "$min" ]] || { echo "Incomplete download: $target" >&2; rm -f "$temp"; exit 1; }
 mv "$temp" "$target"
}
download_once 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.fp16.onnx' "$MODELS/kokoro-v1.0.fp16.onnx" 100000000
download_once 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin' "$MODELS/voices-v1.0.bin" 10000000
"$VENV/bin/python" - <<'PY'
from kokoro_onnx import Kokoro
from misaki.espeak import EspeakG2P
EspeakG2P(language='pt-br')
print('Kokoro pt-BR and espeak-ng loaded. No external TTS services required.')
PY
echo 'Linux runtime ready. Schedule remains disabled until manually approved.'
echo 'Next: secure credentials/SQLite/media migration + preflight + HTTPS auth.'
