import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { finalizeAfterPrivateDocumentUpload } from "../src/lib/knowledge-center/document-upload-transport";

test("a stalled provider aborts with AbortError at the deadline and never finalizes", async () => {
  let signal: AbortSignal | undefined, finalizations = 0;
  await assert.rejects(finalizeAfterPrivateDocumentUpload((current) => {
    signal = current;
    return new Promise((_, reject) => current.addEventListener("abort", () => reject(current.reason), { once: true }));
  }, async () => { finalizations += 1; }, 20), /Document upload timed out\. Please retry\./);
  assert.equal(signal?.aborted, true);
  assert.equal(signal?.reason.name, "AbortError");
  assert.equal(finalizations, 0);
});

test("the outer deadline also stops an SDK that ignores abort or rejects late", async () => {
  let rejectProvider!: (reason: Error) => void;
  let finalizations = 0;
  await assert.rejects(finalizeAfterPrivateDocumentUpload(() => new Promise((_, reject) => {
    rejectProvider = reject;
  }), async () => { finalizations += 1; }, 20), /upload timed out/);
  // Promise.race retains its rejection handler after the timeout wins.
  rejectProvider(new Error("SYNTHETIC late provider retry failure"));
  await delay(0);
  assert.equal(finalizations, 0);
});

test("a late successful provider response after timeout cannot finalize", async () => {
  let resolveProvider!: () => void;
  let finalizations = 0;
  await assert.rejects(finalizeAfterPrivateDocumentUpload(() => new Promise<void>((resolve) => {
    resolveProvider = resolve;
  }), async () => { finalizations += 1; }, 20), /upload timed out/);
  resolveProvider();
  await delay(0);
  assert.equal(finalizations, 0);
});

test("successful uploads finalize once and clear the deadline before finalization", async () => {
  let signal: AbortSignal | undefined, uploads = 0, finalizations = 0;
  const result = await finalizeAfterPrivateDocumentUpload(async (current) => {
    signal = current; uploads += 1;
  }, async () => {
    finalizations += 1;
    await delay(35);
    return "SYNTHETIC committed document receipt";
  }, 20);
  assert.equal(result, "SYNTHETIC committed document receipt");
  assert.equal(uploads, 1);
  assert.equal(finalizations, 1);
  assert.equal(signal?.aborted, false);
});

test("an ordinary provider failure clears its timer and never finalizes", async () => {
  let signal: AbortSignal | undefined, finalizations = 0;
  const failure = new Error("SYNTHETIC provider rejects the upload");
  await assert.rejects(finalizeAfterPrivateDocumentUpload(async (current) => {
    signal = current;
    throw failure;
  }, async () => { finalizations += 1; }, 20), (error: unknown) => error === failure);
  await delay(35);
  assert.equal(signal?.aborted, false);
  assert.equal(finalizations, 0);
});
