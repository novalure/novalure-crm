import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatBotSetupSaveError } from "../src/components/bot-command-center";
import { FunnelBlueprintDesigner } from "../src/components/funnel-blueprint-designer";
import { getBotCommandCenterCopy, getFunnelCommandCenterCopy, getFunnelDesignerCopy, getNewsletterCommandCenterCopy } from "../src/lib/i18n";
import { buildFunnelBlueprint } from "../src/lib/funnel-builder-adapter";
import { funnels } from "../src/lib/crm-data";

const canary = "SYNTHETIC_PRIVATE_PROVIDER_DETAIL";

test("bot publication preserves known blockers and keeps unknown codes out of localized feedback", () => {
  for (const language of ["de", "en"] as const) {
    const copy = getBotCommandCenterCopy(language);
    const known = formatBotSetupSaveError({ error: "bot_publish_blocked", blockers: ["evaluation", "handoff"] }, copy);
    assert.ok(known.includes(copy.publishBlockerLabels.evaluation));
    assert.ok(known.includes(copy.publishBlockerLabels.handoff));
    assert.equal(formatBotSetupSaveError({ error: "bot_publish_blocked", blockers: [canary] }, copy), copy.botPublishBlockedUnknown);
    assert.equal(formatBotSetupSaveError({ error: canary }, copy), copy.botSetupSaveError);
  }
  const source = readFileSync(new URL("../src/components/bot-command-center.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /error\.message|payload\.error \|\||\{deliveryError\}/);
  assert.match(source, /\[documentSendId\]: text\.documentAttachFailed/);
  assert.match(source, /\[documentSend.id\]: text\.documentUploadFailed/);
  assert.match(source, /\{text\.documentDeliveryFailed\}/);
});

test("newsletter transport and provider failures use localized feedback while local validation stays helpful", async () => {
  const source = readFileSync(new URL("../src/components/newsletter-command-center.tsx", import.meta.url), "utf8");
  const action = source.slice(source.indexOf("const sendSelectedNewsletterCampaign = async () => {"), source.indexOf("  const addSnippet ="));
  assert.ok(action.startsWith("const sendSelectedNewsletterCampaign"));
  const compiled = ts.transpileModule(action, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const language of ["de", "en"] as const) {
    const text = getNewsletterCommandCenterCopy(language);
    for (const failure of ["transport", "provider", "no-recipients", "no-campaign", "missing-consent"] as const) {
      const state: Array<{ status: string; detail?: string }> = [];
      let calls = 0;
      const run = vm.runInNewContext(`${compiled}\nsendSelectedNewsletterCampaign`, {
        text, language,
        relatedDataAvailable: failure !== "missing-consent", relatedDataText: { detail: "SYNTHETIC localized consent guidance" },
        selectedCampaign: failure === "no-campaign" ? null : { campaign: { id: "synthetic-campaign" } },
        campaignRecipientEmails: failure === "no-recipients" ? [] : ["synthetic@example.invalid"],
        selectedDraft: { contentBlocks: [], fromEmail: "", subject: "Synthetic draft" },
        renderNewsletterHtml: () => "<p>Synthetic draft</p>",
        csrfFetch: async () => {
          calls++;
          if (failure === "transport") throw new Error(canary);
          return { ok: false, json: async () => ({ ok: false, sends: [{ status: "failed", error: canary }] }) };
        },
        setLiveNewsletterAction: (value: { status: string; detail?: string }) => state.push(value),
      });
      await run();
      assert.equal(state.at(-1)?.status, "error");
      const expected = failure === "no-recipients" ? text.liveSendNoRecipients
        : failure === "no-campaign" ? text.noCampaigns
          : failure === "missing-consent" ? "SYNTHETIC localized consent guidance" : text.liveSendError;
      assert.equal(state.at(-1)?.detail, expected);
      assert.ok(!JSON.stringify(state).includes(canary));
      assert.equal(calls, ["transport", "provider"].includes(failure) ? 1 : 0);
    }
  }
});

test("funnel designer renders localized formatting controls, system confidence and consent warning without changing draft content", () => {
  const blueprint = buildFunnelBlueprint({ funnel: { ...funnels[0], name: "SYNTHETIC draft" }, steps: [] });
  blueprint.pages = [{
    id: "synthetic-page", name: "SYNTHETIC page", slug: "synthetic", kind: "step",
    sections: [{
      id: "synthetic-section", name: "SYNTHETIC section",
      rows: [{ id: "synthetic-row", columns: [{ id: "synthetic-column", width: { desktop: 12 }, elements: [{ id: "synthetic-element", type: "text", name: "SYNTHETIC content", content: "Benutzereingabe bleibt unverändert." }] }] }],
    }],
  }];
  blueprint.tracking.consentMode = "ready";
  blueprint.variants = [{ id: "synthetic-variant", name: "SYNTHETIC variant", trafficPercent: 100, visits: 0, conversions: 0 }];
  const before = JSON.stringify(blueprint);
  for (const language of ["de", "en"] as const) {
    const copy = getFunnelDesignerCopy(language);
    const html = renderToStaticMarkup(createElement(FunnelBlueprintDesigner, { initialBlueprint: blueprint, language }));
    for (const key of ["formatBold", "formatItalic", "formatUnderline", "formatLink"] as const) {
      assert.ok(html.includes(`aria-label="${copy[key]}"`));
    }
    assert.ok(html.includes(copy.confidenceLabels["zu wenig Daten"]));
    assert.ok(html.includes(copy.emojiGroupLabels.Immobilien));
    assert.ok(html.includes(copy.emojiGroupLabels.Kontakt));
    assert.ok(html.includes(copy.trackingConsentWarning));
    assert.ok(html.includes("Benutzereingabe bleibt unverändert."));
  }
  assert.equal(JSON.stringify(blueprint), before);
  assert.equal(getFunnelCommandCenterCopy("de").privacy.cookieConsentOptions["Standalone Banner"], "Separates Banner");
  const source = readFileSync(new URL("../src/components/funnel-command-center.tsx", import.meta.url), "utf8");
  assert.match(source, /<option key=\{value\} value=\{value\}>\{text\.privacy\.cookieConsentOptions\[value\]\}/);
});
