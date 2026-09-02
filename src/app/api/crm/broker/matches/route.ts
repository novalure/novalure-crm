import {
  authorizeBrokerRead,
  authorizeBrokerWrite,
  brokerErrorResponse,
  brokerJson,
  readBrokerMutation,
} from "@/lib/broker-flow/http";
import { BrokerDomainError, cleanString, parsePagination, requiredInteger, requiredUuid } from "@/lib/broker-flow/contracts";
import {
  listLiveBrokerMatches,
  persistBrokerMatchEvaluation,
  saveBrokerMatchDecision,
} from "@/lib/db/broker-operations-repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await authorizeBrokerRead(request);
    if (!auth.ok) return auth.response;
    const url = new URL(request.url);
    const result = await listLiveBrokerMatches({
      pagination: parsePagination(url),
      profileId: requiredUuid(url.searchParams.get("profileId"), "profileId"),
      projectId: requiredUuid(url.searchParams.get("projectId"), "projectId"),
      session: auth.session,
    });
    return brokerJson({ data: result.items, matching: {
      algorithmVersion: result.algorithmVersion,
      recalculatedAt: result.recalculatedAt,
      source: result.source,
    }, pagination: result.pagination, persisted: true });
  } catch (error) {
    return brokerErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authorizeBrokerWrite(request);
    if (!auth.ok) return auth.response;
    const mutation = await readBrokerMutation(request, auth.session);
    const operation = cleanString(mutation.body.operation, 80) || "recalculate";
    const result = operation === "decision"
      ? await saveBrokerMatchDecision({
          idempotencyKey: mutation.idempotencyKey,
          payload: mutation.body,
          session: auth.session,
        })
      : operation === "recalculate"
        ? await persistBrokerMatchEvaluation({
            idempotencyKey: mutation.idempotencyKey,
            pagination: {
              limit: mutation.body.limit === undefined ? 100 : requiredInteger(mutation.body.limit, "limit", 1, 100),
              offset: mutation.body.offset === undefined ? 0 : requiredInteger(mutation.body.offset, "offset", 0, 1_000_000),
            },
            profileId: requiredUuid(mutation.body.profileId, "profileId"),
            projectId: requiredUuid(mutation.body.projectId, "projectId"),
            session: auth.session,
          })
        : null;
    if (!result) throw new BrokerDomainError("unsupported_operation", "Unsupported match operation.");
    return brokerJson(
      { data: result.data, persisted: true, replayed: result.replayed },
      { status: result.httpStatus },
    );
  } catch (error) {
    return brokerErrorResponse(error);
  }
}
