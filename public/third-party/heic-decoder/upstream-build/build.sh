#!/usr/bin/env bash
set -euo pipefail
ROOT="${HOMESCOOP_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
source "$ROOT/scripts/build-common.sh"
homescoop_load_recipe libheif

JOBS="${HOMESCOOP_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
STAGE="$WORK/libheif-stage"
PKGDIR="$HOMESCOOP_PKG/package"

homescoop_fetch "$SRC_URL" "$SRC_SHA" "$TARBALL"
if [[ -n "${FORCE:-}" ]]; then rm -rf "$SRC_DIR" "$STAGE" "$WORK/libde265-build" "$WORK/dav1d-build" "$WORK/libheif-build"; fi
homescoop_extract "$TARBALL" "$SRC_DIR"
homescoop_apply_patches "$SRC_DIR"

for h in zlib.h jpeglib.h png.h; do
  test -f "$PREFIX/include/$h" || { echo "missing $h in PREFIX=$PREFIX" >&2; exit 1; }
done
mkdir -p "$STAGE/lib/pkgconfig" "$STAGE/include"

homescoop_load_recipe libheif --source libde265
DE_TB="$WORK/libde265-$LIBDE265_VERSION.tar.gz"
DE_SRC="$WORK/libde265-$LIBDE265_VERSION"
DE_BLD="$WORK/libde265-build"
homescoop_fetch "$LIBDE265_SRC_URL" "$LIBDE265_SRC_SHA" "$DE_TB"
homescoop_extract "$DE_TB" "$DE_SRC"
if [[ ! -f "$STAGE/lib/libde265.a" ]]; then
  echo "== libde265 $LIBDE265_VERSION: emcmake"
  rm -rf "$DE_BLD"
  emcmake cmake -S "$DE_SRC" -B "$DE_BLD" -G "Unix Makefiles" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$STAGE" \
    -DCMAKE_C_FLAGS="-O2" -DCMAKE_CXX_FLAGS="-O2" \
    -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_SDL=OFF -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF \
    -DENABLE_SHERLOCK265=OFF -DENABLE_SIMD=OFF -DENABLE_AVX2=OFF -DENABLE_AVX512=OFF
  emmake make -C "$DE_BLD" -j"$JOBS"
  emmake make -C "$DE_BLD" install
fi
test -f "$STAGE/lib/libde265.a"

homescoop_load_recipe libheif --source dav1d
DAV_TB="$WORK/dav1d-$DAV1D_VERSION.tar.xz"
DAV_SRC="$WORK/dav1d-$DAV1D_VERSION"
DAV_BLD="$WORK/dav1d-build"
homescoop_fetch "$DAV1D_SRC_URL" "$DAV1D_SRC_SHA" "$DAV_TB"
homescoop_extract "$DAV_TB" "$DAV_SRC"
if [[ ! -f "$STAGE/lib/libdav1d.a" ]]; then
  homescoop_load_recipe libheif --source meson
  MESON_TB="$WORK/meson-$MESON_VERSION.tar.gz"
  homescoop_fetch "$MESON_SRC_URL" "$MESON_SRC_SHA" "$MESON_TB"
  homescoop_extract "$MESON_TB" "$WORK/meson-$MESON_VERSION"
  MESON=(python3 "$WORK/meson-$MESON_VERSION/meson.py")
  if ! command -v ninja >/dev/null 2>&1; then
    python3 -m venv "$WORK/ninja-venv"
    "$WORK/ninja-venv/bin/pip" install --quiet "ninja==1.13.0"
    export PATH="$WORK/ninja-venv/bin:$PATH"
  fi
  CROSS="$WORK/emscripten-cross.ini"
  cat >"$CROSS" <<EOF
[binaries]
c = '$(command -v emcc)'
cpp = '$(command -v em++)'
ar = '$(command -v emar)'
ranlib = '$(command -v emranlib)'
strip = '$(command -v emstrip)'

[built-in options]
c_args = ['-O2']

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
EOF
  echo "== dav1d $DAV1D_VERSION: meson $MESON_VERSION cross"
  rm -rf "$DAV_BLD"
  "${MESON[@]}" setup "$DAV_BLD" "$DAV_SRC" --cross-file "$CROSS" \
    --prefix "$STAGE" --libdir lib --buildtype release \
    --default-library static \
    -Denable_asm=false -Denable_tools=false -Denable_examples=false \
    -Denable_tests=false -Denable_docs=false -Dlogging=false
  ninja -C "$DAV_BLD" -j"$JOBS"
  ninja -C "$DAV_BLD" install
fi
test -f "$STAGE/lib/libdav1d.a"

HEIF_BLD="$WORK/libheif-build"
SLICC_A="$WORK/libslicc-libheif.a"
homescoop_slicc_archive "$SLICC_A" gaps
export HOMESCOOP_EM_CLI_LDFLAGS_EXTRA="-sSTACK_SIZE=2097152 -sINVOKE_RUN=0 -sEXPORTED_RUNTIME_METHODS=FS,callMain -lnodefs.js -fexceptions"
# -O2 last: CMAKE_BUILD_TYPE=Release links with -O3, where emcc minifies the
# wasm's import and export names, so slicc_sig_mask, slicc_cred_euid and
# slicc_cred_js lose their names (check-slicc-cred, homescoop#459). The
# libraries stay at -O3; only the link of heif-dec and heif-info is -O2.
EXE_LDFLAGS="$(homescoop_slicc_keep_exports) $(homescoop_em_cli_ldflags) -Wl,--whole-archive $SLICC_A -Wl,--no-whole-archive -O2"

if [[ ! -f "$HEIF_BLD/examples/heif-dec.wasm" || ! -f "$HEIF_BLD/examples/heif-info.wasm" ]]; then
  echo "== libheif $VERSION: emcmake (static, libde265 + dav1d built in, no plugins, no threads)"
  rm -rf "$HEIF_BLD"
  env PKG_CONFIG_LIBDIR="$STAGE/lib/pkgconfig:$PREFIX/lib/pkgconfig" PKG_CONFIG_PATH= \
    emcmake cmake -S "$SRC_DIR" -B "$HEIF_BLD" -G "Unix Makefiles" \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX="$STAGE" \
      -DCMAKE_FIND_ROOT_PATH="$STAGE;$PREFIX" -DCMAKE_PREFIX_PATH="$STAGE;$PREFIX" \
      -DCMAKE_C_FLAGS="-O2 -fexceptions -DHOMESCOOP_NO_EMBIND" -DCMAKE_CXX_FLAGS="-O2 -fexceptions -DHOMESCOOP_NO_EMBIND" \
      -DCMAKE_EXE_LINKER_FLAGS="$EXE_LDFLAGS" \
      -DBUILD_SHARED_LIBS=OFF -DENABLE_PLUGIN_LOADING=OFF \
      -DENABLE_MULTITHREADING_SUPPORT=OFF -DENABLE_PARALLEL_TILE_DECODING=OFF \
      -DWITH_LIBDE265=ON -DWITH_LIBDE265_PLUGIN=OFF \
      -DLIBDE265_INCLUDE_DIR="$STAGE/include" -DLIBDE265_LIBRARY="$STAGE/lib/libde265.a" \
      -DWITH_DAV1D=ON -DWITH_DAV1D_PLUGIN=OFF \
      -DDAV1D_INCLUDE_DIR="$STAGE/include" -DDAV1D_LIBRARY="$STAGE/lib/libdav1d.a" \
      -DWITH_X265=OFF -DWITH_KVAZAAR=OFF -DWITH_UVG266=OFF -DWITH_VVDEC=OFF -DWITH_VVENC=OFF \
      -DWITH_X264=OFF -DWITH_OpenH264_DECODER=OFF -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF \
      -DWITH_SvtEnc=OFF -DWITH_RAV1E=OFF -DWITH_JPEG_DECODER=OFF -DWITH_JPEG_ENCODER=OFF \
      -DWITH_OpenJPEG_ENCODER=OFF -DWITH_OpenJPEG_DECODER=OFF -DWITH_FFMPEG_DECODER=OFF \
      -DWITH_OPENJPH_ENCODER=OFF -DWITH_UNCOMPRESSED_CODEC=ON -DWITH_WEBCODECS=OFF \
      -DWITH_LIBSHARPYUV=OFF -DWITH_HEADER_COMPRESSION=OFF \
      -DWITH_EXAMPLES=ON -DWITH_EXAMPLE_HEIF_THUMB=OFF -DWITH_EXAMPLE_HEIF_VIEW=OFF \
      -DWITH_GDK_PIXBUF=OFF -DBUILD_TESTING=OFF -DBUILD_DOCUMENTATION=OFF \
      -DWITH_FUZZERS=OFF -DCMAKE_DISABLE_FIND_PACKAGE_TIFF=ON -DCMAKE_DISABLE_FIND_PACKAGE_WEBP=ON \
      -DCMAKE_DISABLE_FIND_PACKAGE_Brotli=ON -DCMAKE_DISABLE_FIND_PACKAGE_Doxygen=ON \
      -DZLIB_INCLUDE_DIR="$PREFIX/include" -DZLIB_LIBRARY="$PREFIX/lib/libz.a" \
      -DJPEG_INCLUDE_DIR="$PREFIX/include" -DJPEG_LIBRARY="$PREFIX/lib/libjpeg.a" \
      -DPNG_PNG_INCLUDE_DIR="$PREFIX/include" -DPNG_LIBRARY="$PREFIX/lib/libpng16.a"
  emmake make -C "$HEIF_BLD" -j"$JOBS" heif heifio heif-dec heif-info
fi

for t in heif-dec heif-info; do
  test -f "$HEIF_BLD/examples/$t.wasm"
  if [[ -f "$HEIF_BLD/examples/$t.js" ]]; then
    mv "$HEIF_BLD/examples/$t.js" "$HEIF_BLD/examples/$t"
  fi
  homescoop_stage_cli "$HEIF_BLD/examples" "$t"
done

rm -rf "$PKGDIR/lib" "$PKGDIR/include" "$PKGDIR/share"
mkdir -p "$PKGDIR/lib/pkgconfig" "$PKGDIR/include/libheif" "$PKGDIR/share/libheif/relink" "$PREFIX/include/libheif"
LIBHEIF_A="$(find "$HEIF_BLD/libheif" -name libheif.a | head -1)"
LIBHEIFIO_A="$(find "$HEIF_BLD/heifio" -name libheifio.a | head -1)"
test -s "$LIBHEIF_A" && test -s "$LIBHEIFIO_A"
homescoop_require_lib_size "$LIBHEIF_A" 100000 >/dev/null
homescoop_stage_lib "$LIBHEIF_A" libheif.a
homescoop_stage_lib "$STAGE/lib/libde265.a" libde265.a
homescoop_stage_lib "$STAGE/lib/libdav1d.a" libdav1d.a
cp "$LIBHEIFIO_A" "$PKGDIR/share/libheif/relink/libheifio.a"
for h in "$SRC_DIR"/libheif/api/libheif/*.h "$HEIF_BLD"/libheif/heif_version.h; do
  [[ "$(basename "$h")" == heif_emscripten.h ]] && continue
  cp "$h" "$PKGDIR/include/libheif/"
  cp "$h" "$PREFIX/include/libheif/"
done
test -f "$PKGDIR/include/libheif/heif.h"
test -f "$PKGDIR/include/libheif/heif_version.h"
HS_STAGE="$STAGE" perl -pi -e 's/\Q$ENV{HS_STAGE}\E/\/usr\/local/g' "$PKGDIR/include/libheif/heif_version.h"
if grep -rqF "$WORK" "$PKGDIR/include"; then
  echo "homescoop: $PKGDIR/include still names the build directory $WORK (homescoop#908)" >&2
  exit 1
fi
cp -R "$STAGE/include/libde265" "$STAGE/include/dav1d" "$PKGDIR/include/"
cp -R "$STAGE/include/libde265" "$STAGE/include/dav1d" "$PREFIX/include/"
homescoop_write_pc libde265 "$LIBDE265_VERSION" "-lde265"
homescoop_write_pc dav1d "$DAV1D_VERSION" "-ldav1d"
homescoop_write_pc libheif "$VERSION" "-lheif" "libde265 dav1d zlib"

for t in heif-dec heif-info; do
  objs=()
  while IFS= read -r o; do objs+=("$o"); done < <(find "$HEIF_BLD/examples/CMakeFiles/$t.dir" -name '*.o' | sort)
  test "${#objs[@]}" -gt 0
  rm -f "$PKGDIR/share/libheif/relink/$t.a"
  emar rcs "$PKGDIR/share/libheif/relink/$t.a" "${objs[@]}"
done
cp "$HOMESCOOP_PKG/relink.sh" "$PKGDIR/share/libheif/relink/relink.sh"
# Every file the link flags name by absolute path goes into the kit and is named
# relative to it (homescoop#398): each --js-library into js/ (the CLI flags
# gained slicc-linkat.js and slicc-uname.js), the slicc archive as
# libslicc-gaps.a, and the credential library (homescoop#459).
KIT="$PKGDIR/share/libheif/relink"
mkdir -p "$KIT/js"
read -r -a words <<<"$EXE_LDFLAGS"
out=()
prev=""
for t in "${words[@]}"; do
  if [[ "$prev" == "--js-library" ]]; then
    cp "$t" "$KIT/js/"
    out+=("js/$(basename "$t")")
  elif [[ "$t" == "$SLICC_A" ]]; then
    cp "$t" "$KIT/libslicc-gaps.a"
    out+=("libslicc-gaps.a")
  elif [[ "$t" == /* ]]; then
    test -f "$t" || { echo "homescoop: link flag $t is not a file" >&2; exit 1; }
    cp "$t" "$KIT/$(basename "$t")"
    out+=("$(basename "$t")")
  else
    out+=("$t")
  fi
  prev="$t"
done
printf '%s\n' "${out[*]}" >"$KIT/ldflags.txt"
if grep -Eq '(^| )/' "$KIT/ldflags.txt"; then echo "homescoop: $KIT/ldflags.txt names an absolute path" >&2; exit 1; fi
test -f "$KIT/js/slicc-writev.js"
for a in libz.a libjpeg.a libpng16.a; do cp "$PREFIX/lib/$a" "$PKGDIR/share/libheif/relink/$a"; done

LIC="$WORK/libheif-licenses"
rm -rf "$LIC" && mkdir -p "$LIC"
cp "$SRC_DIR/COPYING" "$LIC/libheif-COPYING"
cp "$DE_SRC/COPYING" "$LIC/libde265-COPYING"
cp "$DAV_SRC/COPYING" "$LIC/dav1d-COPYING"
cp "$SRC_DIR/examples/COPYING" "$LIC/libheif-examples-COPYING"
homescoop_stage_licenses "$LIC/libheif-COPYING" "$LIC/libde265-COPYING" "$LIC/dav1d-COPYING" "$LIC/libheif-examples-COPYING"
homescoop_notices_begin "heif-dec.wasm and heif-info.wasm statically link libheif $VERSION (LGPL-3.0-or-later), libde265 $LIBDE265_VERSION (LGPL-3.0-or-later; an HEVC decoder, and HEVC is patent-encumbered), dav1d $DAV1D_VERSION (BSD-2-Clause) and the libraries below. heif-dec and heif-info are libheif's MIT-licensed example programs. lib/ and include/ hold the static libraries and headers, and share/libheif/relink the application objects, so either program can be relinked against a modified libheif or libde265 (README.md, Relinking)."
homescoop_notice "libheif $VERSION (lib/libheif.a)" "$SRC_DIR/COPYING" -
homescoop_notice "libheif $VERSION examples: heif-dec, heif-info, heifio (MIT)" "$SRC_DIR/examples/COPYING" -
homescoop_notice "libde265 $LIBDE265_VERSION (lib/libde265.a)" "$DE_SRC/COPYING" -
homescoop_notice "dav1d $DAV1D_VERSION (lib/libdav1d.a)" "$DAV_SRC/COPYING" -
homescoop_notice "zlib 1.3.1 (@ai-ecoverse/wasm-zlib)" \
  https://raw.githubusercontent.com/madler/zlib/v1.3.1/LICENSE 845efc77857d485d91fb3e0b884aaa929368c717ae8186b66fe1ed2495753243
homescoop_notice "libjpeg-turbo 3.1.2 (@ai-ecoverse/wasm-libjpeg-turbo)" \
  https://raw.githubusercontent.com/libjpeg-turbo/libjpeg-turbo/3.1.2/LICENSE.md 2189dc45a8fe96204069f8124caa53a148dfdc193f50f584c6ca7849a6072872 \
  https://raw.githubusercontent.com/libjpeg-turbo/libjpeg-turbo/3.1.2/README.ijg 75815e3bf6484201a3c3d17a1bbf10f2e8e3237f84df10a2357ea896db2a81d6
homescoop_notice "libpng 1.6.59 (@ai-ecoverse/wasm-libpng)" \
  https://raw.githubusercontent.com/pnggroup/libpng/v1.6.59/LICENSE bdb0a645ea18c60507d0368379b1ac5474b92255fcc2d115e07486a7672ba526
homescoop_notice_emscripten
echo "== libheif: staged → $PKGDIR ($VERSION, libde265 $LIBDE265_VERSION, dav1d $DAV1D_VERSION)"
