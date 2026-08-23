import "server-only";

import type { AppSession } from "@/lib/auth/session";
import {
  FunnelPublishTokenRotationError,
  getFunnelPublishTokenRotationStatus,
  rotateFunnelPublishToken,
} from "@/lib/db/funnel-publish-token-repository";
import { qaBatchSuccessHeaders } from "@/lib/qa-batch-runtime";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;
const rotationCommandMaxBytes = 2_048;

export function privateJson(body: unknown, status = 200) {
  return Response.json(body, { headers: privateHeaders, status });
}

function errorResponse(error: unknown) {
  if (!(error instanceof FunnelPublishTokenRotationError)) {
    return privateJson({ error: "FUNNEL_PUBLICATION_ROTATION_UNAVAILABLE" }, 503);
  }
  if (error.code === "FUNNEL_NOT_FOUND") {
    return privateJson({ error: error.code }, 404);
  }
  if (error.code === "PUBLICATION_REVISION_CONFLICT") {
    return privateJson({
      currentRevision: error.currentRevision,
      error: error.code,
    }, 409);
  }
  if (
    error.code === "INVALID_FUNNEL_ID" ||
    error.code === "INVALID_IDEMPOTENCY_KEY" ||
    error.code === "INVALID_REVISION"
  ) {
    return privateJson({ error: error.code }, 400);
  }
  return privateJson({ error: "FUNNEL_PUBLICATION_ROTATION_UNAVAILABLE" }, 503);
}

async function readRotationCommand(request: Request) {
  const contentType = request.headers.get("content-type")?.trim().toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;\s*charset=(?:utf-8|utf8))?$/u.test(contentType)) {
    return { error: "UNSUPPORTED_CONTENT_TYPE" as const };
  }
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  if (contentEncoding && contentEncoding !== "identity") {
    return { error: "UNSUPPORTED_CONTENT_ENCODING" as const };
  }
  const contentLength = request.headers.get("content-length")?.trim() ?? "";
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      return { error: "INVALID_CONTENT_LENGTH" as const };
    }
    if (declaredBytes > rotationCommandMaxBytes) {
      return { error: "ROTATION_COMMAND_TOO_LARGE" as const };
    }
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > rotationCommandMaxBytes) {
    return {
      error: bytes.byteLength ? "ROTATION_COMMAND_TOO_LARGE" as const : "INVALID_JSON" as const,
    };
  }
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { error: "INVALID_JSON" as const };
  }
}

export async function getFunnelPublishTokenStatusResponse(input: {
  funnelId: string;
  session: AppSession;
}) {
  try {
    const status = await getFunnelPublishTokenRotationStatus(input);
    return privateJson({ funnelId: input.funnelId, ...status });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function rotateFunnelPublishTokenResponse(input: {
  funnelId: string;
  qaBatchId?: string;
  request: Request;
  session: AppSession;
}) {
  const idempotencyKey = input.request.headers.get("idempotency-key")?.trim() ?? "";
  const parsed = await readRotationCommand(input.request);
  if ("error" in parsed) {
    const status = parsed.error === "UNSUPPORTED_CONTENT_TYPE" || parsed.error === "UNSUPPORTED_CONTENT_ENCODING"
      ? 415
      : parsed.error === "ROTATION_COMMAND_TOO_LARGE"
        ? 413
        : 400;
    return privateJson({ error: parsed.error }, status);
  }
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return privateJson({ error: "INVALID_ROTATION_COMMAND" }, 400);
  }
  const command = body as Record<string, unknown>;
  if (
    Object.keys(command).length !== 1 ||
    !Object.hasOwn(command, "expectedRevision") ||
    !Number.isSafeInteger(command.expectedRevision) ||
    (command.expectedRevision as number) < 0
  ) {
    return privateJson({ error: "INVALID_ROTATION_COMMAND" }, 400);
  }

  try {
    const result = await rotateFunnelPublishToken({
      expectedRevision: command.expectedRevision as number,
      funnelId: input.funnelId,
      idempotencyKey,
      qaBatchId: input.qaBatchId,
      session: input.session,
    });
    const success = (body: unknown) => {
      const response = privateJson(body);
      for (const [name, value] of Object.entries(
        qaBatchSuccessHeaders(input.qaBatchId ?? null, input.qaBatchId ? "already-registered" : undefined) ?? {},
      )) {
        response.headers.set(name, value);
      }
      return response;
    };
    if (result.status === "already-rotated") {
      return success({
        funnelId: input.funnelId,
        replayed: true,
        revision: result.revision,
      });
    }
    return success({
      funnelId: input.funnelId,
      publishToken: result.publishToken,
      replayed: false,
      revision: result.revision,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
