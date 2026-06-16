import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

test("property department migration creates canonical support tables without replacing reservations", () => {
  const migration = read("migrations/034_property_department.sql");
  const requiredTables = [
    "property_media",
    "property_documents",
    "property_channels",
    "property_inquiries",
    "property_export_jobs",
    "property_openimmo_mappings",
    "property_data_quality_issues",
    "property_activity_events",
  ];

  for (const table of requiredTables) {
    assert.match(migration, new RegExp(`create table if not exists ${table}\\b`, "i"));
  }
  assert.doesNotMatch(migration, /create table if not exists property_reservations\b/i);
  assert.match(migration, /alter table seller_listings/i);
  assert.match(migration, /workspace_module_settings/i);
  assert.match(migration, /'properties', true/i);
});

test("system diagnostics and QA seed include the property department migration", () => {
  assert.match(read("src/app/api/system/database/route.ts"), /migrations\/034_property_department\.sql/);
  assert.match(read("src/app/api/system/database/route.ts"), /migrations\/035_property_department_content\.sql/);
  assert.match(read("scripts/qa-livegang-seed.mjs"), /migrations\/034_property_department\.sql/);
  assert.match(read("scripts/qa-livegang-seed.mjs"), /migrations\/035_property_department_content\.sql/);
});

test("property content migration adds productive text, cost, media, document and price visibility structures", () => {
  const migration = read("migrations/035_property_department_content.sql");

  for (const column of ["object_number", "internal_reference", "available_from_text", "price_visibility", "channel_price_visibility", "public_price_cents", "portal_mapping_status"]) {
    assert.match(migration, new RegExp(column));
  }
  assert.match(migration, /create table if not exists property_text_blocks/i);
  assert.match(migration, /create table if not exists property_cost_items/i);
  assert.match(migration, /alter table property_media[\s\S]*category/i);
  assert.match(migration, /alter table property_media[\s\S]*is_cover/i);
  assert.match(migration, /alter table property_documents[\s\S]*visibility/i);
  assert.match(migration, /alter table property_channels[\s\S]*price_visibility_override/i);
});

test("property modules stay visible across workspace/product configurations", () => {
  const model = read("src/lib/product-model.ts");
  assert.match(model, /export const novalureGrowthDisabledModules: WorkspaceModuleKey\[\] = \[\]/);
  assert.match(model, /alwaysVisiblePropertyModuleKeys/);
  for (const key of ["properties", "objectsMandates", "units", "reservations", "projectOverview"]) {
    assert.match(model, new RegExp(`"${key}"`));
  }
});

test("every navigation preset exposes Immobilien", () => {
  const workspace = read("src/components/crm-workspace.tsx");
  const presetBlock = workspace.slice(
    workspace.indexOf("const navigationPresets"),
    workspace.indexOf("const quickActionSections"),
  );
  const entryBlocks = [...presetBlock.matchAll(/navigationEntries:\s*\[([\s\S]*?)\]/g)];

  assert.ok(entryBlocks.length >= 15, "expected all navigation presets to be inspected");
  for (const [, entries] of entryBlocks) {
    assert.match(entries, /"properties"/);
  }
  assert.match(workspace, /properties: \{ id: "properties", section: "properties" \}/);
  assert.match(workspace, /visibleActiveSection === "properties"/);
  assert.match(workspace, /usesFocusedWorkspaceSidebar\(section: DashboardSection\)/);
  assert.match(workspace, /section === "pipelines" \|\| section === "properties"/);
  assert.match(workspace, /setSidebarCollapsed\(usesFocusedWorkspaceSidebar\(resolvedSection\)\)/);
  assert.match(workspace, /setSidebarCollapsed\(usesFocusedWorkspaceSidebar\(nextSection\)\)/);
  assert.match(read("src/lib/i18n.ts"), /properties: "Immobilien"/);
});

test("property UI exposes the requested tabs, Aufnahmeblatt groups and disabled action reasons", () => {
  const domain = read("src/lib/property-department.ts");
  const component = read("src/components/property-command-center.tsx");
  const tabs = [
    "Übersicht",
    "Objekt anlegen",
    "Projekt / Gebäude / Einheiten",
    "Reservierungen",
    "Anfragen",
    "Vermarktung / Kanäle",
    "Dokumente / Exposé",
    "Käufer- und Investorenmatching",
    "Datenqualität",
    "Aktivitäten / Historie",
  ];
  const groups = ["Lage", "Flächen", "Räume", "Objektklassifizierung", "Grundbuch / Kataster", "Bau / Status", "Energie", "Preise / Kosten", "Investment", "Abgeber", "Ausstattung", "Notizen / Audit"];

  for (const tab of tabs) assert.match(domain, new RegExp(tab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const group of groups) assert.match(domain, new RegExp(group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(domain, /reason: canReserve \? undefined : "Reservierungsrechte erforderlich\."/);
  assert.match(component, /disabled=\{!action\.enabled\}/);
  for (const section of ["Texte", "Preise & Kosten", "Veröffentlichung & Portale", "Bild hochladen", "Dokument hochladen"]) {
    assert.match(component, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(domain, /PROPERTY_TEXT_FIELDS/);
  assert.match(domain, /PROPERTY_COST_TEMPLATES/);
  assert.match(domain, /PROPERTY_PRICE_VISIBILITY_OPTIONS/);
});

test("property create view uses focused, grouped form sections instead of a cramped field matrix", () => {
  const component = read("src/components/property-command-center.tsx");

  for (const section of [
    "Überblick",
    "Adresse & Lage",
    "Flächen & Verfügbarkeit",
    "Preise & Kosten",
    "Veröffentlichung & Portale",
    "Medien & Dokumente",
    "Historie / Aktivitäten",
    "Preflight",
  ]) {
    assert.match(component, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(component, /sticky top-3/);
  assert.match(component, /propertyInputClass = "min-h-12/);
  assert.match(component, /propertyTextareaClass = `\$\{propertyInputClass\} min-h-\[168px\]/);
  assert.match(component, /min-h-\[240px\]/);
  assert.match(component, /defaultOpenPropertyDetailSections/);
  assert.match(component, /md:grid-cols-2 2xl:grid-cols-3/);
  assert.doesNotMatch(component, /xl:grid-cols-4[\s\S]{0,120}PROPERTY_FIELD_SECTIONS/);
});

test("property API supports creation, inquiry routing and preflight without mutating reservations", () => {
  const route = read("src/app/api/crm/properties/route.ts");
  const repository = read("src/lib/db/property-department-repositories.ts");
  const reservationsRoute = read("src/app/api/crm/reservations/route.ts");

  assert.match(route, /create_property/);
  assert.match(route, /route_inquiry/);
  assert.match(route, /run_preflight/);
  for (const operation of [
    "update_property_core",
    "save_text_blocks",
    "save_cost_items",
    "attach_media",
    "attach_document",
    "update_media_order",
    "update_price_visibility",
  ]) {
    assert.match(route, new RegExp(operation));
  }
  assert.match(repository, /insert into seller_listings/);
  assert.match(repository, /insert into property_inquiries/);
  assert.match(repository, /insert into property_export_jobs/);
  assert.match(repository, /insert into property_text_blocks/);
  assert.match(repository, /insert into property_cost_items/);
  assert.match(repository, /insert into property_media/);
  assert.match(repository, /insert into property_documents/);
  assert.doesNotMatch(route + repository, /mutateUnitReservation/);
  assert.match(reservationsRoute, /mutateUnitReservation/);
});

test("property preflight handles price-on-request, hidden prices and real content checks", () => {
  const domain = read("src/lib/property-department.ts");

  assert.match(domain, /price_on_request/);
  assert.match(domain, /hide_price/);
  assert.match(domain, /public_price/);
  assert.match(domain, /textBlockCount/);
  assert.match(domain, /coverImageCount/);
  assert.match(domain, /energyDocumentCount/);
  assert.match(domain, /portalMappingStatus/);
});

test("OpenImmo is handled as mapping and export history, not as a public schema route", () => {
  const domain = read("src/lib/property-department.ts");
  const migration = read("migrations/034_property_department.sql");
  const route = read("src/app/api/crm/properties/route.ts");

  assert.match(domain, /OpenImmo Export/);
  assert.match(migration, /property_openimmo_mappings/);
  assert.match(migration, /export_history/);
  assert.doesNotMatch(route, /\/openimmo|openimmo schema/i);
});

test("core loader includes seller listings for the central property view", () => {
  const loader = read("src/lib/db/crm-loaders.ts");
  assert.match(loader, /sellerListings: SellerListing\[\]/);
  assert.match(loader, /propertyTextBlocks: PropertyTextBlock\[\]/);
  assert.match(loader, /propertyCostItems: PropertyCostItem\[\]/);
  assert.match(loader, /propertyMedia: PropertyMediaItem\[\]/);
  assert.match(loader, /propertyDocuments: PropertyDocumentItem\[\]/);
  assert.match(loader, /loadSellerListings/);
  assert.match(loader, /loadPropertyTextBlocks/);
  assert.match(loader, /loadPropertyCostItems/);
  assert.match(loader, /loadPropertyMedia/);
  assert.match(loader, /loadPropertyDocuments/);
  assert.match(loader, /canonical_payload as "canonicalPayload"/);
});
