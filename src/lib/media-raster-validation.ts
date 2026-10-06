import sharp from "sharp";

export const rasterUploadLimits = Object.freeze({ maxPixels: 40_000_000, maxDimension: 16_384, maxFrames: 100, timeoutSeconds: 5 });

type RasterValidation = { ok: true } | { ok: false; code: "FILE_CONTENT_MISMATCH" | "IMAGE_TOO_LARGE" };
const formats: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif", "image/avif": "heif",
};

/** Validate in memory only. The original upload is neither transformed nor replaced. */
export async function validateRasterMediaContent(bytes: Buffer, mimeType: string): Promise<RasterValidation> {
  const format = formats[mimeType.toLowerCase()];
  if (!format) return { ok: false, code: "FILE_CONTENT_MISMATCH" };
  let decoder: ReturnType<typeof sharp> | undefined;
  try {
    decoder = sharp(bytes, { animated: true, failOn: "warning", limitInputPixels: rasterUploadLimits.maxPixels });
    const metadata = await decoder.metadata();
    if (metadata.format !== format || (mimeType.toLowerCase() === "image/avif" && metadata.compression !== "av1")) {
      return { ok: false, code: "FILE_CONTENT_MISMATCH" };
    }
    const width = metadata.width ?? 0, height = metadata.height ?? 0;
    const frames = metadata.pages ?? 1, frameHeight = metadata.pageHeight ?? height;
    if (![width, height, frameHeight, frames].every(value => Number.isSafeInteger(value) && value > 0) || height !== frameHeight * frames) {
      return { ok: false, code: "FILE_CONTENT_MISMATCH" };
    }
    if (width > rasterUploadLimits.maxDimension || frameHeight > rasterUploadLimits.maxDimension ||
        frames > rasterUploadLimits.maxFrames || width * frameHeight * frames > rasterUploadLimits.maxPixels) {
      return { ok: false, code: "IMAGE_TOO_LARGE" };
    }
    // metadata() reads only headers. Force decoding of ALL pixels/frames, then discard
    // the bounded raw buffer; otherwise corrupt IDAT/entropy data can reach storage.
    await decoder.timeout({ seconds: rasterUploadLimits.timeoutSeconds }).raw({ depth: "uchar" }).toBuffer();
    return { ok: true };
  } catch (error) {
    // Sharp's own pixel guard may reject before metadata is returned. Never expose
    // native decoder diagnostics or file metadata to clients.
    return { ok: false, code: error instanceof Error && error.message === "Input image exceeds pixel limit"
      ? "IMAGE_TOO_LARGE" : "FILE_CONTENT_MISMATCH" };
  } finally {
    decoder?.destroy();
  }
}
