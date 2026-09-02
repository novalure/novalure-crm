import {
  authorizeBrokerRead,
  authorizeBrokerWrite,
  brokerErrorResponse,
  brokerJson,
  readBrokerMutation,
} from "@/lib/broker-flow/http";
import { parsePagination } from "@/lib/broker-flow/contracts";
import {
  listBrokerViewings,
  saveBrokerViewing,
} from "@/lib/db/broker-operations-repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await authorizeBrokerRead(request);
    if (!auth.ok) return auth.response;
    const url = new URL(request.url);
    const result = await listBrokerViewings({
      contactId: url.searchParams.get("contactId"),
      leadId: url.searchParams.get("leadId"),
      pagination: parsePagination(url),
      projectId: url.searchParams.get("projectId"),
      session: auth.session,
      status: url.searchParams.get("status"),
    });
    return brokerJson({ data: result.items, pagination: result.pagination, persisted: true });
  } catch (error) {
    return brokerErrorResponse(error);
  }
}

async function mutate(request: Request) {
  try {
    const auth = await authorizeBrokerWrite(request);
    if (!auth.ok) return auth.response;
    const mutation = await readBrokerMutation(request, auth.session);
    const result = await saveBrokerViewing({
      idempotencyKey: mutation.idempotencyKey,
      payload: mutation.body.viewing && typeof mutation.body.viewing === "object"
        ? mutation.body.viewing as Record<string, unknown>
        : mutation.body,
      session: auth.session,
    });
    return brokerJson(
      { data: result.data, persisted: true, replayed: result.replayed },
      { status: result.httpStatus },
    );
  } catch (error) {
    return brokerErrorResponse(error);
  }
}

export async function POST(request: Request) {
  return mutate(request);
}

export async function PATCH(request: Request) {
  return mutate(request);
}
