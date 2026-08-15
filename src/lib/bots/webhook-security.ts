import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const maxBotWebhookBodyBytes = 256 * 1024;

type LimitedBodyResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: "invalid_content_length" | "payload_too_large" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isJsonWebhookContentType(contentType: string | null) {
  if (!contentType) return false;

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || (mediaType.startsWith("application/") && mediaType.endsWith("+json"));
}

export function hasSupportedWebhookContentEncoding(contentEncoding: string | null) {
  if (!contentEncoding) return true;

  return contentEncoding
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .every((part) => part === "identity");
}

export function isMetaWebhookPayload(value: unknown) {
  if (!isRecord(value)) return false;

  const object = typeof value.object === "string" ? value.object.trim().toLowerCase() : "";
  const channel = typeof value.channel === "string" ? value.channel.trim().toLowerCase() : "";

  return (
    object === "whatsapp_business_account" ||
    object === "instagram" ||
    object === "page" ||
    channel === "whatsapp" ||
    channel === "instagram" ||
    channel === "facebook messenger" ||
    Array.isArray(value.entry) ||
    (value.field === "messages" && isRecord(value.value))
  );
}

export function constantTimeEqualStrings(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false;

  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function verifyMetaWebhookSignature(
  rawBody: Uint8Array,
  signature: string | null | undefined,
  appSecret: string | null | undefined,
) {
  const secret = appSecret?.trim();
  const normalizedSignature = signature?.trim().toLowerCase();

  if (!secret || !normalizedSignature || !/^sha256=[0-9a-f]{64}$/.test(normalizedSignature)) return false;

  const receivedDigest = Buffer.from(normalizedSignature.slice("sha256=".length), "hex");
  const expectedDigest = createHmac("sha256", secret).update(rawBody).digest();

  return receivedDigest.length === expectedDigest.length && timingSafeEqual(receivedDigest, expectedDigest);
}

export async function readLimitedWebhookBody(
  request: Request,
  maximumBytes = maxBotWebhookBodyBytes,
): Promise<LimitedBodyResult> {
  const contentLengthHeader = request.headers.get("content-length");

  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return { ok: false, reason: "invalid_content_length" };
    }
    if (contentLength > maximumBytes) {
      return { ok: false, reason: "payload_too_large" };
    }
  }

  if (!request.body) return { ok: true, body: Buffer.alloc(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;

    totalBytes += chunk.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel("payload_too_large").catch(() => undefined);
      return { ok: false, reason: "payload_too_large" };
    }

    chunks.push(chunk.value);
  }

  return { ok: true, body: Buffer.concat(chunks, totalBytes) };
}
