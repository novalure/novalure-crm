const maxSourceBytes = 10 * 1024 * 1024;
const maxPixels = 40_000_000;
const maxDimension = 16_384;
const timeoutMs = 15_000;

export class PropertyHeicConversionError extends Error {}
class NativeFallbackRequired extends Error {}

export function isHeicImage(file: Pick<File, "name" | "type">): boolean {
  const mime = file.type.toLowerCase();
  return /\.(?:heic|heif)$/i.test(file.name) &&
    ["", "image/heic", "image/heif", "application/octet-stream"].includes(mime);
}

async function convertNatively(file: File, message: string): Promise<Blob> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    throw new PropertyHeicConversionError(message);
  }
  let bitmap: ImageBitmap | undefined;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => { const current = bitmap; bitmap = undefined; current?.close(); };
  const decode = async () => {
    try {
    bitmap = await createImageBitmap(file);
    if (cancelled) throw new Error("Native decoding timed out");
    if (!Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height) ||
        bitmap.width < 1 || bitmap.height < 1 || bitmap.width > maxDimension || bitmap.height > maxDimension ||
        bitmap.width * bitmap.height > maxPixels) throw new Error("Invalid dimensions");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    const jpeg = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!jpeg || jpeg.type !== "image/jpeg" || jpeg.size === 0 || jpeg.size > maxSourceBytes) throw new Error("Invalid JPEG");
    return jpeg;
    } finally { release(); }
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Native decoding timed out")), timeoutMs);
  });
  try { return await Promise.race([decode(), deadline]); }
  catch { throw new PropertyHeicConversionError(message); }
  finally { cancelled = true; clearTimeout(timer); release(); }
}

/** Decode locally in a short-lived worker; the original image is not uploaded. */
export async function preparePropertyImageUpload(file: File): Promise<File> {
  if (!isHeicImage(file)) return file;
  if (file.size === 0 || file.size > maxSourceBytes) {
    throw new PropertyHeicConversionError("HEIC-Dateien müssen zwischen 1 Byte und 10 MB groß sein.");
  }
  const message = "HEIC kann nicht umgewandelt werden. Bitte das Bild zuerst als JPEG exportieren.";
  let buffer: ArrayBuffer;
  try { buffer = await file.arrayBuffer(); }
  catch { throw new PropertyHeicConversionError(message); }
  const decodeWithWorker = () => new Promise<Blob>((resolve, reject) => {
    if (typeof Worker === "undefined") { reject(new NativeFallbackRequired()); return; }
    let worker: Worker;
    try { worker = new Worker("/heic-decoder/worker.js"); }
    catch { reject(new NativeFallbackRequired()); return; }
    let settled = false, ready = false;
    const finish = (result?: Blob, unsupported = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (result) resolve(result);
      else reject(unsupported ? new NativeFallbackRequired() : new PropertyHeicConversionError(message));
    };
    const timer = setTimeout(() => finish(undefined, !ready), timeoutMs);
    worker.onmessage = ({ data }: MessageEvent<{ type?: string; ok?: boolean; blob?: Blob; code?: string }>) => {
      if (data?.type === "READY") { ready = true; return; }
      const blob = data?.blob;
      finish(data?.ok && blob instanceof Blob && blob.type === "image/jpeg" && blob.size > 0 && blob.size <= maxSourceBytes ? blob : undefined, data?.code === "BROWSER_UNSUPPORTED");
    };
    worker.onerror = () => finish(undefined, !ready);
    worker.onmessageerror = () => finish(undefined, !ready);
    try { worker.postMessage(buffer, [buffer]); }
    catch { finish(); }
  });
  let jpeg: Blob;
  try { jpeg = await decodeWithWorker(); }
  catch (error) {
    if (!(error instanceof NativeFallbackRequired)) throw error;
    jpeg = await convertNatively(file, message);
  }
  return new File([jpeg], file.name.replace(/\.(?:heic|heif)$/i, ".jpg"), {
    type: "image/jpeg", lastModified: file.lastModified,
  });
}
