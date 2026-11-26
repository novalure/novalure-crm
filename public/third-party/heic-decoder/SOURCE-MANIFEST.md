# HEIC decoder: source and rebuild manifest

This application converts HEIC images locally. It distributes a separately
replaceable JavaScript/WASM decoder, with the wrapper source, build script and
third-party notices in this directory. See `NOTICE.txt`, `LICENSE`, and
`THIRD-PARTY-NOTICES.md` for copyright and license information. These materials
do not determine whether HEVC patent licenses are required in a given use.

## Decoder used in this candidate

* Application wrapper: `primary.cpp` in this directory.
* Relink script: `build-primary.sh` in this directory, SHA-256
  `2146ae71bdeaf25ea63b4103ce8ca6db39f73c3cd57c054627e5aa81f16cf5ad`.
* Compiler: Emscripten 4.0.23; the tested compiler reports source commit
  `7a5d93b50f6a3a35e85a0d2fc9e667b8498e6aed`. In the fresh test,
  `emsdk install 4.0.23` resolved to
  `sdk-releases-aaa43392544d695232b70eda706d751f18980c2a-64bit`;
  that identifier is not a verified SDK download SHA-256 or signature.
* npm build input: `sources/wasm-libheif-1.23.7-1.tgz`,
  `@ai-ecoverse/wasm-libheif@1.23.7-1`, SHA-256 of the
  published tarball:
  `281a3d13d6589ee85a3e0f66928da79874dc31e5b3a912a8533925833bbff307`.
* Separate shipped output: `/heic-decoder/primary.js`, SHA-256
  `e15b439db241f23a9d7b51df385221512f728e5b1ded80d396f08306651b9afc`,
  and `/heic-decoder/primary.wasm`, SHA-256
  `786e1b538c3c0029a5a79b4d77d88f276565c36853d3d34a4ef23fa09661cff7`.
* WASM linear-memory maximum: 512 MiB. This does not bound all memory used by
  the browser, JavaScript, image buffers, or canvas.

The npm package includes static archives, headers and its link-time shims. With
Emscripten 4.0.23, Node.js and npm available, run `bash build-primary.sh` in a
clean directory containing `primary.cpp` and the `sources/` directory. The
script verifies the included package's SHA-256 and links both output files.
With the SDK preinstalled and all external network access blocked, a separate
link reproduced both output hashes above. If the local archive is absent, the
script downloads the pinned npm package and checks the same SHA-256. Replace
the two files together for a compatible rebuilt decoder.

An additional technical test relinked against a modified `libheif.a` archive
containing a harmless explicitly exported marker; both builds decoded a real
HEIC file to identical pixels. That test demonstrates one relinking path; it
does not establish every license obligation or prove independent toolchain
reproducibility. The test source and instructions are in `relink-proof/`.

## Pinned upstream sources

The following version and SHA-256 values come from the recipes referenced by
the package's published provenance payloads. The payload signatures have not
been independently verified. The public publish log identifies certified build
artifact `host-libheif-pr1949`, source commit
`c37e2012696b7a2676899df3e626fd358c6560f4`, and the same npm tarball SHA-256:
https://github.com/ai-ecoverse/homescoop/actions/runs/41473933141/job/125374534923
The six runtime-library source archives are also mirrored under `sources/upstream/`;
the exact npm relink package is under `sources/`. `sources/SHA256SUMS` lists
all seven files, and all seven were checked against it before this candidate
was prepared. Meson and the Emscripten SDK are build tools linked externally,
not included in that mirrored runtime-source bundle.

| Component | Version | Source archive | SHA-256 |
| --- | --- | --- | --- |
| libheif | 1.23.7 | https://github.com/strukturag/libheif/archive/refs/tags/v1.23.7.tar.gz | `90e389caad285ca4946461d56d1c115e56bcbb5141d9038050282af91064fbc7` |
| libde265 | 1.1.3 | https://github.com/strukturag/libde265/releases/download/v1.1.3/libde265-1.1.3.tar.gz | `554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905` |
| dav1d | 1.5.4 | https://downloads.videolan.org/pub/videolan/dav1d/1.5.4/dav1d-1.5.4.tar.xz | `686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5` |
| zlib | 1.3.1 | https://zlib.net/fossils/zlib-1.3.1.tar.gz | `9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23` |
| libjpeg-turbo | 3.1.2 | https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.1.2/libjpeg-turbo-3.1.2.tar.gz | `8f0012234b464ce50890c490f18194f913a7b1f4e6a03d6644179fa0f867d0cf` |
| libpng | 1.6.59 | https://downloads.sourceforge.net/project/libpng/libpng16/1.6.59/libpng-1.6.59.tar.gz | `86a3e4b501f7f50e392c4e456ea158893e9a595b1c63eb88c7bb9f6cf8772dad` |
| Meson, build tool | 1.12.1 | https://files.pythonhosted.org/packages/source/m/meson/meson-1.12.1.tar.gz | `ab0a6ca09f8ef70c564c8241fb5a23957886a0b53fb58412b5e07eaf07dba743` |

Mirrored copies: [libheif](sources/upstream/libheif.tar.gz),
[libde265](sources/upstream/libde265.tar.gz), [dav1d](sources/upstream/dav1d.tar.xz),
[zlib](sources/upstream/zlib.tar.gz), [libjpeg-turbo](sources/upstream/libjpeg-turbo.tar.gz),
[libpng](sources/upstream/libpng.tar.gz), and
[npm relink package](sources/wasm-libheif-1.23.7-1.tgz).
To verify after downloading the files while retaining their directory structure,
run `cd sources && sha256sum -c SHA256SUMS`.

The published package identifies the following pinned source recipes and build
patches. Its publishing workflow can publish a prebuilt pull-request artifact;
the certified source commit above is distinct from the publish commit below.
The main libheif recipe, build script and three patches at those commits were
compared and found byte-identical:

* libheif recipe/build and patches:
  https://github.com/ai-ecoverse/homescoop/tree/715e12b3460820d58aa79d3892bde89a740c1d8a/packages/libheif
  and https://github.com/ai-ecoverse/homescoop/tree/c37e2012696b7a2676899df3e626fd358c6560f4/packages/libheif
  Byte-identical copies of `build.sh`, `recipe.yaml`, all three libheif patches,
  and `relink.sh` from the certified build commit are in `upstream-build/`.
  Their Git blob IDs match the upstream commit.
* zlib recipe: https://github.com/ai-ecoverse/homescoop/tree/f7beaaecbd894e4e8549a748182f5382d6f5b882/packages/zlib
* libjpeg-turbo recipe: https://github.com/ai-ecoverse/homescoop/tree/1f0d006b5f21cb0a4d0fab313cb5b4655733e925/packages/libjpeg-turbo
* libpng recipe: https://github.com/ai-ecoverse/homescoop/tree/b833ada0eb729c08c984996120f8dbb35de94265/packages/libpng
* Emscripten source: https://github.com/emscripten-core/emscripten/tree/7a5d93b50f6a3a35e85a0d2fc9e667b8498e6aed

The exact npm tarball's relink flags reference four JavaScript shims:
`slicc-writev.js`, `slicc-linkat.js`, `slicc-uname.js` and `slicc-env.js`.
Their bytes match the certified build commit. The flags also link
`libslicc_cred.a` (SHA-256
`51090ff96f3c0ffc8a0b7c40be7bd3e449439d6a43ca57927a54f06dc82da7ee`)
and `libslicc-gaps.a` (SHA-256
`9dcc0e063b1e010f9a7b455302f65c5fa938348241cd9d7ed9c209f46b739b50`).
Related C sources are at
https://github.com/ai-ecoverse/homescoop/tree/c37e2012696b7a2676899df3e626fd358c6560f4/shims/slicc;
the build recipe maps `slicc_libc_gaps.c` (with `SLICC_CRED_SEPARATE`),
`slicc_pwd.c`, and `slicc_signals.c` to `libslicc-gaps.a`, and `slicc_cred.c`
to `libslicc_cred.a`. The corresponding object names were verified in both
archives. Byte-for-byte rebuilding of these archives from source remains open.

The bundled and separately published libpng 1.6.59 archives have different
whole-archive hashes. A comparison of their 20 WASM object members found their
non-debug sections byte-identical; the original debug-stripping command has not
been independently reproduced. A separate relink with zlib but without libpng
or libjpeg produced a byte-identical `primary.wasm` (the output JavaScript was
not byte-identical because different output names were used). Omitting zlib as
well failed because libheif requires zlib symbols. The precise Emscripten SDK
distribution hash, byte-for-byte rebuilding of the shim archives, and an
independent full rebuild of all static libraries from source remain unverified.
