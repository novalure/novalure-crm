/* Node-only, separately traced worker. No credentials, network calls or document rewrites. */
/* eslint-disable @typescript-eslint/no-require-imports -- The isolated worker is a plain CommonJS Node entrypoint. */
const { parentPort, workerData } = require("node:worker_threads");
const { PDFDocument, PDFDict, PDFArray, PDFName, PDFRef, PDFRawStream, PDFString, PDFHexString, PDFNumber } = require("pdf-lib");
// pdf-lib is pinned: bound decompression BEFORE parsing compressed object streams.
// Worker heap limits alone do not bound externally allocated Uint8Array buffers.
const DecodeStream = require("pdf-lib/cjs/core/streams/DecodeStream.js").default;
const { decodePDFRawStream } = require("pdf-lib/cjs/core/streams/decode.js");
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_DECODED_BYTES = 48 * 1024 * 1024;
const supportedFilters = new Set(["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"]);
// These single image encodings are copied without decoding by pdf-lib. Never
// permit them in a filter chain: a preceding Flate stream could still expand.
const opaqueImageFilters = new Set(["DCTDecode", "JPXDecode", "CCITTFaxDecode", "JBIG2Decode"]);
const originalEnsureBuffer = DecodeStream.prototype.ensureBuffer;
let allocatedDecodedBytes = 0;
DecodeStream.prototype.ensureBuffer = function (requested) {
  if (!Number.isSafeInteger(requested) || requested < 0 || requested > MAX_STREAM_BYTES || this.minBufferLength > MAX_STREAM_BYTES) throw Error("PDF_LIMIT");
  const previous = this.buffer.length;
  const result = originalEnsureBuffer.call(this, requested);
  allocatedDecodedBytes += Math.max(0, this.buffer.length - previous);
  if (allocatedDecodedBytes > MAX_TOTAL_DECODED_BYTES) throw Error("PDF_LIMIT");
  return result;
};
const forbiddenKeys = new Set(["JavaScript", "JS", "OpenAction", "AA", "AcroForm", "XFA", "EmbeddedFiles", "EF", "AF", "Collection", "RichMediaContent", "RichMediaSettings", "Encrypt"]);
const dangerousActions = new Set(["JavaScript", "Launch", "GoToR", "GoToE", "Rendition", "Movie", "Sound", "ImportData", "SubmitForm", "ResetForm", "Hide", "SetOCGState", "Named", "Trans", "GoTo3DView"]);
const forbiddenSubtypes = new Set(["RichMedia", "Movie", "Sound", "Screen", "FileAttachment", "3D", "Widget"]);
const name = value => value instanceof PDFName ? value.decodeText() : undefined;
const unsafe = () => { throw Error("PDF_UNSAFE"); };

async function validate() {
  const doc = await PDFDocument.load(workerData.bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false, capNumbers: false });
  if (doc.isEncrypted || doc.context.trailerInfo.Encrypt) unsafe();
  const entries = doc.context.enumerateIndirectObjects();
  if (entries.length > 25000) throw Error("PDF_LIMIT");
  const seen = new Set();
  const decodedLengths = new Map();
  const queue = entries.map(([, value]) => value);
  queue.push(doc.catalog);
  let visits = 0;
  let rawBytes = 0, decodedBytes = 0;
  while (queue.length) {
    const item = queue.pop();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    if (++visits > 150000) throw Error("PDF_LIMIT");
    if (item instanceof PDFRef) {
      const resolved = doc.context.lookup(item);
      if (!resolved) throw Error("PDF_INVALID");
      queue.push(resolved);
    } else if (item instanceof PDFRawStream) {
      rawBytes += item.contents.byteLength;
      if (rawBytes > MAX_STREAM_BYTES) throw Error("PDF_LIMIT");
      const filter = item.dict.lookup(PDFName.of("Filter"));
      const filters = filter === undefined ? [] : filter instanceof PDFName ? [filter.decodeText()] :
        filter instanceof PDFArray && filter.size() <= 5 ? filter.asArray().map(entry => name(doc.context.lookup(entry))) : [undefined];
      const opaqueImage = name(item.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)) === "Image" &&
        filters.length === 1 && opaqueImageFilters.has(filters[0]);
      if (!opaqueImage) {
        if (filters.some(value => !supportedFilters.has(value))) throw Error("PDF_INVALID");
        // Loading a PDF does not decode its page/form/font streams. Exercise
        // the same decoder used later by embedPage inside this bounded worker.
        const length = decodePDFRawStream(item).decode().byteLength;
        decodedBytes += length;
        if (length > MAX_STREAM_BYTES || decodedBytes > MAX_TOTAL_DECODED_BYTES) throw Error("PDF_LIMIT");
        decodedLengths.set(item, length);
      }
      queue.push(item.dict);
    } else if (item instanceof PDFArray) {
      if (item.size() > 25000) throw Error("PDF_LIMIT");
      for (let index = 0; index < item.size(); index++) queue.push(item.get(index));
    } else if (item instanceof PDFDict) {
      for (const [key, value] of item.entries()) {
        if (forbiddenKeys.has(key.decodeText())) unsafe();
        queue.push(value);
      }
      const type = name(item.lookupMaybe(PDFName.of("Type"), PDFName));
      const subtype = name(item.lookupMaybe(PDFName.of("Subtype"), PDFName));
      if (["Filespec", "EmbeddedFile"].includes(type) || forbiddenSubtypes.has(subtype)) unsafe();
      const action = name(item.lookupMaybe(PDFName.of("S"), PDFName));
      if (dangerousActions.has(action)) unsafe();
      if (type === "Action" && !["URI", "GoTo"].includes(action)) unsafe();
      if (action === "URI") {
        const target = item.lookup(PDFName.of("URI"));
        if (!(target instanceof PDFString || target instanceof PDFHexString)) unsafe();
        const value = target.decodeText();
        if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) unsafe();
        const url = new URL(value);
        if (!["https:", "mailto:", "tel:"].includes(url.protocol) || url.username || url.password) unsafe();
      }
      if (["URI", "GoTo"].includes(action) && item.has(PDFName.of("Next"))) unsafe();
      if (subtype === "Image") {
        const width = item.lookup(PDFName.of("Width"), PDFNumber).asNumber();
        const height = item.lookup(PDFName.of("Height"), PDFNumber).asNumber();
        if (![width, height].every(x => Number.isSafeInteger(x) && x > 0 && x <= 16384) || width * height > 40_000_000) throw Error("PDF_LIMIT");
      }
    }
  }
  // Traversal and inherited page boxes are also inside the bounded worker.
  const pages = doc.getPages();
  if (!pages.length || pages.length > 100) throw Error("PDF_LIMIT");
  let pageContentBytes = 0;
  for (const page of pages) {
    const { width, height } = page.getSize();
    if (![width, height].every(x => Number.isFinite(x) && x > 0 && x <= 14400)) throw Error("PDF_INVALID");
    const contents = page.node.Contents();
    const streams = contents === undefined ? [] : contents instanceof PDFArray ? contents.asArray().map(entry => doc.context.lookup(entry)) : [contents];
    for (const stream of streams) {
      // Count every reference, including repetitions and reuse across pages.
      // embedPage concatenates/decompresses each occurrence, not each unique
      // object. An image-only codec cannot be used as a page content stream.
      const length = decodedLengths.get(stream);
      if (length === undefined) throw Error("PDF_INVALID");
      pageContentBytes += length + 1;
      if (pageContentBytes > MAX_TOTAL_DECODED_BYTES) throw Error("PDF_LIMIT");
    }
  }
  return pages.length;
}
validate().then(pageCount => parentPort.postMessage({ ok: true, pageCount })).catch(error => {
  const message = String(error?.message ?? "");
  parentPort.postMessage({ ok: false, code: message === "PDF_UNSAFE" || /encrypted/i.test(message) ? "PDF_UNSAFE" : "PDF_INVALID" });
});
