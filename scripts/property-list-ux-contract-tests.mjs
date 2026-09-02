import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function assertSyntax(file) {
  const result = ts.transpileModule(read(file), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter((entry) => entry.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n")), []);
}

test("property overview consumes the tenant-scoped server pagination API", () => {
  const panel = read("src/components/property-command-center.tsx");
  const route = read("src/app/api/crm/properties/route.ts");
  const loaders = read("src/lib/db/crm-loaders.ts");
  assert.match(panel, /propertyListPageSize = 25/);
  assert.match(panel, /\/api\/crm\/properties\?\$\{params\.toString\(\)\}/);
  assert.match(panel, /offset: String\(\(listPage - 1\) \* propertyListPageSize\)/);
  assert.match(panel, /getPageWindow/);
  assert.match(panel, /parseListQueryState\(window\.location\.href/);
  assert.match(panel, /window\.addEventListener\("popstate", applyLocationState\)/);
  assert.match(panel, /if \(activeTab !== "overview" \|\| !listUrlHydrated\) return/);
  assert.match(panel, /projects: activeProjectId\s*\? projects\.filter\(\(project\) => project\.id === activeProjectId\)\s*:\s*projects/);
  assert.match(panel, /serializeListQueryState/);
  assert.match(route, /loadPaginatedPropertyAssets\(auth\.session\.workspaceId/);
  assert.match(route, /actorUserId: auth\.session\.userId/);
  assert.match(route, /workspaceWide: canViewAllWorkspaceContacts\(auth\.session\)/);
  assert.match(route, /limit: parseIntegerParam/);
  assert.match(loaders, /sl\.owner_user_id = \$\{actorParameter\}::uuid/);
  assert.match(loaders, /project_pipeline_permissions scoped_permission/);
  assert.match(loaders, /customer_project_access scoped_customer_access/);
});

test("property list has bounded selection, stable record navigation and retry states", () => {
  const panel = read("src/components/property-command-center.tsx");
  assert.match(panel, /propertyListSelectionLimit = 100/);
  assert.match(panel, /buildCrmEntityDeepLink/);
  assert.match(panel, /window\.history\.pushState/);
  assert.match(panel, /setListReloadToken/);
  assert.match(panel, /const \[listAssets, setListAssets\] = useState<PropertyAssetSummary\[]>\(\[]\)/);
  assert.doesNotMatch(panel, /locallyFilteredAssets/);
  assert.match(panel, /pageWindow\.hasPrevious/);
  assert.match(panel, /pageWindow\.hasNext/);
});

test("property overview uses mobile cards and retains the desktop table with the same record actions", () => {
  const panel = read("src/components/property-command-center.tsx");
  assert.match(panel, /<div className="mt-4 grid gap-3 md:hidden" data-property-mobile-list>/);
  assert.match(panel, /<div className="mt-4 hidden overflow-x-auto md:block" data-property-desktop-table>/);

  const mobileStart = panel.indexOf('className="mt-4 grid gap-3 md:hidden" data-property-mobile-list');
  const mobileEnd = panel.indexOf('data-property-desktop-table', mobileStart);
  const mobileCards = panel.slice(mobileStart, mobileEnd);
  assert.match(mobileCards, /filteredAssets\.map\(\(asset\)/);
  assert.match(mobileCards, /selectPropertyAsset\(asset\)/);
  assert.match(mobileCards, /togglePropertySelection\(propertyId, event\.target\.checked\)/);
  assert.match(mobileCards, /selectedBulkPropertyIds\.includes\(asset\.sellerListingId\)/);
  assert.match(mobileCards, /aria-current=\{selected \? "true" : undefined\}/);
  assert.match(mobileCards, /min-h-11/);
  for (const field of ["price", "area", "units", "inquiries"]) {
    assert.match(mobileCards, new RegExp(`copy\\.table\\.${field}`));
  }
});

test("CSV export is server-built, bounded and spreadsheet-formula safe", () => {
  const route = read("src/app/api/crm/properties/route.ts");
  assert.match(route, /format === "csv"/);
  assert.match(route, /if \(!canAccessPropertyExports\(auth\.session\)\)/);
  assert.match(read("src/components/property-command-center.tsx"), /actions\.exportChannel\.enabled \? \(/);
  assert.match(route, /firstPage\.pagination\.total > 5_000/);
  assert.match(route, /\^\[=\+\\-@\\t\\r\]/);
  assert.match(route, /content-disposition/);
  assert.match(route, /private, no-store/);
});

test("property list changes are syntactically valid", () => {
  assertSyntax("src/components/property-command-center.tsx");
  assertSyntax("src/app/api/crm/properties/route.ts");
  assertSyntax("src/lib/db/crm-loaders.ts");
});
