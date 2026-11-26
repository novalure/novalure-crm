import assert from "node:assert/strict";
import test from "node:test";
import { uploadPropertyBatch } from "../src/lib/property-batch-upload";
import { preparePropertyUploadFile } from "../src/lib/property-upload-preparation";

test("unsupported HEIC is never sent and the next JPEG can be uploaded", async () => {
  const originalBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  Object.assign(globalThis, { createImageBitmap: async () => { throw new Error("unsupported decoder"); }, document: {} });
  const sent: File[] = [];
  const heic = new File(["unavailable"], "photo.heic", { type: "image/heic" });
  const jpeg = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
  try {
    const result = await uploadPropertyBatch([heic, jpeg], async file => {
      const prepared = await preparePropertyUploadFile(file, "media");
      sent.push(prepared); // Represents the first network-write boundary.
    }, () => {});
    assert.equal(result.attached, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /JPEG exportieren/);
    assert.deepEqual(sent, [jpeg]);
  } finally {
    globalThis.createImageBitmap = originalBitmap;
    globalThis.document = originalDocument;
  }
});

test("floor plans use the same conversion gate, and documents remain unchanged", async () => {
  const heic = new File(["heic"], "plan.heic", { type: "image/heic" });
  const originalBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  Object.assign(globalThis, { createImageBitmap: async () => { throw new Error("unsupported decoder"); }, document: {} });
  try {
    await assert.rejects(preparePropertyUploadFile(heic, "floorplan"), /JPEG exportieren/);
    const pdf = new File(["pdf"], "plan.pdf", { type: "application/pdf" });
    assert.equal(await preparePropertyUploadFile(pdf, "document"), pdf);
    assert.equal(await preparePropertyUploadFile(pdf, "floorplan"), pdf);
  } finally {
    globalThis.createImageBitmap = originalBitmap;
    globalThis.document = originalDocument;
  }
});
