/* Bounded PDF stream preflight reused from the existing private knowledge worker. */
/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker helper. */
const fail = code => { throw new Error(code); };
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
  // Reject active actions even when a renderer ignores an unknown OpenAction.
  // The original PDF bytes are downloadable, so renderer-only detection is insufficient.
  const forbidden=new Set(['JS','JavaScript','OpenAction','AA','Launch','EmbeddedFiles','RichMedia','AcroForm','XFA','URI','SubmitForm','ImportData','GoToR','GoToE','Collection']);
  let visited=0;
  const inspect=(value,depth=0)=>{
    if(++visited>100000||depth>30)fail('LIMIT');
    if(value instanceof PDFName){if(forbidden.has(value.decodeText()))fail('ACTIVE');return;}
    if(value instanceof PDFRawStream){inspect(value.dict,depth+1);return;}
    if(value instanceof PDFDict){for(const [key,entry] of value.entries()){if(forbidden.has(key.decodeText()))fail('ACTIVE');inspect(entry,depth+1);}return;}
    if(value instanceof PDFArray)for(const entry of value.asArray())inspect(entry,depth+1);
  };
  for(const [,item] of objects)inspect(item);
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
  if (!pages.length || pages.length > 50) fail("LIMIT");
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

module.exports={preflightPdf};
