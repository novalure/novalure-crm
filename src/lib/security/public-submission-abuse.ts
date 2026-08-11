import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const publicSubmissionActions = {
  booking: "meeting_booking",
  form: "website_form",
} as const;

export const publicSubmissionControlFields = {
  expiresAt: "_novalure_proof_expires_at",
  honeypot: "_novalure_company",
  idempotencyKey: "_novalure_idempotency_key",
  issuedAt: "_novalure_proof_issued_at",
  proof: "_novalure_proof",
} as const;

export type PublicSubmissionAction =
  (typeof publicSubmissionActions)[keyof typeof publicSubmissionActions];

export type PublicSubmissionProof = {
  expiresAt: number;
  idempotencyKey: string;
  issuedAt: number;
  signature: string;
};

export const publicSubmissionProofTtlSeconds = 15 * 60;

export type PublicSubmissionResponseSnapshot =
  | {
      body: Record<string, unknown>;
      kind: "json";
      status: number;
    }
  | {
      kind: "redirect";
      location: string;
      status: 303;
    };

export type PublicSubmissionFieldRule = {
  allowFile?: boolean;
  maxEntries?: number;
  maxLength: number;
  name: string;
};

export type PublicSubmissionBodyLimits = {
  allowedFileBytes: number;
  allowedFiles: number;
  maxBodyBytes: number;
  maxFieldNameLength: number;
  maxFields: number;
  maxStringLength: number;
};

export const bookingSubmissionBodyLimits: PublicSubmissionBodyLimits = {
  allowedFileBytes: 0,
  allowedFiles: 0,
  maxBodyBytes: 64 * 1024,
  maxFieldNameLength: 128,
  maxFields: 24,
  maxStringLength: 4_096,
};

export const formSubmissionBodyLimits: PublicSubmissionBodyLimits = {
  allowedFileBytes: 10 * 1024 * 1024,
  allowedFiles: 5,
  maxBodyBytes: 11 * 1024 * 1024,
  maxFieldNameLength: 128,
  maxFields: 96,
  maxStringLength: 8_192,
};

export class PublicSubmissionRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "PublicSubmissionRequestError";
    this.code = code;
    this.status = status;
  }
}

export function assertPublicSubmissionAbuseConfiguration(
  env: Record<string, string | undefined> = process.env,
) {
  const secret = env.NOVALURE_ABUSE_SECRET ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32 || !secret.trim()) {
    throw new Error("NOVALURE_ABUSE_SECRET must contain at least 32 bytes");
  }

  return secret;
}

export function buildPublicSubmissionScope(input: {
  resourceId: string;
  resourceType: "form" | "meeting";
  workspaceId: string;
}) {
  const scope = `${input.resourceType}:${input.workspaceId}:${input.resourceId}`;
  if (scope.length > 256 || /[\r\n\u0000]/u.test(scope)) {
    throw new Error("Invalid public submission scope");
  }

  return scope;
}

export function createPublicSubmissionProof(input: {
  action: PublicSubmissionAction;
  idempotencyKey?: string;
  nowSeconds?: number;
  scope: string;
  secret?: string;
}): PublicSubmissionProof {
  const secret = input.secret ?? assertPublicSubmissionAbuseConfiguration();
  const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const expiresAt = issuedAt + publicSubmissionProofTtlSeconds;
  const idempotencyKey = input.idempotencyKey ?? randomBytes(24).toString("base64url");
  assertProofInput({
    action: input.action,
    expiresAt,
    idempotencyKey,
    issuedAt,
    scope: input.scope,
  });

  return {
    expiresAt,
    idempotencyKey,
    issuedAt,
    signature: signProof({
      action: input.action,
      expiresAt,
      idempotencyKey,
      issuedAt,
      scope: input.scope,
      secret,
    }),
  };
}

export function getPublicSubmissionProof(formData: FormData): PublicSubmissionProof | null {
  const idempotencyKey = getStringEntry(formData, publicSubmissionControlFields.idempotencyKey);
  const signature = getStringEntry(formData, publicSubmissionControlFields.proof);
  const issuedAt = Number(getStringEntry(formData, publicSubmissionControlFields.issuedAt));
  const expiresAt = Number(getStringEntry(formData, publicSubmissionControlFields.expiresAt));

  if (!idempotencyKey || !signature || !Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) {
    return null;
  }

  return { expiresAt, idempotencyKey, issuedAt, signature };
}

export function verifyPublicSubmissionProof(input: {
  action: PublicSubmissionAction;
  nowSeconds?: number;
  proof: PublicSubmissionProof | null;
  scope: string;
  secret?: string;
}): { ok: true; proof: PublicSubmissionProof } | { ok: false; reason: string } {
  const proof = input.proof;
  if (!proof) return { ok: false, reason: "submission_proof_missing" };

  try {
    assertProofInput({
      action: input.action,
      expiresAt: proof.expiresAt,
      idempotencyKey: proof.idempotencyKey,
      issuedAt: proof.issuedAt,
      scope: input.scope,
    });
  } catch {
    return { ok: false, reason: "submission_proof_invalid" };
  }

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (proof.issuedAt > nowSeconds + 30) {
    return { ok: false, reason: "submission_proof_invalid" };
  }
  if (proof.expiresAt < nowSeconds) {
    return { ok: false, reason: "submission_proof_expired" };
  }
  if (
    proof.expiresAt <= proof.issuedAt ||
    proof.expiresAt - proof.issuedAt > publicSubmissionProofTtlSeconds
  ) {
    return { ok: false, reason: "submission_proof_invalid" };
  }

  const secret = input.secret ?? assertPublicSubmissionAbuseConfiguration();
  const expected = signProof({
    action: input.action,
    expiresAt: proof.expiresAt,
    idempotencyKey: proof.idempotencyKey,
    issuedAt: proof.issuedAt,
    scope: input.scope,
    secret,
  });
  const suppliedBuffer = Buffer.from(proof.signature, "base64url");
  const expectedBuffer = Buffer.from(expected, "base64url");
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: "submission_proof_invalid" };
  }

  return { ok: true, proof };
}

export function createPublicSubmissionOpaqueHash(input: {
  label: string;
  secret?: string;
  value: string | Uint8Array;
}) {
  const secret = input.secret ?? assertPublicSubmissionAbuseConfiguration();
  return createHmac("sha256", secret)
    .update(`${input.label}\n`, "utf8")
    .update(input.value)
    .digest("hex");
}

export function createPublicSubmissionIdempotencyHashes(input: {
  action: PublicSubmissionAction;
  idempotencyKey: string;
  requestFingerprint: string;
  scope: string;
  secret?: string;
}) {
  return {
    actionHash: createPublicSubmissionOpaqueHash({
      label: "idempotency-action",
      secret: input.secret,
      value: input.action,
    }),
    idempotencyHash: createPublicSubmissionOpaqueHash({
      label: "idempotency-key",
      secret: input.secret,
      value: `${input.action}\n${input.scope}\n${input.idempotencyKey}`,
    }),
    requestHash: input.requestFingerprint,
    scopeHash: createPublicSubmissionOpaqueHash({
      label: "idempotency-scope",
      secret: input.secret,
      value: input.scope,
    }),
  };
}

export function createPublicSubmissionRateLimitPolicies(input: {
  action: PublicSubmissionAction;
  clientIp: string;
  identifier: string;
  scope: string;
  secret?: string;
}) {
  const limits = input.action === publicSubmissionActions.booking
    ? { identifier: 5, ip: 12, scope: 120 }
    : { identifier: 8, ip: 30, scope: 300 };
  const hash = (label: string, value: string) =>
    createPublicSubmissionOpaqueHash({
      label: `rate-limit-${label}`,
      secret: input.secret,
      value: `${input.action}\n${input.scope}\n${value}`,
    });

  return [
    {
      keyHash: hash("ip", input.clientIp),
      limit: limits.ip,
      windowSeconds: 10 * 60,
    },
    {
      keyHash: hash("identifier", input.identifier),
      limit: limits.identifier,
      windowSeconds: 15 * 60,
    },
    {
      keyHash: hash("scope", "all"),
      limit: limits.scope,
      windowSeconds: 10 * 60,
    },
  ];
}

export function normalizePublicSubmissionIdentifier(
  value: string,
  type: "email" | "phone" | "opaque" = "opaque",
) {
  const normalized = value.normalize("NFKC").trim();
  if (type === "email") return `email:${normalized.toLowerCase().slice(0, 320)}`;
  if (type === "phone") {
    const plus = normalized.startsWith("+") ? "+" : "";
    return `phone:${plus}${normalized.replace(/\D/g, "").slice(0, 32)}`;
  }

  return `opaque:${normalized.toLowerCase().replace(/\s+/g, " ").slice(0, 320)}`;
}

export function getTrustedPublicSubmissionClientIp(
  requestHeaders: Headers,
  env: Record<string, string | undefined> = process.env,
) {
  let headerName = "";
  if (env.VERCEL === "1" || env.VERCEL_ENV) {
    headerName = "x-vercel-forwarded-for";
  } else if (env.NOVALURE_TRUSTED_CLIENT_IP_HEADER?.trim()) {
    headerName = env.NOVALURE_TRUSTED_CLIENT_IP_HEADER.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/u.test(headerName)) return null;
  } else {
    return null;
  }

  const value = requestHeaders.get(headerName);
  if (!value || value.length > 512) return null;
  const firstHop = value.split(",", 1)[0]?.trim() ?? "";
  return normalizeIpAddress(firstHop);
}

export function shouldSuppressPublicSubmissionExternalEffects(input: {
  env?: Record<string, string | undefined>;
  workspaceId: string;
}) {
  const env = input.env ?? process.env;
  if (env.NODE_ENV !== "production") return true;
  if (env.NOVALURE_PUBLIC_SUBMISSION_QA_MODE === "1") return true;
  if (env.VERCEL_ENV && env.VERCEL_ENV !== "production") return true;

  const qaWorkspaceIds = new Set(
    (env.NOVALURE_QA_WORKSPACE_IDS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return qaWorkspaceIds.has(input.workspaceId.toLowerCase());
}

export async function readBoundedPublicSubmissionFormData(
  request: Request,
  limits: PublicSubmissionBodyLimits,
) {
  const contentType = validateContentType(request.headers.get("content-type"));
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new PublicSubmissionRequestError("unsupported_content_encoding", 415);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new PublicSubmissionRequestError("invalid_content_length", 400);
    }
    if (declaredBytes > limits.maxBodyBytes) {
      throw new PublicSubmissionRequestError("submission_too_large", 413);
    }
  }

  const bytes = await readBodyBytes(request, limits.maxBodyBytes);
  if (!bytes.byteLength) {
    throw new PublicSubmissionRequestError("submission_body_missing", 400);
  }
  if (contentType.mimeType === "application/x-www-form-urlencoded") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new PublicSubmissionRequestError("invalid_charset", 415);
    }
  }

  const parsedRequest = new Request(request.url, {
    body: bytes,
    headers: { "content-type": contentType.raw },
    method: "POST",
  });
  let formData: FormData;
  try {
    formData = await parsedRequest.formData();
  } catch {
    throw new PublicSubmissionRequestError("invalid_form_body", 400);
  }

  await validateGenericFormData(formData, limits);
  return {
    formData,
    requestFingerprint: createPublicSubmissionOpaqueHash({
      label: "request-body",
      value: bytes,
    }),
  };
}

export function validatePublicSubmissionFieldRules(
  formData: FormData,
  rules: PublicSubmissionFieldRule[],
) {
  const ruleByName = new Map(rules.map((rule) => [rule.name, rule]));
  const entryCountByName = new Map<string, number>();

  for (const [name, value] of formData.entries()) {
    const rule = ruleByName.get(name);
    if (!rule) throw new PublicSubmissionRequestError("unknown_submission_field", 400);
    const entryCount = (entryCountByName.get(name) ?? 0) + 1;
    entryCountByName.set(name, entryCount);
    if (entryCount > (rule.maxEntries ?? 1)) {
      throw new PublicSubmissionRequestError("too_many_field_values", 400);
    }
    if (typeof value === "string" && value.length > rule.maxLength) {
      throw new PublicSubmissionRequestError("submission_field_too_long", 413);
    }
    if (typeof value !== "string" && value.size > 0 && !rule.allowFile) {
      throw new PublicSubmissionRequestError("file_not_allowed", 415);
    }
  }
}

export async function validatePublicSubmissionFilesForFields(
  formData: FormData,
  fields: Array<{
    acceptedTypes: string;
    maxBytes: number;
    multiple: boolean;
    name: string;
  }>,
) {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  for (const [name, value] of formData.entries()) {
    if (typeof value === "string" || (value.size === 0 && !value.name)) continue;
    const field = fieldByName.get(name);
    if (!field) throw new PublicSubmissionRequestError("file_not_allowed", 415);
    if (value.size > field.maxBytes) {
      throw new PublicSubmissionRequestError("file_too_large", 413);
    }
    if (!fileMatchesConfiguredAccept(value, field.acceptedTypes)) {
      throw new PublicSubmissionRequestError("file_type_not_allowed", 415);
    }
  }

  for (const field of fields) {
    const files = formData
      .getAll(field.name)
      .filter((value): value is File => typeof value !== "string" && (value.size > 0 || Boolean(value.name)));
    if (!field.multiple && files.length > 1) {
      throw new PublicSubmissionRequestError("too_many_files", 400);
    }
  }
}

export function hasPublicSubmissionHoneypotValue(formData: FormData) {
  return getStringEntry(formData, publicSubmissionControlFields.honeypot).trim().length > 0;
}

export function stripPublicSubmissionControlFields(formData: FormData) {
  for (const fieldName of Object.values(publicSubmissionControlFields)) {
    formData.delete(fieldName);
  }
  return formData;
}

export function parsePublicSubmissionResponseSnapshot(
  value: unknown,
): PublicSubmissionResponseSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.kind === "redirect" &&
    record.status === 303 &&
    typeof record.location === "string" &&
    record.location.length > 0 &&
    record.location.length <= 4_096
  ) {
    return { kind: "redirect", location: record.location, status: 303 };
  }
  if (
    record.kind === "json" &&
    typeof record.status === "number" &&
    Number.isInteger(record.status) &&
    record.status >= 200 &&
    record.status <= 599 &&
    record.body &&
    typeof record.body === "object" &&
    !Array.isArray(record.body)
  ) {
    return {
      body: record.body as Record<string, unknown>,
      kind: "json",
      status: record.status,
    };
  }

  return null;
}

export function escapeHtmlText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function assertProofInput(input: {
  action: PublicSubmissionAction;
  expiresAt: number;
  idempotencyKey: string;
  issuedAt: number;
  scope: string;
}) {
  if (!Object.values(publicSubmissionActions).includes(input.action)) {
    throw new Error("Invalid public submission action");
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(input.idempotencyKey)) {
    throw new Error("Invalid public submission idempotency key");
  }
  if (!Number.isInteger(input.issuedAt) || !Number.isInteger(input.expiresAt)) {
    throw new Error("Invalid public submission proof timestamp");
  }
  if (!input.scope || input.scope.length > 256 || /[\r\n\u0000]/u.test(input.scope)) {
    throw new Error("Invalid public submission scope");
  }
}

function signProof(input: {
  action: PublicSubmissionAction;
  expiresAt: number;
  idempotencyKey: string;
  issuedAt: number;
  scope: string;
  secret: string;
}) {
  const canonical = [
    "public-submission-proof-v1",
    input.action,
    input.scope,
    input.idempotencyKey,
    String(input.issuedAt),
    String(input.expiresAt),
  ].join("\n");
  return createHmac("sha256", input.secret).update(canonical).digest("base64url");
}

function getStringEntry(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function validateContentType(value: string | null) {
  if (!value || value.length > 512) {
    throw new PublicSubmissionRequestError("unsupported_content_type", 415);
  }
  const [rawMimeType] = value.split(";", 1);
  const mimeType = rawMimeType.trim().toLowerCase();
  if (mimeType !== "multipart/form-data" && mimeType !== "application/x-www-form-urlencoded") {
    throw new PublicSubmissionRequestError("unsupported_content_type", 415);
  }

  const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)"?/iu.exec(value)?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    throw new PublicSubmissionRequestError("invalid_charset", 415);
  }
  if (mimeType === "multipart/form-data") {
    const boundaryMatch = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu.exec(value);
    const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "";
    if (!/^[0-9A-Za-z'()+_,.\/:=?-]{1,70}$/u.test(boundary)) {
      throw new PublicSubmissionRequestError("invalid_multipart_boundary", 400);
    }
  }

  return { mimeType, raw: value };
}

async function readBodyBytes(request: Request, maxBodyBytes: number) {
  if (request.bodyUsed) throw new PublicSubmissionRequestError("submission_body_consumed", 400);
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBodyBytes) {
      await reader.cancel("submission_too_large");
      throw new PublicSubmissionRequestError("submission_too_large", 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function validateGenericFormData(formData: FormData, limits: PublicSubmissionBodyLimits) {
  let fieldCount = 0;
  let fileCount = 0;
  for (const [name, value] of formData.entries()) {
    fieldCount += 1;
    if (fieldCount > limits.maxFields) {
      throw new PublicSubmissionRequestError("too_many_submission_fields", 413);
    }
    if (!name || name.length > limits.maxFieldNameLength || containsUnsafeControlCharacter(name)) {
      throw new PublicSubmissionRequestError("invalid_submission_field_name", 400);
    }

    if (typeof value === "string") {
      if (
        value.length > limits.maxStringLength ||
        value.includes("\uFFFD") ||
        containsUnsafeControlCharacter(value)
      ) {
        throw new PublicSubmissionRequestError("invalid_submission_field_value", 413);
      }
      continue;
    }
    if (value.size === 0 && !value.name) continue;

    fileCount += 1;
    if (fileCount > limits.allowedFiles) {
      throw new PublicSubmissionRequestError("too_many_files", 413);
    }
    if (value.size <= 0 || value.size > limits.allowedFileBytes) {
      throw new PublicSubmissionRequestError("file_too_large", 413);
    }
    await validateGenericFile(value);
  }
}

function containsUnsafeControlCharacter(value: string) {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
}

const supportedFileTypes = new Map([
  ["application/msword", [".doc"]],
  ["application/pdf", [".pdf"]],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", [".docx"]],
  ["image/jpeg", [".jpg", ".jpeg"]],
  ["image/png", [".png"]],
]);

async function validateGenericFile(file: File) {
  if (
    !file.name ||
    file.name.length > 160 ||
    containsUnsafeControlCharacter(file.name) ||
    /[\\/]/u.test(file.name)
  ) {
    throw new PublicSubmissionRequestError("invalid_file_name", 400);
  }
  const mimeType = file.type.toLowerCase();
  const extensions = supportedFileTypes.get(mimeType);
  if (!extensions || !extensions.some((extension) => file.name.toLowerCase().endsWith(extension))) {
    throw new PublicSubmissionRequestError("file_type_not_allowed", 415);
  }

  const signature = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const matchesSignature =
    (mimeType === "application/pdf" && startsWithBytes(signature, [0x25, 0x50, 0x44, 0x46, 0x2d])) ||
    (mimeType === "image/jpeg" && startsWithBytes(signature, [0xff, 0xd8, 0xff])) ||
    (mimeType === "image/png" && startsWithBytes(signature, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (mimeType === "application/msword" && startsWithBytes(signature, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) ||
    (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
      startsWithBytes(signature, [0x50, 0x4b, 0x03, 0x04]));
  if (!matchesSignature) {
    throw new PublicSubmissionRequestError("file_signature_invalid", 415);
  }
}

function startsWithBytes(value: Uint8Array, expected: number[]) {
  return expected.every((byte, index) => value[index] === byte);
}

function fileMatchesConfiguredAccept(file: File, acceptedTypes: string) {
  const accepted = acceptedTypes
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!accepted.length) return false;
  const fileName = file.name.toLowerCase();
  const mimeType = file.type.toLowerCase();
  return accepted.some((value) => {
    if (value.startsWith(".")) return fileName.endsWith(value);
    if (value.endsWith("/*")) return mimeType.startsWith(value.slice(0, -1));
    return value === mimeType;
  });
}

function normalizeIpAddress(value: string) {
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;

  try {
    const hostname = new URL(`http://[${value}]`).hostname;
    return hostname.startsWith("[") ? hostname.slice(1, -1).toLowerCase() : hostname.toLowerCase();
  } catch {
    return null;
  }
}
