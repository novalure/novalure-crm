import {
  authorizeBrokerRead,
  authorizeBrokerWrite,
  brokerErrorResponse,
  brokerJson,
  readBrokerMutation,
} from "@/lib/broker-flow/http";
import { BrokerDomainError, parsePagination } from "@/lib/broker-flow/contracts";
import { canManageBrokerFinancials } from "@/lib/broker-flow/access-policy";
import { buildClosingCsv, buildClosingPdf } from "@/lib/broker-flow/closing-export";
import {
  listBrokerClosings,
  saveBrokerClosing,
} from "@/lib/db/broker-operations-repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await authorizeBrokerRead(request);
    if (!auth.ok) return auth.response;
    const url = new URL(request.url);
    const result = await listBrokerClosings({
      closingId: url.searchParams.get("closingId"),
      contactId: url.searchParams.get("contactId"),
      pagination: parsePagination(url),
      projectId: url.searchParams.get("projectId"),
      session: auth.session,
      status: url.searchParams.get("status"),
    });
    const format = url.searchParams.get("format");
    if (format === "csv" || format === "pdf") {
      if (!canManageBrokerFinancials(auth.session) || !result.financialsVisible) {
        throw new BrokerDomainError("financial_permission_required", "Financial permission is required for closing exports.", 403);
      }
      if (format === "pdf") {
        return new Response(buildClosingPdf(result.items as Array<Record<string, unknown>>), {
          headers: {
            "Cache-Control": "no-store, private",
            "Content-Disposition": 'attachment; filename="novalure-closing-commission-report.pdf"',
            "Content-Type": "application/pdf",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      return new Response(buildClosingCsv(result.items as Array<Record<string, unknown>>), {
        headers: {
          "Cache-Control": "no-store, private",
          "Content-Disposition": 'attachment; filename="novalure-closings.csv"',
          "Content-Type": "text/csv; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return brokerJson({
      data: result.items,
      financialsVisible: result.financialsVisible,
      pagination: result.pagination,
      persisted: true,
    });
  } catch (error) {
    return brokerErrorResponse(error);
  }
}

async function mutate(request: Request) {
  try {
    const auth = await authorizeBrokerWrite(request);
    if (!auth.ok) return auth.response;
    const mutation = await readBrokerMutation(request);
    const result = await saveBrokerClosing({
      idempotencyKey: mutation.idempotencyKey,
      payload: mutation.body.closing && typeof mutation.body.closing === "object"
        ? mutation.body.closing as Record<string, unknown>
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
