import { CrmCommandError } from "@/lib/crm-command";

export const MAX_CRM_JSON_BODY_BYTES = 16_384;

function bodyTooLarge(): never {
  throw new CrmCommandError("BODY_TOO_LARGE", "Body too large", 413);
}

/** Read one JSON request without ever buffering more than the configured byte limit. */
export async function readBoundedCrmJson(
  request: Request,
  maximumBytes = MAX_CRM_JSON_BODY_BYTES,
): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new CrmCommandError("JSON_REQUIRED", "JSON required", 415);
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new CrmCommandError("INVALID_BODY_LIMIT", "Invalid body limit", 500);
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const normalizedLength = declaredLength.trim();
    if (!/^\d+$/.test(normalizedLength)) {
      throw new CrmCommandError("INVALID_CONTENT_LENGTH", "Invalid Content-Length", 400);
    }
    const contentLength = Number(normalizedLength);
    if (!Number.isSafeInteger(contentLength)) bodyTooLarge();
    if (contentLength > maximumBytes) bodyTooLarge();
  }
  if (request.bodyUsed) {
    throw new CrmCommandError("INVALID_REQUEST", "Request body already consumed", 400);
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("BODY_TOO_LARGE").catch(() => undefined);
        bodyTooLarge();
      }
      chunks.push(value);
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new CrmCommandError("INVALID_JSON", "Invalid JSON", 400);
  }
}
