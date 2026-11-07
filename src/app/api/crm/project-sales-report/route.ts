import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, executeCrmCommand, withCrmRead } from "@/lib/crm-command";
import { loadProjectSalesReport, saveProjectReportSettings } from "@/lib/db/project-sales-report-repository";
import { buildProjectSalesReportCsv, localizeProjectSalesReport } from "@/lib/project-sales-report";
import { readBoundedJsonObject } from "@/lib/external-api-response";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url), projectId = assertCrmUuid(url.searchParams.get("projectId")), month = url.searchParams.get("month") ?? "";
    const loaded = await withCrmRead(auth.session, (tx, session) => loadProjectSalesReport(tx, session, projectId, month));
    const data = localizeProjectSalesReport(loaded, url.searchParams.get("lang") ?? "de");
    if (url.searchParams.get("format") === "csv") return new Response(buildProjectSalesReportCsv(data), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="novalure-project-${projectId}-${month}.csv"`, "X-Content-Type-Options": "nosniff" } });
    return Response.json({ data, persisted: true }, { headers });
  } catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" }); if (!auth.ok) return auth.response;
  try {
    const body = await readBoundedJsonObject(request), projectId = assertCrmUuid(body.projectId);
    const result = await executeCrmCommand(auth.session, { ...crmRequestMetadata(request, body), operation: "project_report.settings", resourceId: projectId, projectId, capability: "settings:manage", payload: body }, (tx, context) => saveProjectReportSettings(tx, context.session, projectId, body.settings, Number(body.expectedRevision)));
    return Response.json({ data: result.data, persisted: true, replayed: result.replayed }, { headers });
  } catch (error) { return crmCommandErrorResponse(error); }
}
