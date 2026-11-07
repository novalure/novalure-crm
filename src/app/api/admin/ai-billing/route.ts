import { applyAdminAiBillingAction, readAdminAiBilling } from "@/lib/ai-billing/admin-repository";
import { readAiBillingAdminAction, requireAiBillingAdminSession } from "@/lib/ai-billing/admin-http";
import { aiBillingErrorResponse, aiBillingJson } from "@/lib/ai-billing/http";

export async function GET(request: Request) {
  try {
    const auth = await requireAiBillingAdminSession(request);
    if (!auth.ok) return auth.response;
    const targetWorkspaceId = new URL(request.url).searchParams.get("targetWorkspaceId") ?? undefined;
    const status = new URL(request.url).searchParams.get("status") as "pending" | "fulfilled" | "cancelled" | null;
    return aiBillingJson(await readAdminAiBilling(auth.session, { targetWorkspaceId, ...(status ? { status } : {}) }));
  } catch (error) { return aiBillingErrorResponse(error); }
}

/** A trusted internal confirmation applies a saved request; it never charges a payment method. */
export async function POST(request: Request) {
  try {
    const auth = await requireAiBillingAdminSession(request);
    if (!auth.ok) return auth.response;
    const action = await readAiBillingAdminAction(request);
    return aiBillingJson(await applyAdminAiBillingAction(auth.session, action));
  } catch (error) { return aiBillingErrorResponse(error); }
}
