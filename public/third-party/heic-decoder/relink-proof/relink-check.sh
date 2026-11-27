#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
test -f package/lib/libheif.a; test -f primary.cpp
em++ --version | grep -q ' 4\.0\.23 ' || { echo 'Emscripten 4.0.23 required' >&2; exit 1; }
cp package/lib/libheif.a libheif-modified.a
emcc -O2 -c marker.c -o marker.o
emar r libheif-modified.a marker.o
cmp -s package/lib/libheif.a libheif-modified.a && { echo 'Archive not modified' >&2; exit 1; }
sha256sum primary.cpp package/lib/libheif.a libheif-modified.a marker.c
cd package/share/libheif/relink
read -r -a FLAGS <ldflags.txt
# Test baseline: original archive and original flags.
em++ -O2 -fexceptions -I../../../include "$ROOT/primary.cpp" ../../../lib/libheif.a ../../../lib/libde265.a ../../../lib/libdav1d.a libpng16.a libjpeg.a libz.a "${FLAGS[@]}" -sMAXIMUM_MEMORY=536870912 -sMODULARIZE=1 -sEXPORT_NAME=createPrimaryDecoder -sDYNAMIC_EXECUTION=0 -o "$ROOT/base.js"
# Relink against modified copy; added export roots test-only marker.
em++ -O2 -fexceptions -I../../../include "$ROOT/primary.cpp" "$ROOT/libheif-modified.a" ../../../lib/libde265.a ../../../lib/libdav1d.a libpng16.a libjpeg.a libz.a "${FLAGS[@]}" -sMAXIMUM_MEMORY=536870912 -sMODULARIZE=1 -sEXPORT_NAME=createPrimaryDecoder -sDYNAMIC_EXECUTION=0 "-sEXPORTED_FUNCTIONS=['_main','_novalure_lgpl_relink_marker']" -o "$ROOT/modified.js"
cd "$ROOT"; sha256sum base.js base.wasm modified.js modified.wasm
if cmp -s base.wasm modified.wasm; then echo 'Modified output unexpectedly identical' >&2; exit 1; fi
echo 'RELINK_BUILD_PASS'
