import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { KnowledgeCenterError } from "../src/lib/knowledge-center/policy";

// Resolve the SDK's installed transport rather than adding another dependency.
// No live Blob requests are possible: every GET needs an exact interceptor.
const require = createRequire(import.meta.url);
const blobRequire = createRequire(require.resolve("@vercel/blob"));
const sdkUndici = blobRequire("undici");
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = sdkUndici;

test("private document finalization verifies actual decoded bytes through the installed Blob GET", { timeout: 20_000 }, async (t) => {
  const keys = ["NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN", "BLOB_PRIVATE_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const syntheticToken = "vercel_blob_rw_syntheticframing_SYNTHETICONLY";
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN: syntheticToken });
  const previousDispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const provider = agent.get("https://syntheticframing.private.blob.vercel-storage.com");
  const nativeFetch = sdkUndici.fetch as typeof fetch;
  const observed: { length: string | null; encoding: string | null; contentType: string | null; cancelled: () => number }[] = [];
  const fetchMock = t.mock.method(sdkUndici, "fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await nativeFetch(...args);
    const cancel = response.body ? t.mock.method(response.body, "cancel") : null;
    observed.push({ length: response.headers.get("content-length"), encoding: response.headers.get("content-encoding"), contentType: response.headers.get("content-type"), cancelled: () => cancel?.mock.calls.length ?? 0 });
    return response;
  });
  const bytes = Buffer.from("SYNTHETIC private Studio document. No customer information.\n".repeat(60), "utf8");
  const session = { workspaceId: randomUUID(), userId: randomUUID() };
  try {
    const upload = await import("../src/lib/knowledge-center/document-upload");
    const metadata = { areaId: randomUUID(), name: "SYNTHETIC framing document", fileName: "synthetic-framing.txt", mimeType: "text/plain", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const issued = await upload.createKnowledgeDocumentUploadTicket(session, metadata);
    const verified = upload.verifyKnowledgeDocumentUploadTicket(session, issued.ticket);
    assert.deepEqual(verified.metadata, metadata);

    function reply(body: Buffer, headers: Record<string, string>) {
      provider.intercept({ method: "GET", path: "/" + verified.pathname + "?cache=0", headers: { authorization: "Bearer " + syntheticToken } }).reply(200, body, { headers });
    }
    async function accept(body: Buffer, headers: Record<string, string>) {
      reply(body, headers);
      const file = await upload.readKnowledgeDocumentUpload(verified);
      // The production function reaches its existing opaque private-file binding
      // only after this SDK stream has passed exact length and SHA-256 checks.
      assert.equal(file.name, metadata.fileName);
      assert.equal(file.type, metadata.mimeType);
      assert.equal(file.size, metadata.sizeBytes);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      agent.assertNoPendingInterceptors();
      return observed.at(-1)!;
    }
    function code(expected: string) {
      return (error: unknown) => error instanceof KnowledgeCenterError && error.code === expected;
    }

    await t.test("identity response with exact Content-Length retains the original success path", async () => {
      const response = await accept(bytes, { "content-type": "text/plain; charset=utf-8", "content-length": String(bytes.length) });
      assert.equal(response.length, String(bytes.length));
      assert.equal(response.encoding, null);
    });

    await t.test("chunked response without Content-Length is accepted only after exact stream verification", async () => {
      const response = await accept(bytes, { "content-type": "text/plain", "transfer-encoding": "chunked" });
      // Blob 2.8 derives blob.size=0 from this absent transfer header.
      assert.equal(response.length, null);
    });

    await t.test("gzip transfer length differs while native fetch decodes the exact authorized document", async () => {
      const compressed = gzipSync(bytes);
      assert.notEqual(compressed.length, bytes.length);
      const response = await accept(compressed, { "content-type": "text/plain; charset=utf-8", "content-encoding": "gzip", "content-length": String(compressed.length) });
      assert.equal(response.encoding, "gzip");
      assert.equal(response.length, String(compressed.length));
      assert.notEqual(Number(response.length), metadata.sizeBytes);
    });

    await t.test("wrong MIME type still rejects and cancels the private response", async () => {
      reply(bytes, { "content-type": "application/pdf", "content-length": String(bytes.length) });
      await assert.rejects(upload.readKnowledgeDocumentUpload(verified), code("DOCUMENT_CHANGED"));
      assert.equal(observed.at(-1)!.cancelled(), 1);
      agent.assertNoPendingInterceptors();
    });

    await t.test("a shorter actual stream is rejected even with internally consistent HTTP framing", async () => {
      const shorter = bytes.subarray(0, bytes.length - 1);
      reply(shorter, { "content-type": "text/plain", "content-length": String(shorter.length) });
      await assert.rejects(upload.readKnowledgeDocumentUpload(verified), code("DOCUMENT_CHANGED"));
      agent.assertNoPendingInterceptors();
    });

    await t.test("same-length altered bytes still fail the signed SHA-256", async () => {
      const altered = Buffer.from(bytes);
      altered[0] ^= 1;
      reply(altered, { "content-type": "text/plain", "content-length": String(altered.length) });
      await assert.rejects(upload.readKnowledgeDocumentUpload(verified), code("DOCUMENT_CHANGED"));
      agent.assertNoPendingInterceptors();
    });

    await t.test("a chunked overrun still fails the authorized stream-size limit", async () => {
      reply(Buffer.concat([bytes, Buffer.from([0])]), { "content-type": "text/plain", "transfer-encoding": "chunked" });
      await assert.rejects(upload.readKnowledgeDocumentUpload(verified), code("PAYLOAD_TOO_LARGE"));
      agent.assertNoPendingInterceptors();
    });

    await t.test("a copied unverified upload object cannot reach the provider", async () => {
      const before = fetchMock.mock.calls.length;
      await assert.rejects(upload.readKnowledgeDocumentUpload({ ...verified }), code("INVALID_UPLOAD"));
      assert.equal(fetchMock.mock.calls.length, before);
    });
  } finally {
    fetchMock.mock.restore();
    setGlobalDispatcher(previousDispatcher);
    await agent.close();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
