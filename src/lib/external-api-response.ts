import { NextResponse } from "next/server";
import { ExternalIntegrationError } from "@/lib/db/external-integration-gateway";

export function externalJson(
  origin: string,
  body: Record<string, unknown>,
  init: { correlationId?: string; status?: number } = {},
) {
  const response = NextResponse.json(body, { status: init.status ?? 200 });
  response.headers.set("access-control-allow-origin", origin);
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("vary", "Origin");
  response.headers.set("x-content-type-options", "nosniff");
  if (init.correlationId) response.headers.set("x-novalure-correlation-id", init.correlationId);
  return response;
}

export function externalOptions(origin: string, methods: string) {
  return new Response(null, {
    headers: {
      "access-control-allow-headers": "Content-Type, Idempotency-Key, X-Novalure-Site-Key, X-Novalure-Session-Token",
      "access-control-allow-methods": methods,
      "access-control-allow-origin": origin,
      "access-control-max-age": "600",
      "cache-control": "private, no-store",
      vary: "Origin",
    },
    status: 204,
  });
}

export function externalFailure(
  error: unknown,
  origin = "null",
  context?: { correlationId: string; operation: string; startedAt: number },
) {
  const known = error instanceof ExternalIntegrationError;
  const status = known ? error.status : 503;
  const code = known ? error.code : "temporarily_unavailable";
  if (context) {
    console.warn(JSON.stringify({
      code,
      correlationId: context.correlationId,
      durationMs: Date.now() - context.startedAt,
      event: "external_integration_request",
      operation: context.operation,
      outcome: status >= 500 ? "failed" : "denied",
      status,
    }));
  }
  return externalJson(origin, { error: code }, { correlationId: context?.correlationId, status });
}

export function observeExternalSuccess(input: {
  correlationId: string;
  operation: string;
  outcome?: "accepted" | "duplicate";
  startedAt: number;
  status: number;
}) {
  console.info(JSON.stringify({
    correlationId: input.correlationId,
    durationMs: Date.now() - input.startedAt,
    event: "external_integration_request",
    operation: input.operation,
    outcome: input.outcome ?? "accepted",
    status: input.status,
  }));
}

export async function readBoundedJsonObject(request: Request, maxBytes = 65_536) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ExternalIntegrationError("unsupported_content_type", 415);
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d{1,10}$/u.test(declared) || Number(declared) > maxBytes)) {
    throw new ExternalIntegrationError("request_too_large", 413);
  }
  const raw = await request.text();
  if (!raw || Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new ExternalIntegrationError("invalid_request", raw ? 413 : 400);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Public gateway contracts require a JSON object, not an arbitrary JSON
    // primitive. Valid primitives are deliberately rejected as invalid input.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("object required");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ExternalIntegrationError("invalid_json", 400);
  }
}
