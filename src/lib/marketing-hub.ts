export type MarketingArea = "overview" | "campaigns" | "flows" | "mailings" | "audiences" | "templates" | "reports";
export type MarketingSourceTarget = { kind: "newsletter" | "automation" | "funnel" | "expose" | "form"; id: string; projectId: string | null; propertyId?: string };
export type MarketingOverview = {
  workspaceId: string;
  projectId: string | null;
  asOf: string;
  modules: { newsletter: boolean; flows: boolean; funnels: boolean; properties: boolean; contacts: boolean; reports: boolean; communication: boolean };
  counts: { campaigns: number | null; audiences: number | null; mailTemplates: number | null; mailings: number | null; approvalNeeded: number | null; planned: number | null; flows: number | null; activeFlows: number | null; funnels: number | null; activeFunnels: number | null; publications: number | null };
  review: Array<{ key: string; title: string; reason: "approval" | "delivery_unknown" | "schedule_blocked" | "flow_review"; target: MarketingSourceTarget }>;
  reviewLimited: boolean;
  newsletterProviderConfigured: boolean;
};
