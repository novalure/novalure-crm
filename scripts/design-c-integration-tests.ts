import assert from "node:assert/strict";
import test from "node:test";
import { calendarEvents, contacts, leads, projects, tasks } from "../src/lib/crm-data";
import { selectAuthoritativeCrmPresentation, unavailableCrmSectionCollections } from "../src/lib/crm-presentation-data";
import { buildEvelynCommandOverview, type EvelynCommandData } from "../src/lib/evelyn-command-center";
import type { CoreCrmDataKey, CoreCrmDataResult } from "../src/lib/db/crm-loaders";
import { getCrmSelfServiceEntries } from "../src/lib/crm-self-service-navigation";

test("customer presets retain read-only Knowledge while management requires existing capabilities", () => {
  const preset = Object.freeze(["properties", "units", "bots", "settings"]);
  const viewer = getCrmSelfServiceEntries(preset, "viewer");
  assert(viewer.includes("knowledge")); assert(viewer.includes("dashboard")); assert(viewer.includes("projects"));
  assert(!viewer.includes("bots")); assert(!viewer.includes("settings"));
  const owner = getCrmSelfServiceEntries(preset, "customer_owner");
  assert(owner.includes("bots")); assert(owner.includes("settings"));
  assert.equal(preset.length, 4);
  assert.equal(new Set(owner).size, owner.length);
});

test("internal department presets keep their existing navigation contract", () => {
  const entries = ["workspaces", "auditLog"];
  assert.deepEqual(getCrmSelfServiceEntries(entries, "novalureAdmin"), entries);
});

function core(): CoreCrmDataResult {
  const collections: Pick<CoreCrmDataResult, CoreCrmDataKey> = { brokerMandates: [], buyerSearchProfiles: [], calendarEvents: [], contacts: [], crmBots: [], crmPipelineStages: [], crmPipelines: [], editorPreflightRuns: [], leads: [], deals: [], funnelSteps: [], funnels: [], newsletterCampaigns: [], newsletterSegments: [], projectPipelinePermissions: [], propertyBuildings: [], propertyCostItems: [], propertyDocuments: [], propertyMedia: [], propertyReservations: [], propertyTextBlocks: [], propertyUnits: [], projects: [], sellerListings: [], tasks: [] };
  const moduleSources: CoreCrmDataResult["moduleSources"] = { brokerMandates: "database", buyerSearchProfiles: "database", calendarEvents: "database", contacts: "database", crmBots: "database", crmPipelineStages: "database", crmPipelines: "database", editorPreflightRuns: "database", leads: "database", deals: "database", funnelSteps: "database", funnels: "database", newsletterCampaigns: "database", newsletterSegments: "database", projectPipelinePermissions: "database", propertyBuildings: "database", propertyCostItems: "database", propertyDocuments: "database", propertyMedia: "database", propertyReservations: "database", propertyTextBlocks: "database", propertyUnits: "database", projects: "database", sellerListings: "database", tasks: "database" };
  return {
    ...collections, contacts, leads, projects, tasks, calendarEvents,
    source: "database", moduleSources,
    dailyQueue: { generatedAt: "2026-10-19T08:00:00Z", sections: [] },
  } as CoreCrmDataResult;
}
function overview(overrides: Partial<EvelynCommandData> = {}) {
  return buildEvelynCommandOverview({ leads: [], tasks: [], projects: [], calendarEvents: [],
    moduleSources: core().moduleSources, scopeStatus: "ready", allowedSections: ["leadInbox", "tasks", "projects", "calendar", "customerAccess"], ...overrides });
}

test("non-database modules cannot leak fixture collections into the integrated CRM", () => {
  const input = core(); input.moduleSources.contacts = "mock"; input.moduleSources.leads = "fallback";
  const projected = selectAuthoritativeCrmPresentation(input);
  assert.deepEqual(projected.contacts, []); assert.deepEqual(projected.leads, []);
  assert.equal(projected.projects, input.projects); assert.equal(projected.moduleSources, input.moduleSources);
  assert.equal(input.contacts, contacts); assert.equal(input.leads, leads);
});

test("absent module provenance fails closed while error and completeness metadata survive", () => {
  const input = core(); delete (input.moduleSources as Partial<typeof input.moduleSources>).contacts;
  input.moduleErrors = { contacts: "unavailable" }; input.collectionCompleteness = "LIMITED";
  const projected = selectAuthoritativeCrmPresentation(input);
  assert.deepEqual(projected.contacts, []); assert.equal(projected.moduleErrors, input.moduleErrors);
  assert.equal(projected.collectionCompleteness, "LIMITED");
});

test("an unreliable daily queue does not survive an unavailable tasks module", () => {
  const input = core(); input.moduleSources.tasks = "fallback";
  assert.deepEqual(selectAuthoritativeCrmPresentation(input).dailyQueue, { generatedAt: "", sections: [] });
});

test("verified empty database collections count as zero; unavailable sources never do", () => {
  const ready = overview();
  assert.equal(ready.metrics.find(item => item.id === "leads")?.value, 0);
  for (const source of ["mock", "fallback"] as const) {
    const actual = overview({ moduleSources: { leads: source, tasks: source, projects: source, calendarEvents: source } });
    assert(actual.metrics.every(item => item.value === undefined));
  }
});

test("source errors suppress stale numerical values", () => {
  const actual = overview({ leads, moduleErrors: { leads: "query failed" } });
  assert.equal(actual.metrics.find(item => item.id === "leads")?.state, "error");
  assert.equal(actual.metrics.find(item => item.id === "leads")?.value, undefined); assert.deepEqual(actual.activity, []);
});

test("loading and invalid project scopes expose no counts, activity or appointments", () => {
  for (const scopeStatus of ["loading", "invalid"] as const) {
    const actual = overview({ leads, tasks, projects, calendarEvents, scopeStatus });
    assert(actual.metrics.every(item => item.value === undefined)); assert.deepEqual(actual.activity, []); assert.deepEqual(actual.appointments, []);
  }
});

test("unavailable or forbidden sections cannot contribute hidden metrics or activities", () => {
  const actual = overview({ leads, tasks, projects, calendarEvents, allowedSections: [] });
  assert(actual.metrics.every(item => item.value === undefined)); assert.deepEqual(actual.activity, []); assert.deepEqual(actual.appointments, []);
});

test("customers and offers are never guessed from contacts or pipeline figures", () => {
  const actual = overview({ leads, projects, customerAccessSource: "database" });
  assert.equal(actual.metrics.find(item => item.id === "customers")?.value, undefined);
  assert.equal(actual.metrics.find(item => item.id === "offers")?.value, undefined);
});

test("synthetic lead relations do not become business tasks or appointments", () => {
  const lead = { ...leads[0], id: "synthetic-relation", status: "Neu" as const, syntheticTest: true };
  const task = { ...tasks[0], leadId: lead.id, status: "open" as const };
  const event = { ...calendarEvents[0], leadId: lead.id };
  const actual = overview({ leads: [lead], tasks: [task], calendarEvents: [event] });
  assert.equal(actual.metrics.find(item => item.id === "leads")?.value, 0);
  assert.equal(actual.metrics.find(item => item.id === "tasks")?.value, 0);
  assert.equal(actual.metrics.find(item => item.id === "calendarEvents")?.value, 0);
});


test("mixed module failures remain unavailable sections rather than empty successes", () => {
  const input = core(); input.moduleSources.propertyUnits = "fallback";
  assert.deepEqual(unavailableCrmSectionCollections(input, "properties"), ["propertyUnits"]);
  assert.deepEqual(unavailableCrmSectionCollections(input, "contacts"), []);
  input.moduleErrors = { contacts: "read failed" };
  assert.deepEqual(unavailableCrmSectionCollections(input, "contacts"), ["contacts"]);
  assert.deepEqual(selectAuthoritativeCrmPresentation(input).contacts, []);
});


test("daily queue provenance covers contacts, deals and failed modules", () => {
  const input = core(); input.moduleSources.deals = "fallback";
  assert.deepEqual(unavailableCrmSectionCollections(input, "dailyQueue"), ["deals"]);
  assert.deepEqual(selectAuthoritativeCrmPresentation(input).dailyQueue.sections, []);
  input.moduleSources.deals = "database"; input.moduleErrors = { contacts: "failed" };
  assert.deepEqual(unavailableCrmSectionCollections(input, "dailyQueue"), ["contacts"]);
  assert.equal(selectAuthoritativeCrmPresentation(input).dailyQueue.generatedAt, "");
});
