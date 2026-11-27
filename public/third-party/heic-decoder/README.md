# `@ai-ecoverse/wasm-libheif`

[libheif](https://github.com/strukturag/libheif) 1.23.7 for
[slicc](https://github.com/ai-ecoverse/slicc)'s wasm realm: it decodes
HEIF / HEIC (iPhone photos) and AVIF. It has three commands: `heif-convert`,
`heif-dec` (the same program under libheif's current name) and `heif-info`.
It also ships the static libraries and headers, so other homescoop packages
can link it. `@ai-ecoverse/wasm-imagemagick-heif` does.

> **Optional package, HEVC inside.** HEIC images are HEVC (H.265). This
> package contains an HEVC decoder,
> [libde265](https://github.com/strukturag/libde265) 1.1.3, and **HEVC is
> patent-encumbered**: depending on where and how you use it, decoding HEVC
> may need a patent licence. That's why this package is never part of a base
> set: install it only if you want it. AVIF is decoded by
> [dav1d](https://code.videolan.org/videolan/dav1d) 1.5.4 (AV1, royalty-free).
> There are no encoders (no x265, no aom).

```bash
pnpm add -g @ai-ecoverse/wasm-libheif
heif-info IMG_0001.HEIC
heif-convert IMG_0001.HEIC IMG_0001.png          # or .jpg / .jpeg, -q 90 for JPEG quality
heif-convert --with-aux --no-colons portrait.heic p.png   # p.png, p-depth.png, p-urn_com_apple_photo_2020_aux_hdrgainmap.png
heif-convert --with-exif IMG_0001.HEIC IMG_0001.jpg       # IMG_0001.jpg + IMG_0001.exif
heif-convert photo.avif photo.png
heif-convert --list-decoders
```

- **Several images in one file:** `heif-convert multi.heic out.png` writes
  `out-1.png`, `out-2.png`, …, one per top-level image. `--with-aux` adds
  the auxiliary images (an iPhone portrait's depth map and HDR gain map).
- **Orientation:** the HEIF rotation and mirror (`irot`/`imir`) are applied,
  so the output is upright. An iPhone still taken in portrait comes out
  3024x4032. Because the pixels are already rotated, the EXIF copied into
  the JPEG/PNG has its Orientation reset to 1. `--with-exif` writes the
  original EXIF, with the camera's Orientation tag, to a `.exif` file next
  to the output.
- **Output formats:** PNG (8 or 16 bit, with alpha when the image has it),
  JPEG and Y4M. TIFF and WebP output are not built.
- **Limits:** there are no threads (tiles decode one after another), and no
  plugins (`plugin path: plugins are disabled`). Upstream's Emscripten speed
  shortcut, which turns off HEVC deblocking and SAO, is patched out, so
  pixels match a native libheif. libheif's default security limits apply,
  and `--disable-limits` lifts them.
- **Exit status:** when an output can't be written (a missing directory, a
  directory in the way, no permission, a full disk), `heif-convert` and
  `heif-dec` print `could not write image` and exit 1. Upstream exits 0
  there; `heif-dec-write-errors.patch` fixes that, also for the depth,
  auxiliary, tile, sequence, XMP and EXIF outputs.

## Licences

| Part | Licence | Where |
| --- | --- | --- |
| libheif 1.23.7 (`lib/libheif.a`) | LGPL-3.0-or-later | `LICENSE` |
| libde265 1.1.3 (`lib/libde265.a`) | LGPL-3.0-or-later | `LICENSE` |
| dav1d 1.5.4 (`lib/libdav1d.a`) | BSD-2-Clause | `LICENSE` |
| heif-dec, heif-info, heifio (libheif examples) | MIT | `LICENSE` |
| zlib, libjpeg-turbo, libpng, Emscripten runtime | see notices | `THIRD-PARTY-NOTICES.md` |

`LICENSE` has all four texts, and `THIRD-PARTY-NOTICES.md` has every library
that `bin/*.wasm` links statically. The sources are the upstream release
tarballs pinned (with sha256) in
[`packages/libheif/recipe.yaml`](https://github.com/ai-ecoverse/homescoop/tree/main/packages/libheif/recipe.yaml),
plus the three patches next to it, and `build.sh` there is the complete build.

## Relinking (LGPL)

The programs link libheif and libde265 statically, so the package ships
everything you need to relink them against your own build of either library:

- `lib/libheif.a`, `lib/libde265.a`, `lib/libdav1d.a`, `include/libheif`,
  `include/libde265`, `include/dav1d` and `lib/pkgconfig/*.pc`;
- `share/libheif/relink/`: the application objects (`heif-dec.a`,
  `heif-info.a`, `libheifio.a`), the other static libraries they use
  (`libpng16.a`, `libjpeg.a`, `libz.a`, `libslicc-gaps.a`,
  `libslicc_cred.a`), the slicc link flags (`ldflags.txt`, with every
  `--js-library` they name in `js/`) and `relink.sh`.

With Emscripten 4.0.23 (`emcc` on PATH):

```bash
cd node_modules/@ai-ecoverse/wasm-libheif
bash share/libheif/relink/relink.sh /tmp/relinked \
  /path/to/your/libheif.a /path/to/your/libde265.a   # defaults: lib/*.a
cp /tmp/relinked/heif-dec* /tmp/relinked/heif-info* bin/
```

Build the replacement libraries like `build.sh` does: `emcmake cmake`,
static, `-fexceptions`, libheif with `-DHOMESCOOP_NO_EMBIND`,
`-DENABLE_PLUGIN_LOADING=OFF` and `-DENABLE_MULTITHREADING_SUPPORT=OFF`.
ladder-pr runs this relink on every build and checks the relinked
`heif-dec` against host libheif (`cert/lib/relink-check.mjs`).

To link libheif into your own program:
`PKG_CONFIG_PATH=$PWD/lib/pkgconfig pkg-config --static --cflags --libs libheif`
gives `-lheif -lde265 -ldav1d -lz`. Link with `-fexceptions`.

## Tests

`packages/libheif/cert` runs under slicc-kernel. It covers real iPhone files
(an iPhone 13 Pro Max still, and an iPhone 13 Pro portrait with its depth map
and HDR gain map), libheif's two-image example and an AVIF, odd sizes
(451x461, 1x1, 1023x769 at 16 bit), a rotated file, and corrupt input. Every
PNG is compared sample by sample with references generated before this release with Homebrew's libheif 1.23.6. Most outputs
are bit-identical to the host's. In one, libheif's `example.heic` image 1, 35
of 3,279,360 samples differ by 1, and the cert allows at most 1 per sample on
at most 0.01% of samples, with each such sample listed in
`cert/fixtures/references.json`. Sources and licences of the sample files
are in `cert/fixtures/fixtures.json`.

Since 1.23.7, `heif-info` can list metadata from a truncated file without
decoding its image. Use `heif-convert` to validate decoding: the cert requires
the truncated fixture to fail with an out-of-bounds extent error and no output.
