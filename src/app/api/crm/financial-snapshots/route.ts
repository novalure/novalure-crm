import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  assertCrmFields,
  crmCommandErrorResponse,
  crmRequestMetadata,
  CrmCommandError,
} from "@/lib/crm-command";
import {
  getFinancialSnapshot,
  getOfferFinancialSnapshot,
  listFinancialReviewQueue,
  resolveLegacyFinancialSnapshot,
  type LegacyFinancialSnapshotResolutionInput,
} from "@/lib/db/financial-snapshot-repositories";
import { readBoundedCrmJson } from "@/lib/crm-request-body";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

function failure(error: unknown, correlationId?: string) {
  const response = crmCommandErrorResponse(error, correlationId);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const query = new URL(request.url).searchParams;
    const snapshotId = query.get("snapshotId");
    const projectId = query.get("projectId");
    const offerId = query.get("offerId");
    if ([snapshotId, projectId, offerId].filter(Boolean).length !== 1) {
      throw new CrmCommandError("INVALID_REQUEST", "Select one financial view");
    }
    if (snapshotId) {
      const snapshot = await getFinancialSnapshot(auth.session, snapshotId);
      return Response.json({ snapshot }, { headers: noStore });
    }
    if (projectId) {
      const snapshots = await listFinancialReviewQueue(auth.session, projectId);
      return Response.json({ reviewState: "NEEDS_REVIEW", snapshots }, { headers: noStore });
    }
    if (offerId) {
      const snapshot = await getOfferFinancialSnapshot(auth.session, offerId);
      return Response.json({ snapshot }, { headers: noStore });
    }
    throw new CrmCommandError("INVALID_REQUEST", "snapshotId, projectId or offerId is required");
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, {
    permission: "crm:write",
    capability: "settings:manage",
  });
  if (!auth.ok) return auth.response;
  let correlationId: string | undefined;
  try {
    const raw = await readBoundedCrmJson(request);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CrmCommandError("INVALID_REQUEST", "JSON object required");
    }
    const input = raw as Record<string, unknown>;
    assertCrmFields(input, [
      "projectId",
      "priorSnapshotId",
      "expectedPriorSnapshotHash",
      "policySelection",
      "reviewDecision",
      "idempotencyKey",
      "correlationId",
    ]);
    const metadata = crmRequestMetadata(request, input);
    correlationId = metadata.correlationId;
    const result = await resolveLegacyFinancialSnapshot(auth.session, {
      ...input,
      ...metadata,
    } as unknown as LegacyFinancialSnapshotResolutionInput);
    return Response.json({ ...result, correlationId }, { headers: noStore });
  } catch (error) { return failure(error, correlationId); }
}
