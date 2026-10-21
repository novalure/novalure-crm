import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NewsletterCommandCenter } from "../src/components/newsletter-command-center";
import type { Contact, NewsletterCampaign, NewsletterSegment } from "../src/lib/crm-types";

const campaign: NewsletterCampaign = {
  id: "campaign", workspaceId: "workspace", segmentId: "segment", name: "Persisted campaign",
  subject: "Persisted subject", previewText: "Persisted preview", status: "entwurf", goal: "Update",
  recipients: 3, contentBlocks: ["Persisted content"],
};
const segment: NewsletterSegment = {
  id: "segment", workspaceId: "workspace", name: "Persisted segment", audience: "Alle", language: "de",
  source: "CRM", contacts: 3, optIns: 2, health: "prüfen", rules: [],
};
const contact: Contact = {
  id: "contact", workspaceId: "workspace", projectId: "project", name: "Synthetic contact",
  role: "Käufer", project: "Synthetic project", source: "Website", intent: "Update",
  consent: "Newsletter", email: "synthetic@example.test",
};

function render(language: "de" | "en", relatedDataAvailable?: boolean, selectedCampaign = campaign) {
  return renderToStaticMarkup(<NewsletterCommandCenter
    automations={[]} campaigns={[selectedCampaign]} consents={[]} contacts={[contact]} deliverability={[]}
    language={language} leads={[]} projectLabel="Synthetic workspace" projects={[]} segments={[segment]}
    suppressions={[]} templates={[]} users={[]} relatedDataAvailable={relatedDataAvailable}
  />);
}

test("unconnected newsletter auxiliary data preserves campaigns and labels unknown counts without enabling sends", () => {
  const html = render("de", false);
  assert.match(html, /Persisted campaign/);
  assert.match(html, /Persisted segment/);
  assert.match(html, /Automationen · —/);
  assert.match(html, /Zustellbarkeit · —/);
  assert.match(html, /— verifizierte Empfänger/);
  assert.match(html, /Einwilligungen und Sperrlisten nicht verfügbar/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Kampagne senden<\/button>/);
  assert.doesNotMatch(html, /0 CRM-Opt-ins|Keine Newsletter-Opt-ins|Nur Newsletter Opt-ins im Segment:/);
});

test("unavailable newsletter data is localized in English", () => {
  const html = render("en", false);
  assert.match(html, /Consent and suppression data unavailable/);
  assert.match(html, /Sending remains disabled/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Send campaign<\/button>/);
  assert.doesNotMatch(html, /0 CRM opt-ins|No newsletter opt-ins/);
});

test("callers with verified related data retain the existing newsletter recipient flow by default", () => {
  const html = render("de");
  assert.match(html, /1 CRM-Opt-ins für diese Kampagne/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Kampagne senden<\/button>/);
  assert.match(html, /Automationen · 0/);
});

test("missing open-rate measurements in persisted sent campaigns remain unknown", () => {
  const html = render("en", false, { ...campaign, status: "gesendet" });
  assert.match(html, /<p class="font-semibold">-<\/p><p[^>]*>Avg open<\/p>/);
});
