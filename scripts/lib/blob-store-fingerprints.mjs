import { createHash } from "node:crypto";

const storeIdPattern = /^[A-Za-z0-9-]{6,128}$/u;

function normalizeStoreId(value) {
  const storeId = typeof value === "string" ? value.trim().replace(/^store_/u, "") : "";
  if (!storeIdPattern.test(storeId)) throw new Error("BLOB_STORE_ID_INVALID");
  return storeId;
}

function storeFingerprint(label, value) {
  const storeId = normalizeStoreId(value);
  return `sha256:${createHash("sha256").update(`${label}\0${storeId}`).digest("hex").slice(0, 20)}`;
}

export function previewPrivateBlobStoreFingerprint(storeId) {
  return storeFingerprint("preview-blob-private-store:v1", storeId);
}

export function previewLegacyBlobStoreFingerprint(storeId) {
  return storeFingerprint("preview-blob-legacy-store:v1", storeId);
}
