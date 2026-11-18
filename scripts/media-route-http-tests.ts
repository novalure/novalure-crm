import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const asset = { id: assetId, workspaceId, folder: "property", originalName: "preview.txt" };
class StubMediaStoreError extends Error {
  constructor(readonly code: string) { super("Synthetic storage failure"); }
}

test("media GET handlers preserve controlled HTTP errors and private response headers", async (t) => {
  let authenticated = true;
  let publicCalls = 0, workspaceCalls = 0, transactionCalls = 0, contentCalls = 0;
  let publicFailure: Error | null = null;
  let publicAsset: typeof asset | null = null;
  let privateAsset: typeof asset | null = null;
  let accessible = true;
  let content: { body: string; contentType: string; sizeBytes: number } | null = null;
  const moduleUrl = (path: string) => pathToFileURL(resolve(path)).href;
  const mocks = [
    t.mock.module(moduleUrl("src/lib/media-store.ts"), { namedExports: {
      MediaStoreError: StubMediaStoreError,
      async findPublicMediaAsset(token: string) {
        publicCalls++; assert.equal(token, "synthetic-share-token");
        if (publicFailure) throw publicFailure;
        return publicAsset;
      },
      async findWorkspaceMediaAsset(id: string, scope: string) {
        workspaceCalls++;
        if (id !== assetId) throw Object.assign(new Error("Synthetic invalid UUID input"), { code: "22P02" });
        assert.equal(scope, workspaceId);
        return privateAsset;
      },
      async canAccessWorkspaceMedia(scope: string, folder: string, id: string) {
        assert.equal(scope, workspaceId); assert.equal(folder, asset.folder); assert.equal(id, assetId);
        return accessible;
      },
      async readMediaAssetContent(selected: typeof asset) {
        contentCalls++; assert.equal(selected, asset); return content;
      },
    } }),
    t.mock.module(moduleUrl("src/lib/auth/session.ts"), { namedExports: {
      async resolveWorkspaceScopedSession(_request: Request, options: { permission: string }) {
        assert.equal(options.permission, "crm:read");
        return authenticated ? { ok: true, session: { workspaceId } }
          : { ok: false, response: Response.json({ error: "Authentication required." }, { status: 401, headers: { "cache-control": "private, no-store" } }) };
      },
    } }),
    t.mock.module(moduleUrl("src/lib/crm-command.ts"), { namedExports: {
      async withCrmRead(session: { workspaceId: string }, operation: (tx: object, current: { workspaceId: string }) => Promise<unknown>) {
        transactionCalls++; assert.equal(session.workspaceId, workspaceId);
        return operation({}, session);
      },
    } }),
  ];
  t.after(() => { for (const mock of mocks) mock.restore(); });
  const publicRoute = await import("../src/app/api/media/public/[token]/route");
  const privateRoute = await import("../src/app/api/media/files/[assetId]/route");
  t.beforeEach(() => {
    authenticated = true; publicCalls = 0; workspaceCalls = 0; transactionCalls = 0; contentCalls = 0;
    publicFailure = null; publicAsset = null; privateAsset = null; accessible = true; content = null;
  });
  const publicRequest = () => new Request("https://crm.example.invalid/api/media/public/synthetic-share-token");
  const privateRequest = (id: string) => new Request("https://crm.example.invalid/api/media/files/" + encodeURIComponent(id));
  const publicGet = () => publicRoute.GET(publicRequest(), { params: Promise.resolve({ token: "synthetic-share-token" }) });
  const privateGet = (id = assetId) => privateRoute.GET(privateRequest(id), { params: Promise.resolve({ assetId: id }) });
  function assertProtectedHeaders(response: Response, privateFile = false) {
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    if (privateFile) assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  }
  await t.test("a public token lookup exception becomes a bounded 502 response", async () => {
    publicFailure = new Error("Synthetic database details must not reach the response");
    const response = await publicGet();
    assert.equal(response.status, 502); assertProtectedHeaders(response);
    assert.deepEqual(await response.json(), { error: "Public media asset could not be read." });
    assert.equal(publicCalls, 1); assert.equal(contentCalls, 0);
  });
  await t.test("a public storage lookup outage retains the existing 503 contract", async () => {
    publicFailure = new StubMediaStoreError("MEDIA_STORAGE_UNAVAILABLE");
    const response = await publicGet();
    assert.equal(response.status, 503); assertProtectedHeaders(response);
    assert.deepEqual(await response.json(), { error: "Media storage is unavailable." });
    assert.equal(contentCalls, 0);
  });
  await t.test("an unknown public token returns a protected 404 without reading content", async () => {
    const response = await publicGet(); assert.equal(response.status, 404); assertProtectedHeaders(response);
    assert.equal(publicCalls, 1); assert.equal(contentCalls, 0);
  });
  await t.test("a public asset still returns its actual bytes with protected headers", async () => {
    publicAsset = asset; content = { body: "hello", contentType: "text/plain", sizeBytes: 5 };
    const response = await publicGet(); assert.equal(response.status, 200); assertProtectedHeaders(response);
    assert.equal(await response.text(), "hello"); assert.equal(response.headers.get("content-length"), "5");
    assert.equal(contentCalls, 1);
  });
  await t.test("malformed private asset IDs are rejected before a transaction or database lookup", async () => {
    for (const id of ["not-a-uuid", "", "22222222-2222-4222-8222-22222222222g", "22222222222242228222222222222222"]) {
      const response = await privateGet(id); assert.equal(response.status, 400); assertProtectedHeaders(response, true);
      assert.deepEqual(await response.json(), { error: "Invalid media asset ID." });
    }
    assert.equal(transactionCalls, 0); assert.equal(workspaceCalls, 0); assert.equal(contentCalls, 0);
  });
  await t.test("authentication remains required before a malformed private ID is considered", async () => {
    authenticated = false; const response = await privateGet("not-a-uuid");
    assert.equal(response.status, 401); assert.equal(transactionCalls, 0); assert.equal(workspaceCalls, 0);
  });
  await t.test("a valid unknown private UUID still uses the scoped lookup and returns 404", async () => {
    const response = await privateGet(); assert.equal(response.status, 404); assertProtectedHeaders(response, true);
    assert.equal(transactionCalls, 1); assert.equal(workspaceCalls, 1); assert.equal(contentCalls, 0);
  });
  await t.test("an inaccessible private asset stays hidden and its content is not read", async () => {
    privateAsset = asset; accessible = false;
    const response = await privateGet(); assert.equal(response.status, 404); assertProtectedHeaders(response, true);
    assert.equal(contentCalls, 0);
  });
  await t.test("a scoped authorized private asset still returns its bytes", async () => {
    privateAsset = asset; content = { body: "hello", contentType: "text/plain", sizeBytes: 5 };
    const response = await privateGet(); assert.equal(response.status, 200); assertProtectedHeaders(response, true);
    assert.equal(await response.text(), "hello"); assert.equal(transactionCalls, 1); assert.equal(contentCalls, 1);
  });
});
