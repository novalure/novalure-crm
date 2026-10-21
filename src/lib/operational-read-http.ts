import { CrmCommandError } from "@/lib/crm-command";

export type OperationalReadMode = "bot" | "approval" | "calendar";
export type OperationalReadStatus = "pending" | "approved" | "denied" | "expired";
export type OperationalReadQuery = {
  projectId?: string;
  botId?: string;
  status: OperationalReadStatus;
};

export class OperationalReadError extends Error {
  constructor() {
    super("Invalid operational read query.");
    this.name = "OperationalReadError";
  }
}

export const operationalReadPrivateHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Query selectors are requests, never authorization; the existing resolver checks workspace access. */
export function parseOperationalReadQuery(request: Request, mode: OperationalReadMode): OperationalReadQuery {
  const params = new URL(request.url).searchParams;
  const allowed = new Set([
    "workspaceId",
    ...(mode === "calendar" ? [] : ["projectId", "botId"]),
    ...(mode === "approval" ? ["status"] : []),
  ]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new OperationalReadError();
  }
  for (const key of ["workspaceId", "projectId", "botId"]) {
    if (params.has(key) && !uuid.test(params.get(key)!)) throw new OperationalReadError();
  }
  const status = params.get("status");
  return {
    ...(params.has("projectId") ? { projectId: params.get("projectId")! } : {}),
    ...(params.has("botId") ? { botId: params.get("botId")! } : {}),
    // Preserve the existing approval GET behavior for unknown/empty status values.
    status: status === "approved" || status === "denied" || status === "expired" ? status : "pending",
  };
}

export function operationalReadJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: operationalReadPrivateHeaders });
}

/** Never serialize database diagnostics, provider messages, SQL or exception contents. */
export function operationalReadErrorResponse(error: unknown): Response {
  if (error instanceof OperationalReadError) {
    return operationalReadJson({ error: "Invalid operational read query.", code: "INVALID_QUERY" }, 400);
  }
  const sqlPermissionDenied = error !== null && typeof error === "object" && "code" in error && error.code === "42501";
  if (error instanceof CrmCommandError || sqlPermissionDenied) {
    return operationalReadJson({ error: "Access to operational data is not granted.", code: "FORBIDDEN" }, 403);
  }
  return operationalReadJson({ error: "Operational data is temporarily unavailable.", code: "OPERATIONAL_READ_UNAVAILABLE" }, 503);
}
