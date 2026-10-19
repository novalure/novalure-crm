import { deflateRawSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PNG_FIXTURE = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC", "base64"));

export async function createTextPdf(pages: string[] = ["SYNTHETIC knowledge ALPHA", "SYNTHETIC second page BETA"]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) doc.addPage([300, 300]).drawText(text, { x: 20, y: 250, font, size: 12 });
  return doc.save();
}
export async function createScanPdf() {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(PNG_FIXTURE);
  doc.addPage([300, 300]).drawImage(image, { x: 20, y: 20, width: 100, height: 100 });
  return doc.save();
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Small generated fixtures; no opaque uploaded or production data. */
export function createZip(entries: Record<string, string | Uint8Array>, compress = true) {
  const localParts: Buffer[] = [], centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name), data = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    const payload = compress ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(compress ? 8 : 0, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    localParts.push(local, filename, payload); centralParts.push(central, filename);
    offset += local.length + filename.length + payload.length;
  }
  const central = Buffer.concat(centralParts), ending = Buffer.alloc(22);
  ending.writeUInt32LE(0x06054b50, 0); ending.writeUInt16LE(Object.keys(entries).length, 8); ending.writeUInt16LE(Object.keys(entries).length, 10);
  ending.writeUInt32LE(central.length, 12); ending.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, ending]);
}
export const DEFAULT_DOCUMENT_XML = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SYNTHETIC paragraph ALPHA</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Table two</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Final paragraph BETA</w:t></w:r></w:p></w:body></w:document>';
export function createDocx(options: { documentXml?: string; relationshipsXml?: string; additions?: Record<string, string | Uint8Array>; compress?: boolean } = {}) {
  return createZip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": options.documentXml ?? DEFAULT_DOCUMENT_XML,
    ...(options.relationshipsXml ? { "word/_rels/document.xml.rels": options.relationshipsXml } : {}),
    ...options.additions,
  }, options.compress ?? true);
}
