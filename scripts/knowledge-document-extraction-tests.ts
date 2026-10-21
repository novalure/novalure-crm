import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFNumber, type PDFObject } from "pdf-lib";
import sharp from "sharp";
import { extractKnowledgeDocument } from "../src/lib/knowledge-center/document-extraction";
import { KnowledgeCenterError } from "../src/lib/knowledge-center/policy";
import { createDocx, createScanPdf, createTextPdf, createZip, DEFAULT_DOCUMENT_XML, DOCX_MIME } from "./lib/knowledge-document-fixtures";

const rejectsCode = (code: string) => (error: unknown) => error instanceof KnowledgeCenterError && error.code === code;
const extractDocx = (bytes: Uint8Array) => extractKnowledgeDocument({ bytes, fileName: "synthetic.docx", mimeType: DOCX_MIME });
const extractPdf = (bytes: Uint8Array) => extractKnowledgeDocument({ bytes, fileName: "synthetic.pdf", mimeType: "application/pdf" });

test("real PDF extraction preserves text and explicit page boundaries", async () => {
  const result = await extractPdf(await createTextPdf());
  assert.equal(result.status, "ready"); assert.equal(result.format, "pdf"); assert.equal(result.message, null);
  assert.match(result.content, /--- Seite 1 ---\nSYNTHETIC knowledge ALPHA/);
  assert.match(result.content, /--- Seite 2 ---\nSYNTHETIC second page BETA/);
});
test("scanned PDF and validated raster images require OCR without invented text", async () => {
  const scan = await extractPdf(await createScanPdf());
  assert.equal(scan.status, "needs_ocr"); assert.equal(scan.content, ""); assert.match(scan.message!, /OCR/);
  for (const [format, mimeType, extension] of [["png", "image/png", "png"], ["jpeg", "image/jpeg", "jpg"], ["webp", "image/webp", "webp"]] as const) {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).toFormat(format).toBuffer();
    const result = await extractKnowledgeDocument({ bytes, fileName: `scan.${extension}`, mimeType });
    assert.equal(result.status, "needs_ocr"); assert.equal(result.format, "image"); assert.equal(result.content, "");
  }
});
test("partially scanned or empty PDF pages preserve partial text and require OCR", async () => {
  const result = await extractPdf(await createTextPdf(["Readable page ALPHA", ""]));
  assert.equal(result.status, "needs_ocr"); assert.match(result.content, /Readable page ALPHA/); assert.match(result.message!, /unvollständig/);
});
test("DOCX extracts actual paragraph and table contents in document order", async () => {
  const result = await extractDocx(createDocx());
  assert.equal(result.status, "ready"); assert.equal(result.format, "docx");
  assert.match(result.content, /^SYNTHETIC paragraph ALPHA\nTable one\n\tTable two/);
  assert.match(result.content, /Final paragraph BETA$/);
  assert.equal(result.content.includes("<w:"), false);
});
test("strict UTF-8 TXT, Markdown, CSV and JSON keep usable text", async () => {
  for (const [fileName, mimeType, text] of [["wissen.txt", "text/plain", "Öffnungszeiten\r\nMontag 09:00"], ["wissen.md", "text/markdown", "# Wissen\nBüro"], ["wissen.csv", "text/csv", "Name,Wert\nBüro,9"], ["wissen.json", "application/json", '{"name":"Büro"}']]) {
    const result = await extractKnowledgeDocument({ bytes: Buffer.from(text), fileName, mimeType });
    assert.equal(result.status, "ready"); assert.equal(result.format, "text"); assert.equal(result.content, text.replaceAll("\r\n", "\n"));
  }
});
test("format spoofing, broken containers, corrupt raster and invalid UTF-8 fail visibly", async () => {
  const cases = [
    { bytes: Buffer.from("not a PDF"), fileName: "fake.pdf", mimeType: "application/pdf" },
    { bytes: Buffer.from("%PDF-1.7\nnot a valid document\n%%EOF"), fileName: "fake.pdf", mimeType: "application/pdf" },
    { bytes: createZip({ "payload.txt": "ZIP is not DOCX" }), fileName: "fake.docx", mimeType: DOCX_MIME },
    { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), fileName: "broken.png", mimeType: "image/png" },
    { bytes: Buffer.from([0xc3, 0x28]), fileName: "broken.txt", mimeType: "text/plain" },
    { bytes: Buffer.from("binary\u0000data"), fileName: "binary.txt", mimeType: "text/plain" },
    { bytes: Buffer.from("text"), fileName: "wrong.pdf", mimeType: "text/plain" },
    { bytes: Buffer.from("{invalid}"), fileName: "bad.json", mimeType: "application/json" },
  ];
  for (const input of cases) await assert.rejects(extractKnowledgeDocument(input), rejectsCode("INVALID_DOCUMENT"));
  await assert.rejects(extractKnowledgeDocument({ bytes: Buffer.from("<svg/>"), fileName: "active.svg", mimeType: "image/svg+xml" }), rejectsCode("UNSUPPORTED_DOCUMENT"));
  await assert.rejects(extractKnowledgeDocument({ bytes: Buffer.from("text"), fileName: "file.txt", mimeType: "constructor" }), rejectsCode("UNSUPPORTED_DOCUMENT"));
});
test("DOCX denies external relationships, XML entities, macros and traversal paths", async () => {
  const external = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="evil" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="http://169.254.169.254/latest/meta-data"/></Relationships>';
  const dtd = DEFAULT_DOCUMENT_XML.replace("?>", '?><!DOCTYPE w:document [<!ENTITY evil SYSTEM "file:///etc/passwd">]>');
  for (const bytes of [createDocx({ relationshipsXml: external }), createDocx({ documentXml: dtd }), createDocx({ additions: { "word/vbaProject.bin": "malicious" } }), createDocx({ additions: { "../escape.xml": "data" } })]) {
    await assert.rejects(extractDocx(bytes), error => error instanceof KnowledgeCenterError && error.code === "INVALID_DOCUMENT");
  }
});
test("ZIP inflation, input, page count and extracted-text limits are enforced", async () => {
  await assert.rejects(extractDocx(createDocx({ additions: { "word/bomb.xml": "A".repeat(1_000_000) } })), rejectsCode("DOCUMENT_LIMIT_EXCEEDED"));
  await assert.rejects(extractKnowledgeDocument({ bytes: new Uint8Array(10 * 1024 * 1024 + 1), fileName: "huge.txt", mimeType: "text/plain" }), rejectsCode("DOCUMENT_LIMIT_EXCEEDED"));
  await assert.rejects(extractKnowledgeDocument({ bytes: Buffer.from("A".repeat(150_001)), fileName: "huge.txt", mimeType: "text/plain" }), rejectsCode("DOCUMENT_LIMIT_EXCEEDED"));
  await assert.rejects(extractPdf(await createTextPdf(Array.from({ length: 101 }, () => "Page"))), rejectsCode("DOCUMENT_LIMIT_EXCEEDED"));
  const tooMuchText = DEFAULT_DOCUMENT_XML.replace("SYNTHETIC paragraph ALPHA", "A".repeat(150_001));
  await assert.rejects(extractDocx(createDocx({ documentXml: tooMuchText, compress: false })), rejectsCode("DOCUMENT_LIMIT_EXCEEDED"));
});
test("compressed PDF streams are bounded before text parsing", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const payload = deflateSync(Buffer.alloc(9 * 1024 * 1024, 32));
  const stream = doc.context.stream(payload, { Filter: PDFName.of("FlateDecode"), Length: PDFNumber.of(payload.length) });
  page.node.set(PDFName.of("Contents"), doc.context.register(stream));
  await assert.rejects(extractPdf(await doc.save()), rejectsCode("DOCUMENT_LIMIT_EXCEEDED"));
});
test("PDF row-predictor allocations cannot bypass stream inflation bounds", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const stream = doc.context.stream(deflateSync(Buffer.from([0, 32])), {
    Filter: PDFName.of("FlateDecode"), DecodeParms: doc.context.obj({ Predictor: 12, Columns: 200_000_000 }),
  });
  page.node.set(PDFName.of("Contents"), doc.context.register(stream));
  await assert.rejects(extractPdf(await doc.save()), rejectsCode("DOCUMENT_LIMIT_EXCEEDED"));
});
test("PDF decoder aliases cannot bypass filter or predictor preflight", async () => {
  // Small inputs prove rejection without allocating hostile predictor buffers.
  for (const key of ["DP", "F", "FFilter", "FDecodeParms", "BPC"]) {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const parameters = doc.context.obj({ Predictor: 12, Columns: 32 });
    const dictionary: Record<string, PDFObject> = { Filter: PDFName.of("FlateDecode") };
    if (key === "BPC") {
      parameters.set(PDFName.of("BPC"), PDFNumber.of(8));
      Object.assign(dictionary, { Subtype: PDFName.of("Image"), Width: PDFNumber.of(1), Height: PDFNumber.of(1), DecodeParms: parameters });
    } else dictionary[key] = key === "F" || key === "FFilter" ? PDFName.of("FlateDecode") : parameters;
    const stream = doc.context.stream(deflateSync(Buffer.from([0, 32])), dictionary);
    page.node.set(PDFName.of("Contents"), doc.context.register(stream));
    await assert.rejects(extractPdf(await doc.save()), rejectsCode("DOCUMENT_LIMIT_EXCEEDED"));
  }
});
