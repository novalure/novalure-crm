import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LeadInbox } from "../src/components/lead-inbox";
import { consents, contacts, conversations, leads, projects, users } from "../src/lib/crm-data";

const lead = { ...leads[0], status: "Neu" as const, intent: "AUTHORIZED_LIVE_LEAD" };
const props = {
  activeProjectId: null,
  workspaceId: lead.workspaceId,
  language: "en" as const,
  leads: [lead], contacts, projects, users,
  consents: [{ ...consents[0], contactId: lead.contactId, status: "Opt-in" as const }],
  conversations: [{ ...conversations[0], leadId: lead.id, contactId: lead.contactId, summary: "UNVERIFIED_CONVERSATION_SENTINEL" }],
  showPropertySalesWorkflow: false,
};

test("missing related adapters hide unverified conversations while scoped activity loads independently", () => {
  const html = renderToStaticMarkup(createElement(LeadInbox, { ...props, relatedDataAvailable: false }));
  assert.match(html, /AUTHORIZED_LIVE_LEAD/);
  assert.match(html, /<span>Consent<\/span><span[^>]*>Unavailable<\/span>/);
  assert.match(html, /<section aria-label="Activity history"[^>]*>[\s\S]*?<p[^>]*role="status">Loading activity…<\/p>/u);
  assert.doesNotMatch(html, /UNVERIFIED_CONVERSATION_SENTINEL/);
});

test("an explicitly available related adapter keeps the existing consent and history presentation", () => {
  const html = renderToStaticMarkup(createElement(LeadInbox, { ...props, relatedDataAvailable: true }));
  assert.match(html, /<span>Consent<\/span><span[^>]*>done<\/span>/);
  assert.match(html, /UNVERIFIED_CONVERSATION_SENTINEL/);
  assert.doesNotMatch(html, /<span>Consent<\/span><span[^>]*>Unavailable<\/span>/);
});
