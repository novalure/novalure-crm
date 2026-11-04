import { validatePropertyExposePdf } from "./property-expose-pdf-validation";
import { validateRasterMediaContent } from "./media-raster-validation";
import { webExposeDirectUploadLimit, webExposeResourceMimeTypes, type WebExposeResourceKind } from "./web-expose-media";

/** Container validation is not a promise that every browser supports the embedded codec. */
export function validateWebExposeVideoContent(bytes: Uint8Array, mimeType: string): boolean {
  const data = Buffer.from(bytes);
  if (data.length < 32 || data.length > webExposeDirectUploadLimit) return false;
  if (mimeType === "video/webm") return data.readUInt32BE(0) === 0x1a45dfa3 && data.subarray(0, Math.min(512, data.length)).includes(Buffer.from("webm")) && data.includes(Buffer.from([0x1f, 0x43, 0xb6, 0x75])) && data.includes(Buffer.from([0x83, 0x81, 0x01]));
  if (mimeType !== "video/mp4") return false;
  let cursor = 0, atoms = 0, fileType = false, movie = false, media = false;
  while (cursor < data.length) {
    if (++atoms > 10000 || cursor + 8 > data.length) return false;
    let size = data.readUInt32BE(cursor), header = 8;
    const type = data.toString("ascii", cursor + 4, cursor + 8);
    if (size === 1) { if (cursor + 16 > data.length) return false; const extended = data.readBigUInt64BE(cursor + 8); if (extended > BigInt(data.length)) return false; size = Number(extended); header = 16; }
    else if (size === 0) size = data.length - cursor;
    if (size < header || cursor + size > data.length) return false;
    if (type === "ftyp") { const brand = data.toString("ascii", cursor + header, cursor + header + 4); fileType = ["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash", "msdh", "msix", "MSNV"].includes(brand); }
    if (type === "moov") movie = data.subarray(cursor + header, cursor + size).includes(Buffer.from("vide"));
    if (type === "mdat" && size > header) media = true;
    cursor += size;
  }
  return fileType && movie && media;
}
export async function validateWebExposeUpload(file: File, kind: WebExposeResourceKind): Promise<Uint8Array> {
  if (kind === "external_link" || !(webExposeResourceMimeTypes[kind] as readonly string[]).includes(file.type.toLowerCase()) || file.size < 1 || file.size > webExposeDirectUploadLimit) throw new Error("Bitte eine passende Datei mit maximal 4 MB auswählen.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw new Error("Dateigröße konnte nicht bestätigt werden.");
  if (file.type === "application/pdf") await validatePropertyExposePdf(bytes);
  else if (file.type.startsWith("image/")) { const validated = await validateRasterMediaContent(Buffer.from(bytes), file.type); if (!validated.ok) throw new Error("Die Bilddatei ist beschädigt, zu groß oder hat einen anderen Dateityp."); }
  else if (!validateWebExposeVideoContent(bytes, file.type)) throw new Error("Bitte eine vollständige MP4- oder WebM-Videodatei mit Videospur verwenden.");
  return bytes;
}
export async function readWebExposeUploadForm(request: Request): Promise<FormData> {
  const limit = webExposeDirectUploadLimit + 64 * 1024, declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error("UPLOAD_TOO_LARGE");
  if (!request.body || !request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) throw new Error("INVALID_UPLOAD_BODY");
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  let timer: ReturnType<typeof setTimeout>; const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("UPLOAD_TIMEOUT")), 20000); });
  try { while (true) { const item = await Promise.race([reader.read(), deadline]); if (item.done) break; total += item.value.byteLength; if (total > limit) throw new Error("UPLOAD_TOO_LARGE"); chunks.push(item.value); } }
  catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { clearTimeout(timer!); reader.releaseLock(); }
  return new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { "content-type": request.headers.get("content-type")! } }).formData();
}
