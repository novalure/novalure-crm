import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  assertCrmFields,
  crmCommandErrorResponse,
  crmRequestMetadata,
  CrmCommandError,
} from "@/lib/crm-command";
import {
  registerFinancialPolicyVersion,
  type FinancialPolicyRegistrationInput,
} from "@/lib/db/financial-snapshot-repositories";
import { readBoundedCrmJson } from "@/lib/crm-request-body";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

function failure(error: unknown, correlationId?: string) {
  const response = crmCommandErrorResponse(error, correlationId);
  response.headers.set("Cache-Control", "no-store");
  return response;
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
    assertCrmFields(input, ["projectId", "policyId", "policyVersion", "payload", "sourceReference",
      "verifiedAt", "idempotencyKey", "correlationId"]);
    const metadata = crmRequestMetadata(request, input);
    correlationId = metadata.correlationId;
    const result = await registerFinancialPolicyVersion(auth.session, {
      ...input,
      ...metadata,
    } as unknown as FinancialPolicyRegistrationInput);
    return Response.json({ ...result, correlationId }, { headers: noStore });
  } catch (error) { return failure(error, correlationId); }
}
