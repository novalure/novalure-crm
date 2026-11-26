import assert from "node:assert/strict";
import test from "node:test";
import { classifyPropertyUploadResponse, isConfirmedPropertyAttachment, PropertyUploadError, shouldSetPropertyCover, uploadPropertyBatch } from "../src/lib/property-batch-upload";

test("a prior floor plan does not prevent the first photo from becoming the cover", () => {
  assert.equal(shouldSetPropertyCover([{ isCover: false }], false, 0), true);
  assert.equal(shouldSetPropertyCover([{ isCover: false }], true, 0), false);
  assert.equal(shouldSetPropertyCover([{ isCover: true }], false, 0), false);
  assert.equal(shouldSetPropertyCover([], false, 1), false);
});

test("uploads serially, records per-file failures, and preserves positions after failures", async () => {
  const calls: string[] = [];
  const progress: number[] = [];
  let active = 0;
  const result = await uploadPropertyBatch(["a", "bad", "c"], async (file, attached) => {
    assert.equal(active++, 0);
    calls.push(`${file}:${attached}`);
    await Promise.resolve();
    active--;
    if (file === "bad") throw new PropertyUploadError("unsupported");
  }, completed => progress.push(completed));
  assert.deepEqual(calls, ["a:0", "bad:1", "c:1"]);
  assert.deepEqual(result, { attached: 2, failures: [{ file: "bad", message: "unsupported" }], notAttempted: 0 });
  assert.deepEqual(progress, [1, 2, 3]);
});

test("unconfirmed upload responses stop instead of risking duplicate uploads", () => {
  assert.equal(classifyPropertyUploadResponse(200, undefined, undefined), "uncertain");
  assert.equal(classifyPropertyUploadResponse(502, undefined, undefined), "uncertain");
  assert.equal(classifyPropertyUploadResponse(504, undefined, undefined), "uncertain");
  assert.equal(classifyPropertyUploadResponse(415, undefined, undefined), "continue");
  assert.equal(classifyPropertyUploadResponse(429, undefined, undefined), "stop");
  assert.equal(classifyPropertyUploadResponse(200, "asset-id", undefined), "confirmed");
});

test("only an explicit persisted attachment receipt confirms success", () => {
  assert.equal(isConfirmedPropertyAttachment({ persisted: true, data: { id: "id" } }), true);
  assert.equal(isConfirmedPropertyAttachment({ persisted: false, data: { id: "id" } }), false);
  assert.equal(isConfirmedPropertyAttachment({ persisted: true }), false);
  assert.equal(isConfirmedPropertyAttachment(null), false);
});

test("unexpected exceptions stop the batch because the write outcome may be unknown", async () => {
  const attempted: string[] = [];
  const result = await uploadPropertyBatch(["a", "b"], async file => {
    attempted.push(file);
    throw new Error("unexpected");
  }, () => {});
  assert.deepEqual(attempted, ["a"]);
  assert.equal(result.notAttempted, 1);
});

test("a 117-photo selection is processed completely in order", async () => {
  const files = Array.from({ length: 117 }, (_, index) => index);
  const attached: number[] = [];
  const result = await uploadPropertyBatch(files, async file => { attached.push(file); }, () => {});
  assert.deepEqual(attached, files);
  assert.deepEqual(result, { attached: 117, failures: [], notAttempted: 0 });
});

test("stops on a terminal failure and identifies files not attempted", async () => {
  const calls: string[] = [];
  const result = await uploadPropertyBatch(["a", "b", "c"], async file => {
    calls.push(file);
    if (file === "b") throw new PropertyUploadError("permission denied", true);
  }, () => {});
  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual(result, { attached: 1, failures: [{ file: "b", message: "permission denied" }], notAttempted: 1 });
});
