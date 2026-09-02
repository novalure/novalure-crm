import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { BrokerDomainError, asRecord, requireIdempotencyKey } from "./contracts";

export async function authorizeBrokerRead(request: Request) {
  return resolveWorkspaceScopedSession(request, { permission: "crm:read" });
}

export async function authorizeBrokerWrite(request: Request) {
  return resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
}

export async function readBrokerMutation(request: Request) {
  const idempotencyKey = requireIdempotencyKey(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BrokerDomainError("invalid_json", "Request body must be valid JSON.");
  }
  return { body: asRecord(body), idempotencyKey };
}

export function brokerErrorResponse(error: unknown) {
  if (error instanceof BrokerDomainError) {
    return NextResponse.json(
      { code: error.code, details: error.details ?? null, error: error.message, persisted: false },
      { headers: { "cache-control": "private, no-store" }, status: error.status },
    );
  }
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : "unknown",
    event: "broker_operations_failure",
  }));
  return NextResponse.json(
    { code: "broker_operation_failed", error: "Broker operation could not be completed.", persisted: false },
    { headers: { "cache-control": "private, no-store" }, status: 503 },
  );
}

export function brokerJson(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store");
  return NextResponse.json(data, { ...init, headers });
}
