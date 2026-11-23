import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { validateRasterMediaContent } from "./media-raster-validation";

export const websiteStudioRasterLimits = Object.freeze({ originalBytes: 4 * 1024 * 1024, normalizedBytes: 256 * 1024, maxPixels: 16_000_000, maxDimension: 8192, outputWidth: 1280, outputHeight: 960, decodeSeconds: 5 });
export type WebsiteStudioNormalizedRaster = { bytes: Uint8Array; mime: "image/webp"; width: number; height: number; byteSha256: string; originalSha256: string };
const formats = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as const;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export class WebsiteStudioRasterError extends Error { constructor(readonly code: string) { super(code); this.name = "WebsiteStudioRasterError"; } }

/** The same full-pixel validator used by private CRM media runs before a fixed,
 * metadata-free WebP conversion. No file path, URL, caller CSS or SVG is accepted. */
export async function normalizeWebsiteStudioRaster(file: File): Promise<WebsiteStudioNormalizedRaster> {
  if (!Object.hasOwn(formats, file.type) || file.size < 1 || file.size > websiteStudioRasterLimits.originalBytes) throw new WebsiteStudioRasterError("STUDIO_RASTER_TYPE_OR_SIZE");
  const original = Buffer.from(await file.arrayBuffer());
  if (original.byteLength !== file.size) throw new WebsiteStudioRasterError("STUDIO_RASTER_SIZE_MISMATCH");
  let decoder: ReturnType<typeof sharp> | undefined;
  try {
    decoder = sharp(original, { failOn: "warning", limitInputPixels: websiteStudioRasterLimits.maxPixels, animated: true }).timeout({ seconds: websiteStudioRasterLimits.decodeSeconds });
    const metadata = await decoder.metadata(), width = metadata.width ?? 0, height = metadata.height ?? 0;
    if (metadata.format !== formats[file.type as keyof typeof formats] || (metadata.pages ?? 1) !== 1 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > websiteStudioRasterLimits.maxDimension || height > websiteStudioRasterLimits.maxDimension || width * height > websiteStudioRasterLimits.maxPixels) throw new WebsiteStudioRasterError("STUDIO_RASTER_DIMENSIONS_OR_FRAMES");
    const validated = await validateRasterMediaContent(original, file.type);
    if (!validated.ok) throw new WebsiteStudioRasterError("STUDIO_RASTER_INVALID_CONTENT");
    decoder.destroy();
    decoder = sharp(original, { failOn: "warning", limitInputPixels: websiteStudioRasterLimits.maxPixels }).timeout({ seconds: websiteStudioRasterLimits.decodeSeconds });
    const normalized = await decoder.rotate().resize({ width: websiteStudioRasterLimits.outputWidth, height: websiteStudioRasterLimits.outputHeight, fit: "inside", withoutEnlargement: true }).webp({ quality: 76, effort: 4 }).toBuffer({ resolveWithObject: true });
    if (normalized.data.byteLength < 1 || normalized.data.byteLength > websiteStudioRasterLimits.normalizedBytes) throw new WebsiteStudioRasterError("STUDIO_RASTER_NORMALIZED_SIZE");
    return { bytes: new Uint8Array(normalized.data), mime: "image/webp", width: normalized.info.width, height: normalized.info.height, byteSha256: digest(normalized.data), originalSha256: digest(original) };
  } catch (error) {
    if (error instanceof WebsiteStudioRasterError) throw error;
    throw new WebsiteStudioRasterError("STUDIO_RASTER_INVALID_CONTENT");
  } finally { decoder?.destroy(); }
}
