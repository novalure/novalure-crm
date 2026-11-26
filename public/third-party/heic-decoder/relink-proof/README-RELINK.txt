Experimental independent relinking proof, 25 November 2026.
Requires Emscripten 4.0.23, Node.js, and npm archive @ai-ecoverse/wasm-libheif@1.23.7-1 SHA256 281a3d13d6589ee85a3e0f66928da79874dc31e5b3a912a8533925833bbff307 unpacked as package/.
Copy the already distributed hardened primary.cpp into this directory and example.heic (SHA256 7f8b363e4936c0666a25f64f3a92fda10bd8e5453be4592530b65a55dd98f3f2).
Run: bash relink-check.sh && node test-relink.cjs
The modified archive contains an added harmless marker.o. The modified link additionally exports this test symbol, so hash inequality is not a claim that existing decoder behavior changed. Both tested outputs matched byte-for-byte. This is a technical demonstration; it does not by itself determine all LGPL obligations.
