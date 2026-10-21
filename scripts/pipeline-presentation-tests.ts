import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DealPipelineWorkspace, formatLeadBudgetRange } from "../src/components/deal-pipeline-workspace";
import type { CrmPipeline, Deal, Project } from "../src/lib/crm-types";

test("budget ranges skip missing bounds and format a single known bound once", () => {
  for (const language of ["de", "en"] as const) {
    const locale = language === "de" ? "de-AT" : "en-IE";
    assert.equal(formatLeadBudgetRange(undefined, undefined, locale, language), "");
    assert.equal(formatLeadBudgetRange(Number.NaN, Number.NaN, locale, language), "");
    const equalBounds = formatLeadBudgetRange(500000, 500000, locale, language);
    assert.ok(!equalBounds.includes(" - "));
    assert.match(formatLeadBudgetRange(undefined, 500000, locale, language), language === "de" ? /^bis / : /^up to /);
    assert.match(formatLeadBudgetRange(500000, undefined, locale, language), language === "de" ? /^ab / : /^from /);
  }
});

const pipelineId = "095d1414-0e28-42d0-92a0-85620e8bc8bb";
const project: Project = { id: "project-fixture", workspaceId: "workspace-fixture", name: "Test project", type: "Immobilien", leads: 0, revenue: "0", status: "Aktiv", defaultPipelineId: pipelineId };
const pipeline: CrmPipeline = { id: pipelineId, workspaceId: project.workspaceId, projectId: project.id, isDefault: true, key: "test", name: "Project sales process", purpose: "Test" };
const deal: Deal = { id: "deal-fixture", workspaceId: project.workspaceId, projectId: project.id, contactId: "contact-fixture", name: "Test deal", stage: "Neu", value: "€ 500.000", probability: 50, expectedCloseDate: "", riskLevel: "mittel", source: "Manual", nextAction: "" };

test("sales details resolve pipeline names and keep integration keys in closed details", () => {
  for (const language of ["de", "en"] as const) {
    const html = renderToStaticMarkup(createElement(DealPipelineWorkspace, {
      calendarEvents: [], contacts: [], deals: [deal], language, leads: [], organizations: [], pipeline: [], projectPipelinePermissions: [], crmPipelines: [pipeline], crmPipelineStages: [], projectLabel: "Test project", projects: [project], propertyReservations: [], propertyUnits: [], sellerListings: [], tasks: [], users: [], workspaceId: project.workspaceId,
    }));
    assert.ok(html.includes(pipeline.name));
    assert.ok(!html.includes(pipelineId));
    assert.match(html, language === "de" ? /Vertriebsangaben/ : /Sales details/);
    assert.match(html, /<details[^>]*><summary[^>]*>(?:Technical field mapping|Technische Feldzuordnung)<\/summary>/);
    assert.ok(!html.includes("min-w-[680px]"));
    assert.equal(project.defaultPipelineId, pipelineId);
  }
});
