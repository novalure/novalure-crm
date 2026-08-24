import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

import {
  assertExactObjectKeys,
  canonicalJson,
  sha256,
} from "./external-gate-receipts-runtime.mjs";

export const launchActivationFlagsEnvelopeRecordType =
  "NOVALURE_FLAGS_LAUNCH_ACTIVATION_ENVELOPE";
export const launchActivationFlagsEnvelopePrefix = "v1.br.";
export const launchActivationFlagsMaximumEncodedBytes = 190 * 1024;
export const launchActivationFlagsMaximumDecodedBytes = 512 * 1024;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function decodeBase64Url(value) {
  invariant(base64UrlPattern.test(value), "LAUNCH_FLAGS_ENVELOPE_ENCODING_INVALID");
  const decoded = Buffer.from(value, "base64url");
  invariant(
    decoded.length > 0 && decoded.toString("base64url") === value,
    "LAUNCH_FLAGS_ENVELOPE_ENCODING_INVALID",
  );
  return decoded;
}

export function encodeLaunchActivationFlagsEnvelope({
  expected,
  productionCutoverDocument,
  receipt,
}) {
  const envelope = {
    expected,
    productionCutoverDocument,
    receipt,
    recordType: launchActivationFlagsEnvelopeRecordType,
    schemaVersion: 1,
  };
  const source = Buffer.from(canonicalJson(envelope), "utf8");
  invariant(
    source.length > 0 && source.length <= launchActivationFlagsMaximumDecodedBytes,
    "LAUNCH_FLAGS_ENVELOPE_SIZE_INVALID",
  );
  const compressed = brotliCompressSync(source, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
    },
  });
  const value = `${launchActivationFlagsEnvelopePrefix}${compressed.toString("base64url")}`;
  invariant(
    Buffer.byteLength(value, "utf8") <= launchActivationFlagsMaximumEncodedBytes,
    "LAUNCH_FLAGS_ENVELOPE_ENCODED_SIZE_INVALID",
  );
  return Object.freeze({
    decodedBytes: source.length,
    envelope: Object.freeze(envelope),
    envelopeSha256: sha256(source),
    value,
    valueBytes: Buffer.byteLength(value, "utf8"),
  });
}

export function decodeLaunchActivationFlagsEnvelope(value) {
  invariant(
    typeof value === "string"
      && value.startsWith(launchActivationFlagsEnvelopePrefix)
      && Buffer.byteLength(value, "utf8") <= launchActivationFlagsMaximumEncodedBytes,
    "LAUNCH_FLAGS_ENVELOPE_FORMAT_INVALID",
  );
  const compressed = decodeBase64Url(value.slice(launchActivationFlagsEnvelopePrefix.length));
  let source;
  try {
    source = brotliDecompressSync(compressed, {
      maxOutputLength: launchActivationFlagsMaximumDecodedBytes,
    });
  } catch {
    invariant(false, "LAUNCH_FLAGS_ENVELOPE_DECOMPRESSION_FAILED");
  }
  invariant(
    source.length > 0 && source.length <= launchActivationFlagsMaximumDecodedBytes,
    "LAUNCH_FLAGS_ENVELOPE_SIZE_INVALID",
  );
  let envelope;
  try {
    envelope = JSON.parse(source.toString("utf8"));
  } catch {
    invariant(false, "LAUNCH_FLAGS_ENVELOPE_JSON_INVALID");
  }
  assertExactObjectKeys(envelope, [
    "expected",
    "productionCutoverDocument",
    "receipt",
    "recordType",
    "schemaVersion",
  ], "LAUNCH_FLAGS_ENVELOPE");
  invariant(envelope.schemaVersion === 1, "LAUNCH_FLAGS_ENVELOPE_SCHEMA_INVALID");
  invariant(
    envelope.recordType === launchActivationFlagsEnvelopeRecordType,
    "LAUNCH_FLAGS_ENVELOPE_RECORD_TYPE_INVALID",
  );
  invariant(
    source.toString("utf8") === canonicalJson(envelope),
    "LAUNCH_FLAGS_ENVELOPE_NOT_CANONICAL",
  );
  return Object.freeze({
    envelope: Object.freeze(envelope),
    envelopeSha256: sha256(source),
  });
}
