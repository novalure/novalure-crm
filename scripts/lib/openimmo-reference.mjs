import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Official public archive downloaded on 2026-11-18. Keep the copyrighted schema
// in the ignored local cache; do not replace it with a newer version or a stub.
// The vendor permits free XML-description use on the referenced download page.
// The official 127d file retains an older 127c comment header; preserve its
// original bytes rather than editing that vendor metadata to match the filename.
export const openImmoReference = Object.freeze({
  version: "1.2.7d",
  archiveUrl: "https://www.openimmo.de/xdata/openimmo-version_127d.zip",
  usageInformationUrl: "https://www.openimmo.de/go.php/p/24/download.htm",
  archiveBytes: 40872,
  archiveSha256: "ab56323a606d624f874615c6e1446f9df174c0648eb1af56d10fb3b8b0b036f8",
  schemaName: "openimmo_127d.xsd",
  schemaBytes: 201961,
  schemaSha256: "c27e178dc70087771d7a60d4964f6b402648dcca47991c0b28d9ea3dabdc4246",
});
export const openImmoReferenceDirectory = path.resolve(".npm-cache/qa/openimmo-reference");
export const openImmoSchemaPath = path.join(openImmoReferenceDirectory, openImmoReference.schemaName);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyOpenImmoSchema(bytes) {
  assert.equal(bytes.length, openImmoReference.schemaBytes, "Official OpenImmo schema size changed");
  assert.equal(sha256(bytes), openImmoReference.schemaSha256, "Official OpenImmo schema digest changed");
}

/** Same .NET XmlSchemaSet on Windows and Linux; absence/failure is a test failure. */
export async function validateOpenImmoReference(xmlPath) {
  verifyOpenImmoSchema(await readFile(openImmoSchemaPath));
  const command = process.platform === "win32" ? "pwsh.exe" : "pwsh";
  const result = spawnSync(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", "scripts/validate-openimmo.ps1",
    "-SchemaPath", openImmoSchemaPath, "-XmlPath", path.resolve(xmlPath)],
  { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, "PowerShell 7 (pwsh) is required for official OpenImmo XSD validation");
  assert.equal(result.status, 0, `OpenImmo XSD validation failed: ${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { valid: true });
}
