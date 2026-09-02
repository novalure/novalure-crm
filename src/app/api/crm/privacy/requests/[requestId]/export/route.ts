import { assertUuid } from "@/lib/content-library";
import { getDataSubjectRequest } from "@/lib/db/privacy-lifecycle-repository";
import { buildDataSubjectRequestMetadataCsv } from "@/lib/privacy-lifecycle";
import { resolvePrivacyScopedSession } from "../../../_shared";
import { contentRouteError } from "../../../../documents/_shared";

type RouteContext = { params: Promise<{ requestId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await resolvePrivacyScopedSession(request);
  if (!auth.ok) return auth.response;
  try {
    const { requestId } = await context.params;
    const record = await getDataSubjectRequest({
      session: auth.session,
      requestId: assertUuid(requestId, "requestId"),
    });
    if (!record) return new Response("Not found", { status: 404 });
    const csv = buildDataSubjectRequestMetadataCsv({
      id: record.id,
      requestReference: record.requestReference,
      requestType: record.requestType,
      status: record.status,
      contactId: record.contactId,
      dueAt: record.dueAt as string | null,
      exportJobMetadata: record.exportJobMetadata,
      reviewedAt: record.reviewedAt as string | null,
      updatedAt: record.updatedAt as string,
    });
    const filePart = record.requestReference.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || record.id;
    return new Response(`\uFEFF${csv}`, {
      headers: {
        "Cache-Control": "no-store, private",
        "Content-Disposition": `attachment; filename="dsar-${filePart}.csv"`,
        "Content-Type": "text/csv; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return contentRouteError(error);
  }
}
