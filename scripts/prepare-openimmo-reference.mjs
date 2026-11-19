import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { openImmoReference as reference, openImmoReferenceDirectory, openImmoSchemaPath, sha256, verifyOpenImmoSchema } from "./lib/openimmo-reference.mjs";

assert.equal(process.argv.length, 2, "OpenImmo reference preparation accepts no arguments");
await mkdir(openImmoReferenceDirectory, { recursive: true });
const archivePath = path.join(openImmoReferenceDirectory, "openimmo-version_127d.zip");
let archive;
try { archive = await readFile(archivePath); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  const response = await fetch(reference.archiveUrl, { redirect: "error", signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, "Official OpenImmo archive download failed");
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; assert.ok(size <= reference.archiveBytes, "Official OpenImmo archive exceeds pinned size"); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  archive = Buffer.concat(chunks);
}
assert.equal(archive.length, reference.archiveBytes, "Official OpenImmo archive size changed");
assert.equal(sha256(archive), reference.archiveSha256, "Official OpenImmo archive digest changed");
const schema = await new Promise((resolve, reject) => {
  yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
    if (error) { reject(error); return; }
    let found = null; let entries = 0;
    const fail = (failure) => { zip.close(); reject(failure); };
    zip.on("error", fail); zip.on("end", () => found ? resolve(found) : reject(new Error("Official OpenImmo schema entry missing")));
    zip.on("entry", (entry) => {
      if (++entries > 10) { fail(new Error("Official OpenImmo archive entry bound exceeded")); return; }
      if (entry.fileName !== reference.schemaName) { zip.readEntry(); return; }
      if (found || entry.uncompressedSize !== reference.schemaBytes) { fail(new Error("Official OpenImmo schema entry changed")); return; }
      zip.openReadStream(entry, (readError, stream) => {
        if (readError) { fail(readError); return; }
        const chunks = []; let size = 0;
        stream.on("error", fail); stream.on("data", (chunk) => {
          size += chunk.length;
          if (size > reference.schemaBytes) { stream.destroy(new Error("Official OpenImmo schema size exceeded")); return; }
          chunks.push(chunk);
        });
        stream.on("end", () => { found = Buffer.concat(chunks); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
});
verifyOpenImmoSchema(schema);
async function preserveExact(pathname, bytes) {
  try { await writeFile(pathname, bytes, { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  assert.deepEqual(await readFile(pathname), bytes, "Existing OpenImmo reference bytes differ");
}
await preserveExact(archivePath, archive);
await preserveExact(openImmoSchemaPath, schema);
console.log(JSON.stringify({ status: "OFFICIAL_OPENIMMO_REFERENCE_VERIFIED", version: reference.version, archiveSha256: reference.archiveSha256,
  schemaSha256: reference.schemaSha256, schemaPath: openImmoSchemaPath, source: reference.archiveUrl, schemaCommitted: false }));
