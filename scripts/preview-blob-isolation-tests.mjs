import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mediaStoreSource = await readFile(
  new URL("../src/lib/media-store.ts", import.meta.url),
  "utf8",
);

function functionSource(name) {
  const start = mediaStoreSource.indexOf(`function ${name}()`);
  assert.notEqual(start, -1, `${name} must exist`);
  const nextFunction = mediaStoreSource.indexOf("\nfunction ", start + 1);
  return mediaStoreSource.slice(start, nextFunction === -1 ? undefined : nextFunction);
}

test("Vercel Preview private storage cannot fall back to a shared production token", () => {
  const source = functionSource("privateBlobToken");

  assert.match(source, /VERCEL_ENV[\s\S]*=== "preview"/);
  assert.match(source, /NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN/);
  assert.ok(
    source.indexOf("NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN") <
      source.indexOf("NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN"),
  );
  assert.match(
    source,
    /if \(process\.env\.VERCEL_ENV[\s\S]*return process\.env\.NOVALURE_PREVIEW_PRIVATE_BLOB_READ_WRITE_TOKEN\?\.trim\(\) \|\| "";/,
  );
});

test("Vercel Preview public storage cannot fall back to a shared production token", () => {
  const source = functionSource("publicBlobToken");

  assert.match(source, /VERCEL_ENV[\s\S]*=== "preview"/);
  assert.match(source, /NOVALURE_PREVIEW_PUBLIC_BLOB_READ_WRITE_TOKEN/);
  assert.ok(
    source.indexOf("NOVALURE_PREVIEW_PUBLIC_BLOB_READ_WRITE_TOKEN") <
      source.indexOf("NOVALURE_PUBLIC_BLOB_READ_WRITE_TOKEN"),
  );
  assert.match(
    source,
    /if \(process\.env\.VERCEL_ENV[\s\S]*return process\.env\.NOVALURE_PREVIEW_PUBLIC_BLOB_READ_WRITE_TOKEN\?\.trim\(\) \|\| "";/,
  );
});
