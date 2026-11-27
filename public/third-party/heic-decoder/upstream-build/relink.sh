#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$(cd "$HERE/../../../lib" && pwd)"
OUT="${1:?usage: relink.sh <out-dir> [libheif.a] [libde265.a] [libdav1d.a]}"
HEIF_A="${2:-$LIB/libheif.a}"
DE265_A="${3:-$LIB/libde265.a}"
DAV1D_A="${4:-$LIB/libdav1d.a}"
mkdir -p "$OUT"
cd "$HERE"
read -r -a FLAGS <ldflags.txt
for t in heif-dec heif-info; do
  em++ -O2 -fexceptions -o "$OUT/$t.js" \
    -Wl,--whole-archive "$HERE/$t.a" -Wl,--no-whole-archive \
    "$HERE/libheifio.a" "$HEIF_A" "$DE265_A" "$DAV1D_A" \
    "$HERE/libpng16.a" "$HERE/libjpeg.a" "$HERE/libz.a" \
    "${FLAGS[@]}"
  mv "$OUT/$t.js" "$OUT/$t"
done
echo "relinked: $OUT/heif-dec(.wasm) $OUT/heif-info(.wasm)"
