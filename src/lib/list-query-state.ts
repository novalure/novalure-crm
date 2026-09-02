export const crmEntityKinds = [
  "contact",
  "organization",
  "lead",
  "property",
  "unit",
  "project",
  "deal",
  "task",
  "document",
  "template",
  "closing",
] as const;

export type CrmEntityKind = (typeof crmEntityKinds)[number];
export type ListSortDirection = "asc" | "desc";

export type ListQueryState = Readonly<{
  direction: ListSortDirection;
  filters: Readonly<Record<string, readonly string[]>>;
  page: number;
  pageSize: number;
  query: string;
  sort: string;
}>;

export type ListQueryOptions = Readonly<{
  allowedFilters?: readonly string[];
  allowedSorts: readonly string[];
  defaultPageSize?: number;
  defaultSort: string;
  maxPageSize?: number;
}>;

export type CrmEntityDeepLinkTarget = Readonly<{
  entityId: string;
  entityType: CrmEntityKind;
  projectId: string | null;
  tab: string | null;
  workspaceId: string;
}>;

const safeIdentifierPattern = /^[A-Za-z0-9:_-]{1,120}$/;
const safeSectionPattern = /^[a-z][a-zA-Z0-9]{0,63}$/;

function boundedPositiveInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function boundedText(value: string | null, maximum: number) {
  return (value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
}

function asUrl(value: string | URL) {
  return value instanceof URL ? new URL(value) : new URL(value, "https://crm.novalure.invalid");
}

export function parseListQueryState(value: string | URL, options: ListQueryOptions): ListQueryState {
  if (!options.allowedSorts.includes(options.defaultSort)) {
    throw new Error("defaultSort must be included in allowedSorts");
  }

  const url = asUrl(value);
  const defaultPageSize = Math.max(1, options.defaultPageSize ?? 25);
  const maxPageSize = Math.max(defaultPageSize, options.maxPageSize ?? 100);
  const requestedSort = boundedText(url.searchParams.get("sort"), 64);
  const filters: Record<string, readonly string[]> = {};

  for (const key of options.allowedFilters ?? []) {
    const values = url.searchParams
      .getAll(`filter.${key}`)
      .flatMap((entry) => entry.split(","))
      .map((entry) => boundedText(entry, 120))
      .filter(Boolean);
    if (values.length) filters[key] = [...new Set(values)].slice(0, 20);
  }

  return Object.freeze({
    direction: url.searchParams.get("direction") === "asc" ? "asc" : "desc",
    filters: Object.freeze(filters),
    page: boundedPositiveInteger(url.searchParams.get("page"), 1, 100_000),
    pageSize: boundedPositiveInteger(url.searchParams.get("pageSize"), defaultPageSize, maxPageSize),
    query: boundedText(url.searchParams.get("q"), 160),
    sort: options.allowedSorts.includes(requestedSort) ? requestedSort : options.defaultSort,
  });
}

export function serializeListQueryState(
  currentUrl: string | URL,
  state: ListQueryState,
  options: Readonly<{ preserveUnknown?: boolean }> = {},
) {
  const url = asUrl(currentUrl);
  const preservedScope = new URLSearchParams();

  if (options.preserveUnknown !== false) {
    for (const [key, value] of url.searchParams) {
      if (!["q", "page", "pageSize", "sort", "direction"].includes(key) && !key.startsWith("filter.")) {
        preservedScope.append(key, value);
      }
    }
  }

  if (state.query) preservedScope.set("q", boundedText(state.query, 160));
  preservedScope.set("page", String(Math.max(1, Math.trunc(state.page))));
  preservedScope.set("pageSize", String(Math.max(1, Math.trunc(state.pageSize))));
  preservedScope.set("sort", boundedText(state.sort, 64));
  preservedScope.set("direction", state.direction === "asc" ? "asc" : "desc");

  for (const key of Object.keys(state.filters).sort()) {
    for (const value of state.filters[key] ?? []) {
      const normalized = boundedText(String(value), 120);
      if (normalized) preservedScope.append(`filter.${key}`, normalized);
    }
  }

  url.search = preservedScope.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildCrmEntityDeepLink(input: Readonly<{
  currentUrl?: string | URL;
  entityId: string;
  entityType: CrmEntityKind;
  projectId?: string | null;
  section: string;
  tab?: string | null;
  workspaceId: string;
}>) {
  if (!safeIdentifierPattern.test(input.entityId)) throw new Error("Invalid entityId");
  if (!safeIdentifierPattern.test(input.workspaceId)) throw new Error("Invalid workspaceId");
  if (input.projectId && !safeIdentifierPattern.test(input.projectId)) throw new Error("Invalid projectId");
  if (!safeSectionPattern.test(input.section)) throw new Error("Invalid section");
  if (input.tab && !safeIdentifierPattern.test(input.tab)) throw new Error("Invalid tab");
  if (!crmEntityKinds.includes(input.entityType)) throw new Error("Unsupported entityType");

  const url = asUrl(input.currentUrl ?? "/");
  url.searchParams.set("workspaceId", input.workspaceId);
  url.searchParams.set("projectId", input.projectId ?? "all");
  url.searchParams.set("entity", input.entityType);
  url.searchParams.set("entityId", input.entityId);
  if (input.tab) url.searchParams.set("tab", input.tab);
  else url.searchParams.delete("tab");
  url.hash = input.section;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function parseCrmEntityDeepLink(value: string | URL): CrmEntityDeepLinkTarget | null {
  const url = asUrl(value);
  const entityType = url.searchParams.get("entity") as CrmEntityKind | null;
  const entityId = url.searchParams.get("entityId") ?? "";
  const workspaceId = url.searchParams.get("workspaceId") ?? "";
  const rawProjectId = url.searchParams.get("projectId");
  const tab = url.searchParams.get("tab");

  if (!entityType || !crmEntityKinds.includes(entityType)) return null;
  if (!safeIdentifierPattern.test(entityId) || !safeIdentifierPattern.test(workspaceId)) return null;
  if (rawProjectId && rawProjectId !== "all" && !safeIdentifierPattern.test(rawProjectId)) return null;
  if (tab && !safeIdentifierPattern.test(tab)) return null;

  return Object.freeze({
    entityId,
    entityType,
    projectId: rawProjectId && rawProjectId !== "all" ? rawProjectId : null,
    tab,
    workspaceId,
  });
}

export function getPageWindow(input: Readonly<{ page: number; pageSize: number; total: number }>) {
  const pageSize = Math.max(1, Math.trunc(input.pageSize));
  const pageCount = Math.max(1, Math.ceil(Math.max(0, input.total) / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.trunc(input.page)));
  const from = input.total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(input.total, page * pageSize);

  return Object.freeze({
    from,
    hasNext: page < pageCount,
    hasPrevious: page > 1,
    page,
    pageCount,
    to,
  });
}
