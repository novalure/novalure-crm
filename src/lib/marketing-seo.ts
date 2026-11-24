/** Bounded interchange data, never executable instructions or an ownership claim. */
export const SEO_REPORT_VERSION = "novalure.seo.v1" as const;
export const SEO_IMPORT_MAX_BYTES = 2_000_000;
export type SeoActionStatus = "planned" | "in_progress" | "verified" | "dismissed";
export type SeoReport = {
  version: typeof SEO_REPORT_VERSION; reportId: string; tenantId: string; projectId: string | null; siteUrl: string; generatedAt: string;
  coverage: { attempted: number; checked: number; discovered: number; complete: boolean; excluded: number; errors: Array<{ url: string; code: string }> };
  pages: Array<{ url: string; status: number; title: string | null; description: string | null; canonical: string | null; headings: string[]; robots: string[]; htmlLang: string | null; bytes: number; structuredDataTypes: string[]; structuredDataValid: boolean | null; internalLinks: string[] }>;
  findings: Array<{ id: string; code: string; severity: "high" | "medium" | "low" | "info"; url: string; evidence: string; recommendation: string }>;
  searchData: { source: "google-search-console" | "bing-webmaster" | "none"; period: { startDate: string; endDate: string } | null; rows: Array<{ query: string; page: string | null; country: string | null; device: string | null; clicks: number; impressions: number; ctr: number | null; position: number | null }> };
  actions: Array<{ id: string; findingId: string; url: string; priority: "P1" | "P2" | "P3"; title: string; status: SeoActionStatus }>;
};
export type SeoSite = { id: string; projectId: string; siteUrl: string; createdAt: string };
export type SavedSeoAction = SeoReport["actions"][number] & { revision: number; note: string; updatedAt: string; updatedBy: string };
export type SeoWorkspace = { workspaceId: string; projectId: string | null; installed: boolean; canEdit: boolean; sites: SeoSite[]; reports: Array<{ id: string; siteId: string; projectId: string; reportId: string; generatedAt: string; importedAt: string; pageCount: number; findingCount: number; complete: boolean; searchSource: string }>; selected: { id: string; report: SeoReport; actions: SavedSeoAction[] } | null };

function fail(label: string): never { throw new Error(`SEO import: ${label}`); }
function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`${label}: unknown or invalid fields`);
  const row = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(row, key))) fail(`${label}: missing fields`);
  return row;
}
function text(value: unknown, max: number, label: string, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(label);
  return value;
}
function integer(value: unknown, label: string, max = 10_000_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) fail(label);
  return value;
}
function list(value: unknown, max: number, label: string): unknown[] { if (!Array.isArray(value) || value.length > max) fail(label); return value; }
function nullableText(value: unknown, max: number, label: string) { return value === null ? null : text(value, max, label, true); }
function flag(value: unknown, label: string): boolean { if (typeof value !== "boolean") fail(label); return value; }
function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T { if (typeof value !== "string" || !allowed.includes(value as T)) fail(label); return value as T; }
function metric(value: unknown, max: number, label: string): number | null { if (value === null) return null; if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) fail(label); return value; }
function id(value: unknown, label: string) { const result = text(value, 128, label); if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(result)) fail(label); return result; }
export function seoPublicUrl(value: unknown, origin?: string): string {
  const raw = text(value, 2048, "URL");
  let url: URL; try { url = new URL(raw); } catch { return fail("URL"); }
  const labels = url.hostname.split(".");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || labels.length < 2 || url.hostname.length > 253 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || /(?:^localhost$|\.localhost$|\.local$)/i.test(url.hostname)) fail("public HTTPS DNS URL required");
  for (const key of url.searchParams.keys()) if (/(token|secret|password|authorization|api.?key|session|^code$)/i.test(key)) fail("credential-bearing URL is not allowed");
  if (origin && url.origin !== origin) fail("URL belongs to another site");
  return url.toString();
}
export function seoSiteOrigin(value: unknown): string {
  const url = new URL(seoPublicUrl(value));
  if (url.pathname !== "/" || url.search) fail("siteUrl must be an HTTPS origin");
  return url.origin;
}
/** Explicit PowerShell syntax; no shell evaluation occurs here. */
export function seoAuditPowerShellCommand(workspaceId: string, projectId: string, siteUrl: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return `npm run seo:audit -- --site ${quote(seoSiteOrigin(siteUrl))} --tenant-id ${quote(id(workspaceId, "workspaceId"))} --project-id ${quote(id(projectId, "projectId"))}`;
}
function observedCanonical(value: unknown): string {
  const raw = text(value, 2048, "canonical");
  let url: URL; try { url = new URL(raw); } catch { return fail("canonical"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) fail("canonical");
  for (const key of url.searchParams.keys()) if (/(token|secret|password|authorization|api.?key|session|^code$)/i.test(key)) fail("credential-bearing canonical is not allowed");
  return url.toString();
}
export function parseSeoReport(value: unknown): SeoReport {
  if (new TextEncoder().encode(JSON.stringify(value)).length > SEO_IMPORT_MAX_BYTES) fail("report exceeds 2 MB");
  const r = record(value, ["version", "reportId", "tenantId", "projectId", "siteUrl", "generatedAt", "coverage", "pages", "findings", "searchData", "actions"], "report");
  if (r.version !== SEO_REPORT_VERSION) fail("unsupported version");
  const siteUrl = seoSiteOrigin(r.siteUrl);
  const generatedAt = text(r.generatedAt, 40, "generatedAt");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(generatedAt) || !Number.isFinite(Date.parse(generatedAt)) || Date.parse(generatedAt) > Date.now() + 300_000) fail("generatedAt");
  const c = record(r.coverage, ["attempted", "checked", "discovered", "complete", "excluded", "errors"], "coverage");
  const pages = list(r.pages, 500, "pages").map((value): SeoReport["pages"][number] => {
    const p = record(value, ["url", "status", "title", "description", "canonical", "headings", "robots", "htmlLang", "bytes", "structuredDataTypes", "structuredDataValid", "internalLinks"], "page");
    const status = integer(p.status, "status", 599); if (status < 100) fail("HTTP status");
    return { url: seoPublicUrl(p.url, siteUrl), status, title: nullableText(p.title, 2000, "title"), description: nullableText(p.description, 2000, "description"), canonical: p.canonical === null ? null : observedCanonical(p.canonical), headings: list(p.headings, 100, "headings").map(v => text(v, 2000, "heading", true)), robots: list(p.robots, 50, "robots").map(v => text(v, 500, "robots", true)), htmlLang: nullableText(p.htmlLang, 80, "htmlLang"), bytes: integer(p.bytes, "bytes", Number.MAX_SAFE_INTEGER), structuredDataTypes: list(p.structuredDataTypes, 100, "structuredDataTypes").map(v => text(v, 120, "structuredDataType")), structuredDataValid: p.structuredDataValid === null ? null : flag(p.structuredDataValid, "structuredDataValid"), internalLinks: list(p.internalLinks, 2000, "internalLinks").map(v => seoPublicUrl(v, siteUrl)) };
  });
  if (new Set(pages.map(p => p.url)).size !== pages.length) fail("duplicate page URL");
  const coverage: SeoReport["coverage"] = { attempted: integer(c.attempted, "attempted", 10_000), checked: integer(c.checked, "checked", 500), discovered: integer(c.discovered, "discovered", 100_000), complete: flag(c.complete, "complete"), excluded: integer(c.excluded, "excluded", 100_000), errors: list(c.errors, 1000, "errors").map(value => { const e = record(value, ["url", "code"], "error"); return { url: seoPublicUrl(e.url, siteUrl), code: text(e.code, 200, "error code") }; }) };
  if (coverage.checked !== pages.length || coverage.attempted < coverage.checked || coverage.discovered < coverage.attempted || (coverage.complete && (coverage.errors.length > 0 || coverage.checked + coverage.excluded < coverage.discovered))) fail("inconsistent coverage");
  const findings = list(r.findings, 2000, "findings").map((value): SeoReport["findings"][number] => { const f = record(value, ["id", "code", "severity", "url", "evidence", "recommendation"], "finding"); const code = text(f.code, 100, "finding code"); if (!/^[A-Z][A-Z0-9_]*$/.test(code)) fail("finding code"); return { id: id(f.id, "finding id"), code, severity: choice(f.severity, ["high", "medium", "low", "info"], "severity"), url: seoPublicUrl(f.url, siteUrl), evidence: text(f.evidence, 2000, "evidence", true), recommendation: text(f.recommendation, 2000, "recommendation", true) }; });
  if (new Set(findings.map(f => f.id)).size !== findings.length) fail("duplicate finding id");
  const s = record(r.searchData, ["source", "period", "rows"], "searchData");
  const source = choice(s.source, ["none", "google-search-console", "bing-webmaster"], "search source");
  let period: SeoReport["searchData"]["period"] = null;
  if (s.period !== null) { const p = record(s.period, ["startDate", "endDate"], "period"); const date = (v: unknown) => { const d = text(v, 10, "date"); if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d) fail("date"); return d; }; period = { startDate: date(p.startDate), endDate: date(p.endDate) }; if (period.startDate > period.endDate) fail("period order"); }
  const rows = list(s.rows, 5000, "search rows").map((value): SeoReport["searchData"]["rows"][number] => { const row = record(value, ["query", "page", "country", "device", "clicks", "impressions", "ctr", "position"], "search row"); const clicks = integer(row.clicks, "clicks", Number.MAX_SAFE_INTEGER), impressions = integer(row.impressions, "impressions", Number.MAX_SAFE_INTEGER); if (clicks > impressions) fail("clicks exceed impressions"); return { query: text(row.query, 2000, "query", true), page: row.page === null ? null : seoPublicUrl(row.page, siteUrl), country: nullableText(row.country, 64, "country"), device: nullableText(row.device, 32, "device"), clicks, impressions, ctr: metric(row.ctr, 1, "ctr"), position: metric(row.position, Number.MAX_VALUE, "position") }; });
  if (new Set(rows.map(row => JSON.stringify([row.query, row.page, row.country, row.device]))).size !== rows.length) fail("duplicate search dimensions");
  if ((source === "none" && (period !== null || rows.length > 0)) || (source !== "none" && !period)) fail("search source and period mismatch");
  const actions = list(r.actions, 2000, "actions").map((value): SeoReport["actions"][number] => { const a = record(value, ["id", "findingId", "url", "priority", "title", "status"], "action"); const findingId = id(a.findingId, "findingId"), finding = findings.find(f => f.id === findingId); const url = seoPublicUrl(a.url, siteUrl); if (!finding || finding.url !== url) fail("action finding mismatch"); return { id: id(a.id, "action id"), findingId, url, priority: choice(a.priority, ["P1", "P2", "P3"], "priority"), title: text(a.title, 2000, "action title", true), status: choice(a.status, ["planned", "in_progress", "verified", "dismissed"], "action status") }; });
  if (new Set(actions.map(a => a.id)).size !== actions.length) fail("duplicate action id");
  return { version: SEO_REPORT_VERSION, reportId: id(r.reportId, "reportId"), tenantId: id(r.tenantId, "tenantId"), projectId: r.projectId === null ? null : id(r.projectId, "projectId"), siteUrl, generatedAt, coverage, pages, findings, searchData: { source, period, rows }, actions };
}

export function seoSearchSummary(rows: SeoReport["searchData"]["rows"]) {
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0), impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const known = rows.filter(row => row.position !== null && row.impressions > 0), weight = known.reduce((sum, row) => sum + row.impressions, 0);
  return { clicks, impressions, ctr: impressions ? clicks / impressions : null, position: weight ? known.reduce((sum, row) => sum + row.position! * row.impressions, 0) / weight : null };
}
