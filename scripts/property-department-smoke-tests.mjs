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
  assert.match(read("src/app/api/system/database/route.ts"), /migrations\/038_property_default_units\.sql/);
  assert.match(read("src/app/api/system/database/route.ts"), /migrations\/039_property_content_partial_unique_indexes\.sql/);
  assert.match(read("scripts/qa-livegang-seed.mjs"), /migrations\/034_property_department\.sql/);
  assert.match(read("scripts/qa-livegang-seed.mjs"), /migrations\/035_property_department_content\.sql/);
  assert.match(read("package.json"), /db:migrate:property-default-units/);
  assert.match(read("package.json"), /db:migrate:property-content-guards/);
  assert.match(read("package.json"), /qa:phase2-property-kpis/);
  assert.match(read("package.json"), /qa:phase3-duplicate-guards/);
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

test("phase 3 property content migration blocks nullable duplicate rows with partial indexes", () => {
  const migration = read("migrations/039_property_content_partial_unique_indexes.sql");
  const reservationMigration = read("migrations/040_property_reservation_active_unique_index.sql");
  const qa = read("scripts/qa-phase3-duplicate-guards.mjs");

  for (const indexName of [
    "property_text_blocks_property_only_uidx",
    "property_text_blocks_unit_only_uidx",
    "property_cost_items_property_only_uidx",
    "property_cost_items_unit_only_uidx",
  ]) {
    assert.match(migration, new RegExp(`create unique index if not exists ${indexName}`));
    assert.match(qa, new RegExp(indexName));
  }

  assert.match(migration, /where property_id is not null and unit_id is null/);
  assert.match(migration, /where unit_id is not null and property_id is null/);
  assert.match(reservationMigration, /property_reservations_one_active_per_unit_idx/);
  assert.match(reservationMigration, /where status in \('hold', 'reserved'\)/);
  assert.match(qa, /activeReservationDuplicates/);
  assert.match(qa, /property_reservations_one_active_per_unit_idx/);
  assert.match(qa, /QADUPGUARD_/);
  assert.match(qa, /Fixture must start without duplicate rows/);
  assert.match(qa, /duplicate blocked by unique index/);
  assert.match(qa, /rollback/);
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
  const i18n = read("src/lib/i18n.ts");
  const tabs = [
    "overview",
    "create",
    "projectUnits",
    "reservations",
    "inquiries",
    "channels",
    "documents",
    "matching",
    "quality",
    "activity",
  ];
  const groups = ["location", "areas", "rooms", "classification", "cadastre", "construction", "energy", "costs", "investment", "seller", "equipment", "notes"];

  for (const tab of tabs) {
    assert.match(domain, new RegExp(`id: "${tab}"`));
    assert.match(i18n, new RegExp(`${tab}: \\{ label:`));
  }
  assert.match(domain, /subLabel: "Struktur"/);
  for (const group of groups) {
    assert.match(domain, new RegExp(`id: "${group}"`));
    assert.match(i18n, new RegExp(`${group}: \\{`));
  }
  assert.match(domain, /reason: canReserve \? undefined : copy\.actions\.reservationReason/);
  assert.match(component, /disabled=\{!action\.enabled\}/);
  for (const copyPath of [
    "copy.form.texts",
    "copy.form.pricesCosts",
    "copy.form.publicationPortals",
    "copy.subviews.uploadImage",
    "copy.subviews.uploadDocument",
  ]) {
    assert.match(component, new RegExp(copyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(i18n, /reservationReason: "Reservation permission required\."/);
  assert.match(i18n, /reservationReason: "Reservierungsrechte erforderlich\."/);
  assert.match(domain, /PROPERTY_TEXT_FIELDS/);
  assert.match(domain, /PROPERTY_COST_TEMPLATES/);
  assert.match(domain, /PROPERTY_PRICE_VISIBILITY_OPTIONS/);
});

test("property create view uses focused, grouped form sections instead of a cramped field matrix", () => {
  const component = read("src/components/property-command-center.tsx");
  const i18n = read("src/lib/i18n.ts");

  for (const section of [
    "overview",
    "addressLocation",
    "areasAvailability",
    "pricesCosts",
    "publicationPortals",
    "mediaDocuments",
    "historyActivities",
    "preflight",
  ]) {
    assert.match(component, new RegExp(`copy\\.form\\.${section}\\b`));
  }
  assert.match(i18n, /overview: "Overview"/);
  assert.match(i18n, /overview: "Überblick"/);

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

test("phase 4 links property objects and unit inventory without changing role visibility", () => {
  const component = read("src/components/property-command-center.tsx");
  const unitBoard = read("src/components/unit-board.tsx");
  const workspace = read("src/components/crm-workspace.tsx");
  const domain = read("src/lib/property-department.ts");
  const i18n = read("src/lib/i18n.ts");

  assert.match(domain, /type PropertyUnitBoardScope/);
  assert.match(domain, /unitIds: string\[\]/);
  assert.match(domain, /unitIds: listingUnits\.map\(\(unit\) => unit\.id\)/);
  assert.match(domain, /unitIds: projectUnits\.map\(\(unit\) => unit\.id\)/);

  assert.match(component, /createUnitBoardScope/);
  assert.match(component, /initialSelectedAssetId/);
  assert.match(component, /copy\.detail\.openUnits/);
  assert.match(component, /copy\.tabs\.projectUnits\.label/);
  assert.match(component, /onOpenUnits\(\{/);
  assert.match(i18n, /openUnits: "Open units \/ inventory"/);
  assert.match(i18n, /openUnits: "Einheiten\/Bestand öffnen"/);
  assert.match(i18n, /openProjectUnits: "Projekt in Einheiten\/Bestand öffnen"/);

  assert.match(unitBoard, /focusScope\?: PropertyUnitBoardScope/);
  assert.match(unitBoard, /focusedUnitIds/);
  assert.match(unitBoard, /text\.focusScopeLabel/);
  assert.match(unitBoard, /onOpenProperty\(\{ projectId: unit\.projectId, unitId: unit\.id \}\)/);
  assert.match(unitBoard, /text\.boardSubLabel/);

  assert.match(workspace, /unitBoardFocusScope/);
  assert.match(workspace, /propertyFocusAssetId/);
  assert.match(workspace, /handleOpenUnitsFromProperty/);
  assert.match(workspace, /handleOpenPropertyFromUnit/);
  assert.match(workspace, /preserveUnitScope: true/);
  assert.match(workspace, /preservePropertyFocus: true/);
  assert.match(workspace, /key=\{`\$\{activeProject\?\.id \?\? "all"\}:\$\{unitBoardFocusScope\?\.key \?\? "all"\}`\}/);

  assert.match(i18n, /boardSubLabel: "Vertrieb\/Bestand"/);
  assert.match(i18n, /title: "Einheiten\/Bestand"/);
  assert.match(i18n, /clearFocusScope: "Alle Einheiten \/ Bestand anzeigen"/);

  assert.match(workspace, /usesFocusedWorkspaceSidebar\(section: DashboardSection\)/);
  assert.doesNotMatch(workspace, /section === "units"[\s\S]{0,80}\|\| section === "properties"/);
});

test("phase 3 complete brokerage preset is additive and covers the full broker workflow", () => {
  const workspace = read("src/components/crm-workspace.tsx");
  const i18n = read("src/lib/i18n.ts");
  const tenantQa = read("scripts/qa-tenant-isolation.mjs");
  const blockMatch = workspace.match(/completeBrokerage:\s*\{([\s\S]*?)\r?\n  \},\r?\n  propertyDeveloper:/);

  assert.ok(blockMatch, "completeBrokerage preset is defined before propertyDeveloper");
  const block = blockMatch[1];
  for (const entry of [
    "properties",
    "sellerLeads",
    "buyerLeads",
    "projects",
    "units",
    "reservations",
    "pipelines",
    "tasks",
    "calendar",
    "contacts",
  ]) {
    assert.match(block, new RegExp(`"${entry}"`), `${entry} is included in completeBrokerage`);
  }
  assert.match(workspace, /return "completeBrokerage";/);
  assert.match(workspace, /return \["completeBrokerage", "realEstateBroker"\]/);
  assert.match(workspace, /const navigationPresetOrder: NavigationPresetId\[\] = \[\s*"completeBrokerage"/);
  assert.match(workspace, /teamNavigationPresetIds = new Set<NavigationPresetId>/);
  assert.match(workspace, /getNavigationPresetOptionGroups/);
  assert.match(workspace, /<optgroup key=\{group\.id\} label=\{copy\.navigationPresets\.groups\[group\.id\]\}>/);
  assert.match(workspace, /setActivePresetId\(normalizedActivePresetId\)/);
  assert.match(workspace, /window\.localStorage\.setItem\(navigationPresetStorageKey, normalizedActivePresetId\)/);
  assert.match(i18n, /standard: "Standard profiles"/);
  assert.match(i18n, /forTeams: "For teams"/);
  assert.match(i18n, /standard: "Standardprofile"/);
  assert.match(i18n, /forTeams: "Für Teams"/);
  assert.match(i18n, /Maklergeschäft komplett/);
  assert.match(i18n, /Complete brokerage business/);
  assert.match(tenantQa, /completeBrokerage first; standard profiles before team and Novalure internal profiles/);
  assert.match(tenantQa, /sameArray\(navigationOrder, expectedNavigationProfiles\)/);
});

test("phase 2 property KPIs use unit scope, default units and non-multiplying project revenue", () => {
  const domain = read("src/lib/property-department.ts");
  const loader = read("src/lib/db/crm-loaders.ts");
  const migration = read("migrations/038_property_default_units.sql");
  const repository = read("src/lib/db/property-department-repositories.ts");
  const qa = read("scripts/qa-phase2-property-kpis.mjs");

  assert.match(domain, /const unitById = new Map\(input\.units\.map/);
  assert.match(domain, /listing\.unitId[\s\S]*unitById\.get\(listing\.unitId\)/);
  assert.match(domain, /const unitValue = listingUnits\.reduce/);
  assert.doesNotMatch(domain, /const internalPrice = listing\.targetPrice \|\| listing\.marketValue/);
  assert.match(domain, /projectIdsCoveredByListing/);

  assert.match(repository, /async function ensureDefaultUnitForListing/);
  assert.match(repository, /insert into property_units/);
  assert.match(repository, /metadata @> '\{"defaultUnit": true\}'::jsonb/);
  assert.match(repository, /unit_id = \$3::uuid/);

  assert.match(migration, /038_property_default_units/);
  assert.match(migration, /not exists \([\s\S]*not \(pu\.metadata @> '\{"defaultUnit": true\}'::jsonb\)/);
  assert.match(migration, /update seller_listings sl[\s\S]*unit_id = m\.unit_id/);

  assert.match(loader, /left join \([\s\S]*from leads[\s\S]*group by workspace_id, project_id[\s\S]*\) l/);
  assert.match(loader, /left join \([\s\S]*sum\(value_cents\)::bigint as revenue_cents[\s\S]*from deals[\s\S]*\) d/);
  assert.doesNotMatch(loader, /left join leads l on[\s\S]*left join deals d on[\s\S]*group by p\.id/);

  assert.match(qa, /legacy_multiplied_revenue_cents/);
  assert.match(qa, /fixed_loader_revenue_cents/);
  assert.match(qa, /QAKPI_Phase2_Property_KPI/);
});

test("core CRM and property loaders require explicit workspace scope", () => {
  const loader = read("src/lib/db/crm-loaders.ts");

  assert.match(loader, /class MissingWorkspaceScopeError extends Error/);
  assert.match(loader, /function requireWorkspaceId\(workspaceId: string \| null \| undefined, loaderName: string\)/);
  assert.match(loader, /export async function getCoreCrmData\(\s*workspaceId: string,/s);
  assert.match(loader, /if \(error instanceof MissingWorkspaceScopeError\) \{\s*throw error;\s*\}/s);
  assert.match(loader, /loadContacts\(scopedWorkspaceId, contactScope\)/);
  assert.doesNotMatch(loader, /export async function load[A-Za-z0-9_]+\(\s*workspaceId\?: string/);
  assert.doesNotMatch(loader, /\$\{workspaceId \? "where/);
  assert.doesNotMatch(loader, /workspaceId \? \[workspaceId\] : \[\]/);

  for (const name of [
    "loadProjects",
    "loadBrokerMandates",
    "loadBuyerSearchProfiles",
    "loadSellerListings",
    "loadPropertyTextBlocks",
    "loadPropertyCostItems",
    "loadPropertyMedia",
    "loadPropertyDocuments",
    "loadPropertyBuildings",
    "loadPropertyUnits",
    "loadPropertyReservations",
    "loadLeads",
    "loadDeals",
    "loadTasks",
  ]) {
    assert.match(loader, new RegExp(`requireWorkspaceId\\(workspaceId, "${name}"\\)`), `${name} has a runtime guard`);
  }
});
