/* Node-only, separately traced parser. Never execute document actions or fetch references. */
/* eslint-disable @typescript-eslint/no-require-imports -- Isolated plain CommonJS worker entrypoint. */
const { parentPort, workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
const { TextDecoder } = require("node:util");
const MAX_TEXT = 150_000;
const MAX_XML = 4 * 1024 * 1024;
const MAX_ZIP_BYTES = 32 * 1024 * 1024;
const fail = code => { throw new Error(code); };
const clean = text => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n");
// PDF text extraction has no need for HTTP, remote fonts, WASM or credentials.
globalThis.fetch = async () => fail("EXTERNAL");

/** Bound stream inflation before PDF.js sees compressed font/object/page streams. */
async function preflightPdf(bytes) {
  const { PDFDocument, PDFRawStream, PDFName, PDFArray, PDFNumber, PDFDict } = require("pdf-lib");
  const DecodeStream = require("pdf-lib/cjs/core/streams/DecodeStream.js").default;
  const { decodePDFRawStream } = require("pdf-lib/cjs/core/streams/decode.js");
  const maxStream = 8 * 1024 * 1024;
  const maxDecoded = 32 * 1024 * 1024;
  let allocated = 0;
  const original = DecodeStream.prototype.ensureBuffer;
  DecodeStream.prototype.ensureBuffer = function (requested) {
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > maxStream || this.minBufferLength > maxStream) fail("LIMIT");
    const previous = this.buffer.length;
    const result = original.call(this, requested);
    allocated += Math.max(0, this.buffer.length - previous);
    if (allocated > maxDecoded) fail("LIMIT");
    return result;
  };
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false, capNumbers: false });
  if (doc.isEncrypted || doc.context.trailerInfo.Encrypt) fail("ENCRYPTED");
  const objects = doc.context.enumerateIndirectObjects();
  if (objects.length > 20_000) fail("LIMIT");
  let decoded = 0;
  const streamLengths = new Map();
  for (const [, item] of objects) {
    if (!(item instanceof PDFRawStream)) continue;
    // PDF.js accepts abbreviated keys that pdf-lib's decoder does not read.
    // Refuse these ambiguous/external-stream paths before either decoder runs.
    if (["F", "DP", "FFilter", "FDecodeParms"].some(key => item.dict.has(PDFName.of(key)))) fail("LIMIT");
    const filter = item.dict.lookup(PDFName.of("Filter"));
    const filters = filter === undefined ? [] : filter instanceof PDFName ? [filter.decodeText()] : filter instanceof PDFArray && filter.size() <= 5
      ? filter.asArray().map(value => { const entry = doc.context.lookup(value); return entry instanceof PDFName ? entry.decodeText() : ""; }) : [""];
    const subtype = item.dict.lookup(PDFName.of("Subtype"));
    const image = subtype instanceof PDFName && subtype.decodeText() === "Image";
    const parameters = item.dict.lookup(PDFName.of("DecodeParms"));
    if (parameters !== undefined) {
      // pdf-lib's stream preflight does not apply PDF.js row predictors.
      // Bound their independent row allocations; no text/font stream needs one.
      if (!image || filters.length !== 1 || !(parameters instanceof PDFDict)) fail("LIMIT");
      if (parameters.has(PDFName.of("BPC"))) fail("LIMIT");
      const number = (key, fallback) => {
        const value = parameters.lookup(PDFName.of(key));
        if (value === undefined) return fallback;
        if (!(value instanceof PDFNumber) || !Number.isSafeInteger(value.asNumber())) fail("LIMIT");
        return value.asNumber();
      };
      const predictor = number("Predictor", 1), colors = number("Colors", 1), bits = number("BitsPerComponent", 8), columns = number("Columns", 1);
      if (![1, 2, 10, 11, 12, 13, 14, 15].includes(predictor) || colors < 1 || colors > 4 || ![1, 2, 4, 8, 16].includes(bits) || columns < 1 || columns > 10_000 || Math.ceil(colors * bits * columns / 8) > 80_000) fail("LIMIT");
    }
    if (image) {
      const width = item.dict.lookup(PDFName.of("Width")), height = item.dict.lookup(PDFName.of("Height"));
      if (!(width instanceof PDFNumber && height instanceof PDFNumber) || width.asNumber() <= 0 || height.asNumber() <= 0 || width.asNumber() * height.asNumber() > 25_000_000) fail("LIMIT");
      // Text extraction does not decode raster image codecs. A chain containing
      // an opaque codec would hide additional inflation and is refused.
      if (filters.length === 1 && ["DCTDecode", "JPXDecode", "CCITTFaxDecode", "JBIG2Decode"].includes(filters[0])) continue;
    }
    if (filters.some(value => !["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"].includes(value))) fail("INVALID");
    const length = decodePDFRawStream(item).decode().byteLength;
    decoded += length;
    if (length > maxStream || decoded > maxDecoded) fail("LIMIT");
    streamLengths.set(item, length);
  }
  const pages = doc.getPages();
  if (!pages.length || pages.length > 100) fail("LIMIT");
  let pageBytes = 0;
  for (const page of pages) {
    const contents = page.node.Contents();
    const streams = contents === undefined ? [] : contents instanceof PDFArray ? contents.asArray().map(value => doc.context.lookup(value)) : [contents];
    for (const stream of streams) {
      if (!streamLengths.has(stream)) fail("INVALID");
      pageBytes += streamLengths.get(stream) + 1;
      if (pageBytes > maxDecoded) fail("LIMIT");
    }
  }
}

async function extractPdf(bytes) {
  await preflightPdf(bytes);
  const pdfjs = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false, useWorkerFetch: false, useWasm: false,
    disableFontFace: true, useSystemFonts: false, stopAtErrors: true, verbosity: 0, enableXfa: false,
    disableAutoFetch: true, disableStream: true, disableRange: true, maxImageSize: 25_000_000 });
  let doc;
  try {
    doc = await task.promise;
    if (!doc.numPages || doc.numPages > 100) fail("LIMIT");
    const pages = [];
    let length = 0, hasText = false, hasEmptyPages = false;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const text = await page.getTextContent({ disableNormalization: false });
      if (text.items.length > 40_000) fail("LIMIT");
      let content = "";
      for (const item of text.items) {
        if (typeof item.str !== "string") continue;
        content += item.str + (item.hasEOL ? "\n" : " ");
        if (content.length + length > MAX_TEXT) fail("LIMIT");
      }
      content = clean(content).replace(/[ \t]+\n/g, "\n").trim();
      hasText ||= !!content;
      hasEmptyPages ||= !content;
      const pageText = `--- Seite ${pageNumber} ---\n${content}`;
      length += pageText.length + 2;
      if (length > MAX_TEXT) fail("LIMIT");
      pages.push(pageText);
      page.cleanup();
    }
    return { content: hasText ? pages.join("\n\n") : "", needsOcr: hasEmptyPages };
  } finally { await task.destroy(); }
}

function parseXml(bytes, onOpen = () => {}, onClose = () => {}, onText = () => {}) {
  const { SaxesParser } = require("saxes");
  let xml;
  try { xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("INVALID"); }
  let depth = 0, elements = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => fail("EXTERNAL"));
  parser.on("error", () => fail("INVALID"));
  parser.on("opentag", node => { if (++depth > 128 || ++elements > 100_000) fail("LIMIT"); onOpen(node); });
  parser.on("closetag", node => { onClose(node); depth--; });
  parser.on("text", onText); parser.on("cdata", onText);
  parser.write(xml).close();
}

async function extractDocx(bytes) {
  const yauzl = require("yauzl");
  const parts = new Map();
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      let count = 0, total = 0, compressed = 0, xmlBytes = 0, done = false;
      const names = new Set();
      const abort = error => { if (done) return; done = true; zip.close(); reject(error); };
      zip.on("error", abort);
      zip.on("end", () => { if (!done) { done = true; resolve(); } });
      zip.on("entry", entry => {
        try {
          const name = entry.fileName;
          if (++count > 512) fail("LIMIT");
          if (name.length > 512 || names.has(name) || /[\u0000-\u001f\\]/.test(name) || name.startsWith("/") || name.split("/").includes("..")) fail("INVALID");
          names.add(name);
          if ((entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)) fail("ENCRYPTED");
          if ((entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) fail("INVALID");
          total += entry.uncompressedSize; compressed += entry.compressedSize;
          if (entry.uncompressedSize > MAX_ZIP_BYTES || total > MAX_ZIP_BYTES || compressed > bytes.byteLength || entry.uncompressedSize > Math.max(1, entry.compressedSize) * 100) fail("LIMIT");
          if (/vbaProject|activeX|embeddings\//i.test(name)) fail("EXTERNAL");
          if (name !== "[Content_Types].xml" && !name.endsWith(".rels") && name !== "word/document.xml") return zip.readEntry();
          if (entry.uncompressedSize > MAX_XML || (xmlBytes += entry.uncompressedSize) > 8 * 1024 * 1024) fail("LIMIT");
          zip.openReadStream(entry, (error, stream) => {
            if (error) return abort(error);
            const chunks = [];
            let length = 0;
            stream.on("error", abort);
            stream.on("data", chunk => {
              length += chunk.length;
              if (length > MAX_XML || length > entry.uncompressedSize) { stream.destroy(); return abort(new Error("LIMIT")); }
              chunks.push(chunk);
            });
            stream.on("end", () => { if (!done) { parts.set(name, Buffer.concat(chunks)); zip.readEntry(); } });
          });
        } catch (error) { abort(error); }
      });
      zip.readEntry();
    });
  });
  if (!parts.has("[Content_Types].xml") || !parts.has("word/document.xml") || !parts.has("_rels/.rels")) fail("INVALID");
  let documentType = false, mainRelationship = false;
  parseXml(parts.get("[Content_Types].xml"), node => {
    if (node.uri !== "http://schemas.openxmlformats.org/package/2006/content-types") fail("INVALID");
    const attrs = Object.fromEntries(Object.values(node.attributes).map(attr => [attr.local, attr.value]));
    if (/macroEnabled|vbaProject|activeX|oleObject/i.test(attrs.ContentType || "")) fail("EXTERNAL");
    if (node.local === "Override" && attrs.PartName === "/word/document.xml" && attrs.ContentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml") documentType = true;
  });
  for (const [name, data] of parts) if (name.endsWith(".rels")) parseXml(data, node => {
    if (node.uri !== "http://schemas.openxmlformats.org/package/2006/relationships") fail("INVALID");
    const attrs = Object.fromEntries(Object.values(node.attributes).map(attr => [attr.local, attr.value]));
    if (node.local !== "Relationship") return;
    const target = attrs.Target || "";
    if ((attrs.TargetMode && attrs.TargetMode !== "Internal") || /^[a-z][a-z\d+.-]*:|^\/\//i.test(target) || target.includes("\\") || target.split("/").includes("..")) fail("EXTERNAL");
    if (/\/aFChunk$|\/oleObject$|\/attachedTemplate$|\/control$/i.test(attrs.Type || "")) fail("EXTERNAL");
    if (name === "_rels/.rels" && /\/officeDocument$/.test(attrs.Type || "") && ["word/document.xml", "/word/document.xml"].includes(target)) mainRelationship = true;
  });
  if (!documentType || !mainRelationship) fail("INVALID");
  const wml = new Set(["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]);
  let content = "", inText = 0, inBody = 0, deleted = 0, hasDocument = false, hasBody = false, firstTag = true, cells = 0;
  const append = value => { content += value; if (content.length > MAX_TEXT) fail("LIMIT"); };
  parseXml(parts.get("word/document.xml"), node => {
    if (firstTag) {
      firstTag = false;
      if (!wml.has(node.uri) || node.local !== "document") fail("INVALID");
    }
    if (!wml.has(node.uri)) return;
    if (node.local === "document") hasDocument = true;
    if (node.local === "body") { if (hasBody) fail("INVALID"); hasBody = true; inBody++; }
    if (node.local === "del") deleted++;
    if (!inBody || deleted) return;
    if (["altChunk", "object", "control"].includes(node.local)) fail("EXTERNAL");
    if (node.local === "t") inText++;
    if (node.local === "tab") append("\t");
    if (["br", "cr"].includes(node.local)) append("\n");
    if (node.local === "tr") cells = 0;
    if (node.local === "tc" && cells++) append("\t");
  }, node => {
    if (!wml.has(node.uri)) return;
    if (node.local === "t" && inText) inText--;
    if (inBody && !deleted && ["p", "tr"].includes(node.local)) append("\n");
    if (node.local === "del") deleted--;
    if (node.local === "body") inBody--;
  }, text => { if (inText && inBody && !deleted) append(text); });
  if (!hasDocument || !hasBody) fail("INVALID");
  return clean(content).replace(/\n{3,}/g, "\n\n").trim();
}

async function validateImage(bytes, mimeType) {
  const sharp = require("sharp");
  const image = sharp(bytes, { limitInputPixels: 25_000_000, failOn: "warning", pages: 1 });
  const metadata = await image.metadata();
  const expected = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" }[mimeType];
  if (metadata.format !== expected || !metadata.width || !metadata.height || (metadata.pages || 1) > 1) fail("INVALID");
  if (metadata.width > 10_000 || metadata.height > 10_000 || metadata.width * metadata.height > 25_000_000) fail("LIMIT");
  await image.stats(); // Decode to reject a correct header attached to corrupt raster data.
  return "";
}

(async () => {
  const { bytes, format, mimeType } = workerData;
  const result = format === "pdf" ? await extractPdf(bytes) : format === "docx" ? await extractDocx(bytes) : await validateImage(bytes, mimeType);
  const content = typeof result === "string" ? result : result.content;
  if (content.length > MAX_TEXT) fail("LIMIT");
  parentPort.postMessage({ ok: true, content, needsOcr: typeof result === "object" && result.needsOcr });
})().catch(error => {
  const message = String(error?.message || "");
  const code = ["LIMIT", "EXTERNAL", "ENCRYPTED"].includes(message) ? message : /encrypted|password/i.test(message) ? "ENCRYPTED" : "INVALID";
  parentPort.postMessage({ ok: false, code });
});
