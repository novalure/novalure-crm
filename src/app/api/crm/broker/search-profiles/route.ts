import { parsePagination } from "@/lib/broker-flow/contracts";
import {
  authorizeBrokerRead,
  authorizeBrokerWrite,
  brokerErrorResponse,
  brokerJson,
  readBrokerMutation,
} from "@/lib/broker-flow/http";
import { listBrokerSearchProfiles, saveBrokerSearchProfile } from "@/lib/db/broker-operations-repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await authorizeBrokerRead(request);
    if (!auth.ok) return auth.response;
    const url = new URL(request.url);
    const result = await listBrokerSearchProfiles({
      contactId: url.searchParams.get("contactId"),
      leadId: url.searchParams.get("leadId"),
      pagination: parsePagination(url),
      projectId: url.searchParams.get("projectId"),
      q: url.searchParams.get("q"),
      session: auth.session,
      status: url.searchParams.get("status"),
    });
    return brokerJson({ pagination: result.pagination, persisted: true, profiles: result.items, source: "database" });
  } catch (error) {
    return brokerErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authorizeBrokerWrite(request);
    if (!auth.ok) return auth.response;
    const mutation = await readBrokerMutation(request);
    const profile = mutation.body.profile && typeof mutation.body.profile === "object"
      ? mutation.body.profile as Record<string, unknown>
      : mutation.body;
    const result = await saveBrokerSearchProfile({
      idempotencyKey: mutation.idempotencyKey,
      payload: profile,
      session: auth.session,
    });
    return brokerJson(
      { persisted: true, profile: result.data, replayed: result.replayed },
      { status: result.httpStatus },
    );
  } catch (error) {
    return brokerErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  return POST(request);
}
