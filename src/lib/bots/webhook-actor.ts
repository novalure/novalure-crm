import type { ProductRole, TechnicalAppRole } from "@/lib/product-model";

export const botWebhookActorProductRoles = [
  "platform_admin",
  "novalureGrowth",
  "novalureAdmin",
  "novalure_sales",
  "novalure_onboarding",
  "novalure_customer_success",
  "novalure_operator",
  "customer_owner",
  "workspace_admin",
] as const satisfies readonly ProductRole[];

export type BotWebhookActorProductRole = (typeof botWebhookActorProductRoles)[number];
export type BotWebhookActorTechnicalRole = Exclude<TechnicalAppRole, "assistant">;
export type EligibleBotWebhookActor = {
  productRole: BotWebhookActorProductRole;
  role: BotWebhookActorTechnicalRole;
  status: "active";
};

export function isEligibleBotWebhookActor<Candidate extends {
  productRole: unknown;
  role: unknown;
  status: unknown;
}>(input: Candidate): input is Candidate & EligibleBotWebhookActor {
  return input.status === "active"
    && (input.role === "owner" || input.role === "admin" || input.role === "agent")
    && typeof input.productRole === "string"
    && botWebhookActorProductRoles.includes(input.productRole as BotWebhookActorProductRole);
}

export function selectBotWebhookActor<Candidate extends {
  id: string;
  productRole: unknown;
  role: unknown;
  status: unknown;
}>(
  candidates: readonly Candidate[],
  connectedByUserId?: string | null,
): (Candidate & EligibleBotWebhookActor) | null {
  return candidates
    .filter(isEligibleBotWebhookActor)
    .sort((left, right) => {
      const leftConnected = left.id === connectedByUserId ? 0 : 1;
      const rightConnected = right.id === connectedByUserId ? 0 : 1;
      if (leftConnected !== rightConnected) return leftConnected - rightConnected;
      const rolePriority = { owner: 0, admin: 1, agent: 2 } as const;
      const roleDifference = rolePriority[left.role] - rolePriority[right.role];
      return roleDifference || left.id.localeCompare(right.id);
    })[0] ?? null;
}
