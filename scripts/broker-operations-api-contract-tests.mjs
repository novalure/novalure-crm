#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = await readFile(new URL("../src/lib/db/broker-operations-repository.ts", import.meta.url), "utf8");
const matching = await readFile(new URL("../src/lib/broker-flow/matching.ts", import.meta.url), "utf8");
const money = await readFile(new URL("../src/lib/broker-flow/money.ts", import.meta.url), "utf8");
const panel = await readFile(new URL("../src/components/broker-operations-panel.tsx", import.meta.url), "utf8");
const closingsRoute = await readFile(new URL("../src/app/api/crm/broker/closings/route.ts", import.meta.url), "utf8");
const closingExport = await readFile(new URL("../src/lib/broker-flow/closing-export.ts", import.meta.url), "utf8");

test("matching response has fulfilled and violated criteria plus independent availability", () => {
  assert.match(matching, /matchedCriteria/);
  assert.match(matching, /violatedCriteria/);
  assert.match(matching, /availability/);
  assert.match(matching, /\["available", "reserved_same"\]\.includes\(candidate\.availability\)/);
  assert.match(repository, /source: "server_live_evaluation"/);
  assert.match(repository, /brokerMatchingAlgorithmVersion/);
  assert.match(repository, /criteriaHash/);
  assert.match(repository, /objectHash/);
  assert.match(repository, /maximumMatchingCandidates/);
  assert.match(repository, /rent_price_cents/);
  assert.match(repository, /pr\.expires_at > now\(\)/);
  assert.match(repository, /metadata->>'hidden'/);
  assert.match(repository, /delivery\.status = 'accepted'/);
  assert.match(repository, /offered: engagementState\.offered/);
  assert.match(repository, /viewed: engagementState\.viewed/);
});

test("offer drafts are versioned and QA delivery stores failure truth before returning", () => {
  assert.match(repository, /insert into broker_offer_versions/);
  assert.match(repository, /current_version = \$17/);
  assert.match(repository, /insert into broker_offer_deliveries/);
  assert.ok(
    repository.indexOf("insert into broker_offer_deliveries") < repository.indexOf("providerAccepted: false"),
    "delivery truth must be persisted before the response is formed",
  );
});

test("offer authoring uses approved versioned templates and revalidates released attachments", () => {
  const offerSection = repository.slice(
    repository.indexOf("type ApprovedOfferTemplate"),
    repository.indexOf("type ActivityRow"),
  );
  assert.match(offerSection, /offerTemplateReferencePattern/);
  assert.match(offerSection, /content-template:/);
  assert.match(offerSection, /crm_communication_templates template/);
  assert.match(offerSection, /crm_communication_template_versions version/);
  assert.match(offerSection, /template\.approval_status = 'approved'/);
  assert.match(offerSection, /template\.archived_at is null/);
  assert.match(offerSection, /template\.current_version_number = \$4/);
  assert.match(offerSection, /template_actor\.status = 'active'/);
  assert.match(offerSection, /communicationTemplateReadAccessSql\("template", "\$2", "\$6"\)/);
  assert.match(offerSection, /approved_offer_template_required/);
  assert.ok(
    (offerSection.match(/requireApprovedOfferTemplate\(\{/g) ?? []).length >= 2,
    "save and QA delivery must both revalidate the template reference",
  );
  assert.match(offerSection, /media\.visibility in \('public', 'channel'\)/);
  assert.match(offerSection, /media\.status in \('approved', 'published'\)/);
  assert.match(offerSection, /document\.visibility in \('public', 'channel'\)/);
  assert.match(offerSection, /document\.status in \('approved', 'sent'\)/);
  assert.match(offerSection, /crm_content_documents document/);
  assert.match(offerSection, /document\.approval_status = 'approved'/);
  assert.match(offerSection, /contentDocumentReadAccessSql\("document", "\$2", "\$5"\)/);
  assert.match(offerSection, /document\.visibility = 'customer'[\s\S]*document\.project_id = \$3::uuid/);
  assert.match(offerSection, /document\.visibility = 'public'[\s\S]*document\.project_id is null/);
  assert.match(offerSection, /asset\.deletion_state = 'active'/);
  assert.match(offerSection, /for share of document, version, asset, content_actor/);
  assert.match(offerSection, /currentItems[\s\S]*validateOfferItem/);

  assert.match(panel, /\/api\/crm\/templates/);
  assert.match(panel, /\/api\/crm\/documents/);
  assert.match(panel, /Freigegebene zentrale E-Mail-Vorlage|Approved central email template/);
  assert.match(panel, /Vorlagenvorschau|Template preview/);
  assert.match(panel, /name="templateKey"/);
  assert.match(panel, /name="selectedDocumentIds"/);
  assert.match(panel, /name="selectedMediaIds"/);
  assert.match(panel, /Nur aktuelle, aktive customer\/public-Dokumente|Only current active customer\/public documents/);
  assert.match(panel, /templateKey: optionalText\(form\.get\("templateKey"\)\)/);
  assert.match(panel, /form\.getAll\("selectedDocumentIds"\)/);
  assert.match(panel, /form\.getAll\("selectedMediaIds"\)/);
});

test("activity and follow-up task are written inside one idempotent transaction", () => {
  const start = repository.indexOf("export async function createBrokerActivity");
  const end = repository.indexOf("type ViewingRow", start);
  const section = repository.slice(start, end);
  assert.match(section, /withIdempotentMutation/);
  assert.match(section, /insert into contact_timeline_items/);
  assert.match(section, /insert into tasks/);
  assert.match(section, /broker_activity_id/);
  assert.match(section, /writeAuditLog/);
});

test("viewing maintains history and an internal-only calendar projection", () => {
  const start = repository.indexOf("export async function saveBrokerViewing");
  const end = repository.indexOf("type ClosingRow", start);
  const section = repository.slice(start, end);
  assert.match(section, /insert into broker_viewing_history/);
  assert.match(section, /insert into calendar_events/);
  assert.match(section, /calendarProvider: "manual"/);
  assert.match(section, /externalCommunication: false/);
  assert.match(section, /invitation_blocked/);
  const projectionGuard = section.indexOf("calendar_projection_detach_unsupported");
  const viewingMutation = section.indexOf("update property_viewing_slots set");
  assert.ok(
    projectionGuard !== -1 && projectionGuard < viewingMutation,
    "an attached calendar projection must be guarded before the viewing mutation",
  );
  assert.match(section, /existing\?\.calendarEventId && !createCalendarProjection/);
  assert.doesNotMatch(section, /httpStatus: invitationRequested \? 503/);
});

test("closing uses minor units and basis points with exact server-side validation", () => {
  assert.match(money, /allocations must equal exactly 10000 basis points/);
  assert.match(money, /buyerCommissionMinor/);
  assert.match(money, /sellerCommissionMinor/);
  assert.match(money, /Gross commission cannot exceed the closing base amount/);
  assert.match(money, /Net commission plus tax must equal gross commission exactly/);
  assert.match(money, /Buyer and seller commission must equal gross commission exactly/);
  assert.match(repository, /parseMinorUnits/);
  assert.match(repository, /validateCommissionSplits/);
  assert.match(repository, /financial_permission_required/);
  assert.match(repository, /financialsVisible/);
  assert.match(repository, /paymentStatus: input\.financialsVisible \? row\.paymentStatus : null/);
  assert.match(repository, /currency: input\.financialsVisible \? row\.currency : null/);
  assert.match(repository, /assertClosingRelationshipValidity/);
  assert.match(repository, /closing_deal_buyer_mismatch/);
  assert.match(repository, /closing_active_reservation_mismatch/);
  assert.match(repository, /\["cancelled", "reversed"\]\.includes\(input\.status\)\) return/);
  assert.match(repository, /commissionAmountsChanged/);
});

test("broker panel sends real idempotent versioned mutations and export stays financial-role gated", () => {
  for (const endpoint of ["search-profiles", "offers", "viewings", "activities", "closings"]) {
    assert.match(panel, new RegExp(`/api/crm/broker/${endpoint}`));
  }
  assert.match(panel, /expectedVersion/);
  assert.match(panel, /Idempotency-Key/);
  assert.match(panel, /aria-label=\{title\}/);
  assert.match(panel, /Provider bleibt Launch-off|provider remains launch-off/);
  assert.match(panel, /commissionSplits/);
  assert.match(panel, /Export PDF report|PDF-Bericht exportieren/);
  assert.match(closingsRoute, /format === "csv" \|\| format === "pdf"/);
  assert.match(closingsRoute, /canManageBrokerFinancials/);
  assert.match(closingsRoute, /financial_permission_required/);
  assert.match(closingsRoute, /buildClosingCsv/);
  assert.match(closingsRoute, /buildClosingPdf/);
  assert.match(closingExport, /\^\[=\+\\-@\]/);
  assert.match(closingExport, /commission_splits_json/);
  assert.match(closingExport, /document\.output\("arraybuffer"\)/);
  assert.match(closingsRoute, /Content-Disposition/);
  assert.match(closingsRoute, /Cache-Control": "no-store, private/);
  assert.match(panel, /Boolean\(record\?\.calendarEventId\) \|\| form\.get\("createCalendarProjection"\) === "on"/);
  assert.match(panel, /disabled=\{Boolean\(record\.calendarEventId\)\}/);
});

test("broker create and edit forms expose semantic groups for every operable workflow", () => {
  assert.equal((panel.match(/<fieldset\b/g) ?? []).length, 5);
  assert.equal((panel.match(/<legend\b/g) ?? []).length, 5);
  assert.equal((panel.match(/<summary className="flex min-h-11 cursor-pointer items-center font-medium">/g) ?? []).length, 4);
  for (const legend of [
    "Search profile",
    "Offer draft",
    "Viewing",
    "Activity and follow-up",
    "Closing, money and commission",
  ]) {
    assert.match(panel, new RegExp(`>\\{language === "de" \\? "[^"]+" : "${legend}"\\}<\\/legend>`));
  }
  assert.match(panel, /<form aria-label=\{title\}/);
});
