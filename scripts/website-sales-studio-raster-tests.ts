import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { normalizeWebsiteStudioRaster, websiteStudioRasterLimits } from "../src/lib/website-sales-studio-raster";

test("actual PNG JPEG and WebP pixels become bounded metadata-free private raster bytes with both digests", async () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const bytes = await sharp({ create: { width: 1800, height: 1000, channels: 3, background: "#156385" } }).withMetadata({ exif: { IFD0: { Artist: "Synthetic private metadata" } } })[format]().toBuffer();
    const normalized = await normalizeWebsiteStudioRaster(new File([new Uint8Array(bytes)], `synthetic.${format}`, { type: `image/${format}` })), decoded = await sharp(normalized.bytes).metadata();
    assert.equal(normalized.mime, "image/webp"); assert.equal(decoded.format, "webp"); assert.equal(decoded.width, normalized.width); assert.equal(decoded.height, normalized.height);
    assert(normalized.width <= 1280 && normalized.height <= 960 && normalized.bytes.byteLength <= websiteStudioRasterLimits.normalizedBytes);
    assert.equal(decoded.exif, undefined); assert.equal(normalized.originalSha256, createHash("sha256").update(bytes).digest("hex")); assert.equal(normalized.byteSha256, createHash("sha256").update(normalized.bytes).digest("hex"));
  }
});
test("SVG, HTML, declared type mismatch and corrupt image payloads never reach private storage", async () => {
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#123456" } }).png().toBuffer();
  for (const file of [new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], "vector.svg", { type: "image/svg+xml" }), new File(["<script>effect()</script>"], "fake.png", { type: "image/png" }), new File([new Uint8Array(png)], "wrong.jpg", { type: "image/jpeg" }), new File([new Uint8Array(png.subarray(0, 45))], "broken.png", { type: "image/png" })]) await assert.rejects(normalizeWebsiteStudioRaster(file));
});
test("input byte and decoded pixel limits reject oversized images before a persisted artifact exists", async () => {
  await assert.rejects(normalizeWebsiteStudioRaster(new File([new Uint8Array(websiteStudioRasterLimits.originalBytes + 1)], "large.png", { type: "image/png" })), { code: "STUDIO_RASTER_TYPE_OR_SIZE" });
  const tooMany = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(normalizeWebsiteStudioRaster(new File([new Uint8Array(tooMany)], "pixels.png", { type: "image/png" })));
});
