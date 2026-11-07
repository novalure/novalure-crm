import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FunnelCommandCenter, createFunnel, createDefaultSteps } from "../src/components/funnel-command-center";
import { FunnelRenderer } from "../src/components/funnel-renderer";
import { resolveFunnelCreationContext } from "../src/lib/funnel-creation-context";
import { buildFunnelBlueprint } from "../src/lib/funnel-builder-adapter";
import { runFunnelPreflight, funnelFormFields } from "../src/lib/funnel-publication";
import { getFunnelCommandCenterCopy, getFunnelRendererCopy } from "../src/lib/i18n";
import type { Project, WorkspaceUser } from "../src/lib/crm-types";

const workspaceId = randomUUID(), foreignWorkspace = randomUUID();
const actor: WorkspaceUser = { id: randomUUID(), workspaceId, name: "SYNTHETIC Current user", email: "current@example.invalid", role: "owner", productRole: "customer_owner", status: "active" };
const other: WorkspaceUser = { ...actor, id: randomUUID(), name: "SYNTHETIC Other user" };
const project: Project = { id: randomUUID(), workspaceId, name: "SYNTHETIC Same name", type: "Service", status: "Aktiv", leads: 0, revenue: "—", defaultPipelineId: "" };
const duplicate = { ...project, id: randomUUID() }, foreignProject = { ...project, id: randomUUID(), workspaceId: foreignWorkspace };
const text = getFunnelCommandCenterCopy("de");
const props = { activeProjectId: project.id, currentUserId: actor.id, funnels: [], language: "de" as const, leads: [], projectLabel: project.name, projects: [duplicate, foreignProject, project], steps: [], users: [other, actor] };
const createButton = (html: string) => html.match(/<button\b[^>]*>[^<]*<\/button>/g)?.find(button => button.includes(text.createFunnel));

test("fresh empty workspace exposes an enabled first-creation action with the current actor and selected project", () => {
  const html = renderToStaticMarkup(createElement(FunnelCommandCenter, props)), button = createButton(html);
  assert.match(html, /Deinen ersten Funnel anlegen/); assert.ok(button); assert.doesNotMatch(button, /\sdisabled(?:=|\s|>)/);
  const context = resolveFunnelCreationContext(props); assert.ok(context.ok); assert.equal(context.project.id, project.id); assert.equal(context.user.id, actor.id);
});
test("same-named projects require exact ID selection; foreign or stale active IDs do not fall back", () => {
  const chosen = resolveFunnelCreationContext({ ...props, activeProjectId: null, chosenProjectId: duplicate.id }); assert.ok(chosen.ok); assert.equal(chosen.project.id, duplicate.id);
  assert.deepEqual(resolveFunnelCreationContext({ ...props, activeProjectId: foreignProject.id }), { ok: false, reason: "project_unavailable" });
  assert.deepEqual(resolveFunnelCreationContext({ ...props, activeProjectId: randomUUID() }), { ok: false, reason: "project_unavailable" });
  const html = renderToStaticMarkup(createElement(FunnelCommandCenter, { ...props, activeProjectId: null })); assert.match(html, /Projekt für den neuen Funnel/); assert.match(createButton(html)!, /\sdisabled(?:=|\s|>)/);
});
test("missing, suspended and non-publishing actors cannot be replaced by the first user in the list", () => {
  assert.deepEqual(resolveFunnelCreationContext({ ...props, currentUserId: undefined }), { ok: false, reason: "actor_missing" });
  const html = renderToStaticMarkup(createElement(FunnelCommandCenter, { ...props, currentUserId: undefined })); assert.match(createButton(html)!, /\sdisabled(?:=|\s|>)/);
  assert.equal(resolveFunnelCreationContext({ ...props, users: [other, { ...actor, status: "suspended" }] }).ok, false);
  assert.deepEqual(resolveFunnelCreationContext({ ...props, users: [{ ...actor, role: "assistant", productRole: "viewer" }] }), { ok: false, reason: "creation_forbidden" });
});
test("the actual UI starter is a publishable contact intake without calendar, newsletter or hidden required question pages", () => {
  const funnel = createFunnel({ text, project, user: actor, workspaceId });
  assert.match(funnel.id, /^[0-9a-f-]{36}$/); assert.equal(funnel.ownerUserId, actor.id); assert.equal(funnel.projectId, project.id);
  const steps = createDefaultSteps(funnel, text); assert.equal(steps.length, 1); assert.equal(steps[0].type, "Kontaktformular");
  const blueprint = buildFunnelBlueprint({ funnel, project, owner: actor, steps });
  assert.equal(runFunnelPreflight(blueprint).ok, true); assert.equal(blueprint.crmHandover.destination, "leadInbox"); assert.equal(blueprint.crmHandover.createAppointment, false);
  const elements = blueprint.pages.flatMap(page => page.sections.flatMap(section => section.rows.flatMap(row => row.columns.flatMap(column => column.elements))));
  assert.equal(elements.some(element => ["calendar", "video", "testimonial", "choice"].includes(element.type)), false);
  assert.ok(blueprint.pages[0].sections.some(section => section.rows.some(row => row.columns.some(column => column.elements.some(element => element.type === "form")))));
  const emailField=funnelFormFields(blueprint).find(field=>field.crmField==="email");assert.ok(emailField?.validationPattern);assert.equal(new RegExp(emailField.validationPattern).test("first@example.invalid"),true);
  assert.ok(funnelFormFields(blueprint).some(field => field.crmField === "privacy_consent" && field.required));
});

test("public intake has a responsive customer layout while private previews retain their device frame", () => {
  const funnel = createFunnel({ text, project, user: actor, workspaceId });
  const blueprint = buildFunnelBlueprint({ funnel, project, owner: actor, steps: createDefaultSteps(funnel, text) });
  const live = renderToStaticMarkup(createElement(FunnelRenderer, { blueprint, language: "de", mode: "live", device: "mobile" }));
  assert.match(live, /data-funnel-layout="responsive"/); assert.match(live, /max-w-6xl/); assert.doesNotMatch(live, /max-w-\[390px\]/); assert.doesNotMatch(live, />mobile<|>desktop<|>tablet</); assert.doesNotMatch(live, /Ziel:|Lead Inbox/);
  const preview = renderToStaticMarkup(createElement(FunnelRenderer, { blueprint, language: "de", mode: "preview", device: "mobile" }));
  assert.match(preview, /max-w-\[390px\]/); assert.match(preview, />mobile</);
});

test("historical editing instructions are rendered as customer copy without changing the frozen blueprint", () => {
  const funnel = createFunnel({ text, project, user: actor, workspaceId });
  const blueprint = buildFunnelBlueprint({ funnel, project, owner: actor, steps: createDefaultSteps(funnel, text) });
  for (const field of funnelFormFields(blueprint)) {if (field.type === "phone") field.helpText = "Später mit echter Nummernvalidierung verbinden.";if(field.crmField==='name')field.helpText='Wird für die CRM-Zuordnung verwendet.';}
  for(const page of blueprint.pages)for(const section of page.sections)for(const row of section.rows)for(const column of row.columns)for(const element of column.elements){if(element.type==='headline')element.content='Qualifizierte Leads erfassen und an Vertrieb übergeben';if(element.name==='Beschreibung')element.content='Der Kunde beantwortet wenige Fragen, wird qualifiziert und landet direkt im richtigen CRM-Ziel.';if(element.name==='Hero')element.content='Kundenvorteile, Vertrauen und nächster Schritt klar darstellen.';if(element.type==='button')element.ctaLabel='Lead starten';}
  const before = JSON.stringify(blueprint);
  const live = renderToStaticMarkup(createElement(FunnelRenderer, { blueprint, language: "de", mode: "live" }));
  assert.doesNotMatch(live,/CRM-Zuordnung|richtigen CRM-Ziel|Kundenvorteile, Vertrauen|Qualifizierte Leads erfassen|Lead starten|>Hero</);assert.match(live,/Informationen zur Immobilie anfordern/);assert.match(getFunnelRendererCopy('de').processed,/Vielen Dank.*Anfrage wurde gesendet/);
  assert.doesNotMatch(live, /Später mit echter Nummernvalidierung verbinden/); assert.match(live, /Telefonnummer für Rückfragen zu deiner Anfrage/); assert.equal(JSON.stringify(blueprint), before);
});
