import type { FunnelVariant } from "@/lib/funnel-schema";

export type FunnelVariantResult = {
  id: string;
  name: string;
  visits: number;
  conversions: number;
  conversionRate: number;
  confidenceLabel: "zu wenig Daten" | "Tendenz" | "stark";
  liftAgainstControl: number;
  isWinner: boolean;
};

export function calculateAbTestResults(variants: FunnelVariant[]): FunnelVariantResult[] {
  const control = variants[0];
  const controlRate = (control?.conversions ?? 0) / Math.max(1, control?.visits ?? 0);
  const rows = variants.map((variant) => {
    const visits = variant.visits ?? 0;
    const conversions = variant.conversions ?? 0;
    const conversionRate = conversions / Math.max(1, visits);
    const liftAgainstControl = controlRate > 0 ? ((conversionRate - controlRate) / controlRate) * 100 : 0;
    const confidenceLabel =
      visits < 100 || conversions < 10 ? "zu wenig Daten" : Math.abs(liftAgainstControl) > 15 ? "stark" : "Tendenz";

    return {
      id: variant.id,
      name: variant.name,
      visits,
      conversions,
      conversionRate,
      confidenceLabel,
      liftAgainstControl,
      isWinner: false,
    } satisfies FunnelVariantResult;
  });

  const winner = rows
    .filter((row) => row.confidenceLabel !== "zu wenig Daten")
    .sort((a, b) => b.conversionRate - a.conversionRate)[0];

  return rows.map((row) => ({ ...row, isWinner: Boolean(winner && row.id === winner.id) }));
}
