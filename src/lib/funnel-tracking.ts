import type { FunnelBlueprint } from "@/lib/funnel-schema";

export type FunnelTrackingSnippet = {
  head: string;
  body: string;
  warnings: string[];
};

function escapeScriptValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function createTrackingSnippet(blueprint: FunnelBlueprint): FunnelTrackingSnippet {
  const warnings: string[] = [];
  const lines: string[] = [
    "window.novalureFunnel = window.novalureFunnel || {};",
    `window.novalureFunnel.id = '${escapeScriptValue(blueprint.id)}';`,
    `window.novalureFunnel.projectId = '${escapeScriptValue(blueprint.projectId)}';`,
  ];

  if (blueprint.tracking.consentMode !== "active") {
    warnings.push("Tracking ist im Funnel noch nicht aktiv. Events duerfen erst nach Consent gesendet werden.");
  }

  if (blueprint.tracking.gtmId) {
    lines.push(`window.novalureFunnel.gtmId = '${escapeScriptValue(blueprint.tracking.gtmId)}';`);
  }
  if (blueprint.tracking.gaMeasurementId) {
    lines.push(`window.novalureFunnel.ga4 = '${escapeScriptValue(blueprint.tracking.gaMeasurementId)}';`);
  }
  if (blueprint.tracking.metaPixelId) {
    lines.push(`window.novalureFunnel.metaPixelId = '${escapeScriptValue(blueprint.tracking.metaPixelId)}';`);
  }

  const head = `<script>${lines.join("")}</script>`;
  const body = [
    "function trackFunnelEvent(name, payload) {",
    "  window.dataLayer = window.dataLayer || [];",
    "  window.dataLayer.push({ event: name, funnel: window.novalureFunnel, payload: payload || {} });",
    "}",
  ].join("\n");

  return { head, body, warnings };
}
