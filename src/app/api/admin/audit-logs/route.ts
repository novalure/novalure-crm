import { getRequestSession } from "@/lib/auth/session";
import { listAdminAuditLogs, type AdminAuditLogEntry } from "@/lib/db/admin-repositories";
import { hasProductCapability, type ProductRole } from "@/lib/product-model";

const auditReaderRoles = new Set<ProductRole>(["platform_admin", "novalureAdmin", "novalureServiceOps"]);
const auditExporterRoles = new Set<ProductRole>(["platform_admin", "novalureAdmin"]);
const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

function boundedText(value: string | null) {
  return (value ?? "").trim().slice(0, 80);
}

function positiveInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function canReadAudit(productRole: ProductRole) {
  return auditReaderRoles.has(productRole) && hasProductCapability(productRole, "novalure:internal");
}

function canExportAudit(productRole: ProductRole) {
  return auditExporterRoles.has(productRole) && hasProductCapability(productRole, "settings:manage");
}

function csvCell(value: string | null) {
  let normalized = value ?? "";
  if (/^[=+\-@]/.test(normalized)) normalized = `'${normalized}`;
  return `"${normalized.replaceAll('"', '""')}"`;
}

function toCsv(entries: AdminAuditLogEntry[]) {
  const header = ["created_at", "actor", "action", "entity_type", "entity_id", "project_id"];
  const rows = entries.map((entry) => [
    entry.createdAt,
    entry.actorName,
    entry.action,
    entry.entityType,
    entry.entityId,
    entry.projectId,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export async function GET(request: Request) {
  const session = await getRequestSession(request);
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { headers: privateHeaders, status: 401 });
  }
  if (!canReadAudit(session.productRole)) {
    return Response.json({ error: "Forbidden" }, { headers: privateHeaders, status: 403 });
  }

  const url = new URL(request.url);
  const format = url.searchParams.get("format");
  if (format && format !== "csv") {
    return Response.json({ error: "Unsupported format" }, { headers: privateHeaders, status: 400 });
  }
  if (format === "csv" && !canExportAudit(session.productRole)) {
    return Response.json({ error: "Forbidden" }, { headers: privateHeaders, status: 403 });
  }

  const page = format === "csv" ? 1 : positiveInteger(url.searchParams.get("page"), 1, 10_000);
  const pageSize = format === "csv"
    ? 1_000
    : positiveInteger(url.searchParams.get("pageSize"), 20, 50);

  try {
    const result = await listAdminAuditLogs({
      action: boundedText(url.searchParams.get("action")),
      entityType: boundedText(url.searchParams.get("entityType")),
      page,
      pageSize,
      query: boundedText(url.searchParams.get("q")),
      workspaceId: session.workspaceId,
    });

    if (format === "csv") {
      return new Response(toCsv(result.entries), {
        headers: {
          ...privateHeaders,
          "Content-Disposition": 'attachment; filename="novalure-audit-log.csv"',
          "Content-Type": "text/csv; charset=utf-8",
        },
      });
    }

    return Response.json(
      {
        canExport: canExportAudit(session.productRole),
        entries: result.entries,
        page,
        pageSize,
        total: result.total,
      },
      {
        headers: privateHeaders,
      },
    );
  } catch {
    return Response.json(
      { error: "Audit log unavailable" },
      { headers: privateHeaders, status: 503 },
    );
  }
}
