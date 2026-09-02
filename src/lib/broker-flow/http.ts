import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession, type AppSession } from "@/lib/auth/session";
import {
  QaBatchRuntimeError,
  qaBatchRuntimeErrorResponse,
  readQaBatchMutationHeader,
} from "@/lib/qa-batch-runtime";
import { BrokerDomainError, asRecord, requireIdempotencyKey } from "./contracts";

export async function authorizeBrokerRead(request: Request) {
  return resolveWorkspaceScopedSession(request, { permission: "crm:read" });
}

export async function authorizeBrokerWrite(request: Request) {
  return resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "pipeline:write" });
}

export async function readBrokerMutation(
  request: Request,
  session: AppSession,
  options: { qaBatchSupported?: boolean } = {},
) {
  const idempotencyKey = requireIdempotencyKey(request);
  const qaBatchId = readQaBatchMutationHeader(request, session);
  if (qaBatchId && options.qaBatchSupported !== true) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_MUTATION_NOT_ATOMIC",
      "This Broker mutation is not registered for atomic QA reset",
      409,
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BrokerDomainError("invalid_json", "Request body must be valid JSON.");
  }
  return { body: asRecord(body), idempotencyKey, qaBatchId };
}

export function brokerErrorResponse(error: unknown) {
  const qaBatchResponse = qaBatchRuntimeErrorResponse(error);
  if (qaBatchResponse) return qaBatchResponse;
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
