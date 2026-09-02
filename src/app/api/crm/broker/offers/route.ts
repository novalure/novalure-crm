import {
  authorizeBrokerRead,
  authorizeBrokerWrite,
  brokerErrorResponse,
  brokerJson,
  readBrokerMutation,
} from "@/lib/broker-flow/http";
import { BrokerDomainError, cleanString, parsePagination, requiredUuid } from "@/lib/broker-flow/contracts";
import {
  listBrokerOffers,
  requestBrokerOfferQaDelivery,
  saveBrokerOffer,
} from "@/lib/db/broker-operations-repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await authorizeBrokerRead(request);
    if (!auth.ok) return auth.response;
    const url = new URL(request.url);
    const result = await listBrokerOffers({
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
    const mutation = await readBrokerMutation(request);
    const operation = cleanString(mutation.body.operation, 80) || "save";
    const result = operation === "qa_delivery"
      ? await requestBrokerOfferQaDelivery({
          idempotencyKey: mutation.idempotencyKey,
          offerId: requiredUuid(mutation.body.offerId, "offerId"),
          session: auth.session,
        })
      : operation === "save"
        ? await saveBrokerOffer({
            idempotencyKey: mutation.idempotencyKey,
            payload: mutation.body.offer && typeof mutation.body.offer === "object"
              ? mutation.body.offer as Record<string, unknown>
              : mutation.body,
            session: auth.session,
          })
        : null;
    if (!result) throw new BrokerDomainError("unsupported_operation", "Unsupported offer operation.");
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
