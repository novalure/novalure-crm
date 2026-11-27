#!/usr/bin/env bash
# Experimental: run in an isolated clean directory. Emscripten SDK 4.0.23 required.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
emcc --version | grep -q ' 4\.0\.23 ' || { echo 'Expected Emscripten 4.0.23' >&2; exit 1; }
ARCHIVE="$ROOT/sources/wasm-libheif-1.23.7-1.tgz"
if [[ ! -f "$ARCHIVE" ]]; then
  npm pack --silent @ai-ecoverse/wasm-libheif@1.23.7-1
  ARCHIVE="$ROOT/ai-ecoverse-wasm-libheif-1.23.7-1.tgz"
fi
printf '%s  %s\n' 281a3d13d6589ee85a3e0f66928da79874dc31e5b3a912a8533925833bbff307 "$ARCHIVE" | sha256sum -c -
mkdir -p vendor && tar -xzf "$ARCHIVE" -C vendor
cd vendor/package/share/libheif/relink
read -r -a FLAGS <ldflags.txt
em++ -O2 -fexceptions -I../../../include "$ROOT/primary.cpp" \
  ../../../lib/libheif.a ../../../lib/libde265.a ../../../lib/libdav1d.a \
  libpng16.a libjpeg.a libz.a "${FLAGS[@]}" \
  -sMAXIMUM_MEMORY=536870912 -sMODULARIZE=1 -sEXPORT_NAME=createPrimaryDecoder \
  -sDYNAMIC_EXECUTION=0 -o "$ROOT/primary.js"
sha256sum "$ROOT/primary.js" "$ROOT/primary.wasm"
