export type FunnelCommandView = "all" | "active" | "optimize" | "blocked" | "bots";

export type FunnelCommandEntity = {
  funnel: {
    id: string;
    leads: number;
    status: string;
    visits: number;
  };
  steps: Array<{
    botRuleId?: string;
    status: string;
    type?: string;
  }>;
};

export const funnelMetricSemantics = {
  attribution: "funnels.entry_channel (aggregate includes all channels)",
  denominator: "sum(funnels.leads_count) / sum(funnels.visits)",
  excludes: ["project-wide CRM leads", "test submission records"],
  period: "lifetime stored counters (no event-time filter)",
  scope: "funnels in the current workspace",
  source: "funnels.visits and funnels.leads_count",
} as const;

export function isPersistedFunnelId(value: string | undefined | null) {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

export function isExplicitFixtureDemoMode(input: { nodeEnv: string | undefined; requestedMode: string | null }) {
  return input.nodeEnv !== "production" && input.requestedMode === "demo";
}

export function mergeFunnelRecordsById<T extends { id: string }>(persisted: T[], localDrafts: T[]) {
  const records = new Map(persisted.map((funnel) => [funnel.id, funnel]));
  for (const draft of localDrafts) records.set(draft.id, draft);
  return Array.from(records.values());
}

export function funnelMatchesView(item: FunnelCommandEntity, view: FunnelCommandView) {
  if (view === "all") return true;
  if (view === "active") return item.funnel.status === "aktiv";
  if (view === "optimize") return item.funnel.status === "optimieren";
  if (view === "blocked") return item.steps.some((step) => step.status === "blockiert");
  return item.steps.some((step) => Boolean(step.botRuleId) || step.type === "Bot");
}

export function getFunnelViewCounts(items: FunnelCommandEntity[]) {
  return {
    all: items.length,
    active: items.filter((item) => funnelMatchesView(item, "active")).length,
    optimize: items.filter((item) => funnelMatchesView(item, "optimize")).length,
    blocked: items.filter((item) => funnelMatchesView(item, "blocked")).length,
    bots: items.filter((item) => funnelMatchesView(item, "bots")).length,
  };
}

function nonNegativeFinite(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function getFunnelLifetimeMetrics(items: FunnelCommandEntity[]) {
  const visits = items.reduce((sum, item) => sum + nonNegativeFinite(item.funnel.visits), 0);
  const leads = items.reduce((sum, item) => sum + nonNegativeFinite(item.funnel.leads), 0);

  return {
    conversionRate: visits > 0 ? (leads / visits) * 100 : 0,
    denominator: visits,
    leads,
    visits,
  };
}
