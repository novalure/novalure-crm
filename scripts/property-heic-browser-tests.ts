import assert from "node:assert/strict";
import test from "node:test";
import { isHeicImage, preparePropertyImageUpload, PropertyHeicConversionError } from "../src/lib/property-heic-browser";

const heic = () => new File(["example"], "Photo.HEIC", { type: "image/heic", lastModified: 123 });

test("only HEIC and HEIF filenames with compatible content types are candidates", () => {
  assert.equal(isHeicImage(heic()), true);
  assert.equal(isHeicImage({ name: "image.heif", type: "" }), true);
  assert.equal(isHeicImage({ name: "image.jpg", type: "image/heic" }), false);
  assert.equal(isHeicImage({ name: "image.heic", type: "image/jpeg" }), false);
});

test("non-HEIC uploads are unchanged and input size is bounded", async () => {
  const file = new File(["jpeg"], "image.jpg", { type: "image/jpeg" });
  assert.equal(await preparePropertyImageUpload(file), file);
  const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "image.heic", { type: "image/heic" });
  await assert.rejects(preparePropertyImageUpload(big), /10 MB/);
});

test("missing Worker fails safely before any network upload", async () => {
  await assert.rejects(preparePropertyImageUpload(heic()), PropertyHeicConversionError);
});

test("native decoding remains available when Worker is unsupported", async () => {
  const previousWorker = globalThis.Worker, previousBitmap = globalThis.createImageBitmap, previousDocument = globalThis.document;
  let closed = 0, white = false;
  Object.assign(globalThis, {
    Worker: undefined,
    createImageBitmap: async () => ({ width: 2, height: 3, close() { closed++; } }),
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() { white = true; }, drawImage() {} }), toBlob: (cb: (value: Blob) => void) => cb(new Blob(["jpeg"], { type: "image/jpeg" })) }) },
  });
  try {
    const result = await preparePropertyImageUpload(heic());
    assert.equal(result.type, "image/jpeg");
    assert.equal(closed, 1);
    assert.equal(white, true);
  } finally {
    globalThis.Worker = previousWorker;
    globalThis.createImageBitmap = previousBitmap;
    globalThis.document = previousDocument;
  }
});

test("native fallback rejects oversized images and releases the bitmap", async () => {
  const previousWorker = globalThis.Worker, previousBitmap = globalThis.createImageBitmap, previousDocument = globalThis.document;
  let closed = 0;
  Object.assign(globalThis, { Worker: undefined, document: {}, createImageBitmap: async () => ({ width: 8000, height: 8000, close() { closed++; } }) });
  try {
    await assert.rejects(preparePropertyImageUpload(heic()), PropertyHeicConversionError);
    assert.equal(closed, 1);
  } finally {
    globalThis.Worker = previousWorker;
    globalThis.createImageBitmap = previousBitmap;
    globalThis.document = previousDocument;
  }
});

test("unsupported worker capability falls back natively after cleanup", async () => {
  const previousWorker = globalThis.Worker, previousBitmap = globalThis.createImageBitmap, previousDocument = globalThis.document;
  let terminated = 0, closed = 0;
  class UnsupportedWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror = null;
    onmessageerror = null;
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: { ok: false, code: "BROWSER_UNSUPPORTED" } })); }
    terminate() { terminated++; }
  }
  Object.assign(globalThis, {
    Worker: UnsupportedWorker,
    createImageBitmap: async () => ({ width: 2, height: 3, close() { closed++; } }),
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (cb: (value: Blob) => void) => cb(new Blob(["jpeg"], { type: "image/jpeg" })) }) },
  });
  try {
    assert.equal((await preparePropertyImageUpload(heic())).type, "image/jpeg");
    assert.equal(terminated, 1);
    assert.equal(closed, 1);
  } finally {
    globalThis.Worker = previousWorker;
    globalThis.createImageBitmap = previousBitmap;
    globalThis.document = previousDocument;
  }
});

test("worker startup failure falls back natively, after terminating the worker", async () => {
  const previousWorker = globalThis.Worker, previousBitmap = globalThis.createImageBitmap, previousDocument = globalThis.document;
  let terminated = 0, closed = 0;
  class BrokenWorker {
    onmessage = null;
    onerror: (() => void) | null = null;
    onmessageerror = null;
    postMessage() { queueMicrotask(() => this.onerror?.()); }
    terminate() { terminated++; }
  }
  Object.assign(globalThis, {
    Worker: BrokenWorker,
    createImageBitmap: async () => ({ width: 2, height: 3, close() { closed++; } }),
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (cb: (value: Blob) => void) => cb(new Blob(["jpeg"], { type: "image/jpeg" })) }) },
  });
  try {
    assert.equal((await preparePropertyImageUpload(heic())).type, "image/jpeg");
    assert.equal(terminated, 1);
    assert.equal(closed, 1);
  } finally { globalThis.Worker = previousWorker; globalThis.createImageBitmap = previousBitmap; globalThis.document = previousDocument; }
});

test("decoder crash after readiness is not retried through native decoding", async () => {
  const previousWorker = globalThis.Worker, previousBitmap = globalThis.createImageBitmap;
  let nativeCalls = 0, terminated = 0;
  class FailedDecoder {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror = null;
    postMessage() { queueMicrotask(() => { this.onmessage?.({ data: { type: "READY" } }); this.onerror?.(); }); }
    terminate() { terminated++; }
  }
  globalThis.Worker = FailedDecoder as unknown as typeof Worker;
  globalThis.createImageBitmap = (() => { nativeCalls++; throw new Error("must not run"); }) as typeof createImageBitmap;
  try {
    await assert.rejects(preparePropertyImageUpload(heic()), PropertyHeicConversionError);
    assert.equal(nativeCalls, 0);
    assert.equal(terminated, 1);
  } finally { globalThis.Worker = previousWorker; globalThis.createImageBitmap = previousBitmap; }
});

test("worker startup timeout falls back to native decoding", async t => {
  const previousWorker = globalThis.Worker, previousBitmap = globalThis.createImageBitmap, previousDocument = globalThis.document;
  let terminated = 0, closed = 0;
  class StuckStartup {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    postMessage() {}
    terminate() { terminated++; }
  }
  Object.assign(globalThis, {
    Worker: StuckStartup,
    createImageBitmap: async () => ({ width: 2, height: 3, close() { closed++; } }),
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (cb: (value: Blob) => void) => cb(new Blob(["jpeg"], { type: "image/jpeg" })) }) },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = preparePropertyImageUpload(heic());
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(15_000);
    assert.equal((await pending).type, "image/jpeg");
    assert.equal(terminated, 1);
    assert.equal(closed, 1);
  } finally { globalThis.Worker = previousWorker; globalThis.createImageBitmap = previousBitmap; globalThis.document = previousDocument; }
});

test("decoder timeout after readiness does not use native decoding", async t => {
  const previousWorker = globalThis.Worker, previousBitmap = globalThis.createImageBitmap;
  let terminated = 0, nativeCalls = 0;
  class StuckDecoder {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror = null;
    onmessageerror = null;
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: { type: "READY" } })); }
    terminate() { terminated++; }
  }
  globalThis.Worker = StuckDecoder as unknown as typeof Worker;
  globalThis.createImageBitmap = (() => { nativeCalls++; throw new Error("must not run"); }) as typeof createImageBitmap;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = preparePropertyImageUpload(heic());
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(15_000);
    await assert.rejects(pending, PropertyHeicConversionError);
    assert.equal(terminated, 1);
    assert.equal(nativeCalls, 0);
  } finally { globalThis.Worker = previousWorker; globalThis.createImageBitmap = previousBitmap; }
});

test("native timeout releases a bitmap that arrives after the deadline", async t => {
  const previousWorker = globalThis.Worker, previousBitmap = globalThis.createImageBitmap, previousDocument = globalThis.document;
  let closed = 0, finishBitmap: ((bitmap: ImageBitmap) => void) | undefined;
  Object.assign(globalThis, { Worker: undefined, document: {}, createImageBitmap: () => new Promise<ImageBitmap>(resolve => { finishBitmap = resolve; }) });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = preparePropertyImageUpload(heic());
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(15_000);
    await assert.rejects(pending, PropertyHeicConversionError);
    finishBitmap?.({ width: 2, height: 3, close() { closed++; } } as ImageBitmap);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, 1);
  } finally { globalThis.Worker = previousWorker; globalThis.createImageBitmap = previousBitmap; globalThis.document = previousDocument; }
});

test("native timeout releases a bitmap if JPEG encoding never responds", async t => {
  const previousWorker = globalThis.Worker, previousBitmap = globalThis.createImageBitmap, previousDocument = globalThis.document;
  let closed = 0;
  Object.assign(globalThis, {
    Worker: undefined,
    createImageBitmap: async () => ({ width: 2, height: 3, close() { closed++; } }),
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob() {} }) },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = preparePropertyImageUpload(heic());
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(15_000);
    await assert.rejects(pending, PropertyHeicConversionError);
    assert.equal(closed, 1);
  } finally { globalThis.Worker = previousWorker; globalThis.createImageBitmap = previousBitmap; globalThis.document = previousDocument; }
});

test("successful worker conversion returns JPEG and terminates the worker", async () => {
  const previous = globalThis.Worker;
  let terminated = 0;
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror = null;
    onmessageerror = null;
    constructor(url: string) { assert.equal(url, "/heic-decoder/worker.js"); }
    postMessage(buffer: ArrayBuffer) {
      assert.equal(buffer.byteLength, 7);
      queueMicrotask(() => this.onmessage?.({ data: { ok: true, blob: new Blob(["jpeg"], { type: "image/jpeg" }) } }));
    }
    terminate() { terminated++; }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const result = await preparePropertyImageUpload(heic());
    assert.equal(result.name, "Photo.jpg");
    assert.equal(result.type, "image/jpeg");
    assert.equal(result.lastModified, 123);
    assert.equal(terminated, 1);
  } finally { globalThis.Worker = previous; }
});

test("failed worker returns a safe error and terminates", async () => {
  const previous = globalThis.Worker;
  let terminated = 0;
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror = null;
    onmessageerror = null;
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: { ok: false, code: "private decoder detail" } })); }
    terminate() { terminated++; }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    await assert.rejects(preparePropertyImageUpload(heic()), error =>
      error instanceof PropertyHeicConversionError && !error.message.includes("private decoder detail"));
    assert.equal(terminated, 1);
  } finally { globalThis.Worker = previous; }
});

test("unresponsive worker is terminated when the deadline expires", async t => {
  const previous = globalThis.Worker;
  let terminated = 0;
  class StuckWorker {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    postMessage() {}
    terminate() { terminated++; }
  }
  globalThis.Worker = StuckWorker as unknown as typeof Worker;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = preparePropertyImageUpload(heic());
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(15_000);
    await assert.rejects(pending, PropertyHeicConversionError);
    assert.equal(terminated, 1);
  } finally { globalThis.Worker = previous; }
});
