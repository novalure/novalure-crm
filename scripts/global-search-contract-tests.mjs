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

test("global search covers core CRM records plus content documents", () => {
  const repository = read("src/lib/db/global-search-repository.ts");
  for (const table of ["contacts", "organizations", "leads", "projects", "seller_listings", "property_units", "deals", "tasks", "crm_content_documents", "broker_closings"]) {
    assert.match(repository, new RegExp(`from ${table.replace("property_units", "property_units")}`, "i"));
  }
  assert.match(repository, /limit \$10 offset \$11/i);
  assert.match(repository, /count\(\*\)::text as total/i);
});

test("search applies tenant, project, owner and record visibility boundaries", () => {
  const repository = read("src/lib/db/global-search-repository.ts");
  const contentRepository = read("src/lib/db/content-library-repositories.ts");
  assert.match(repository, /withTenantTransaction/);
  assert.match(repository, /workspace_id = \$1/g);
  assert.match(repository, /\$4::uuid is null or/g);
  assert.match(repository, /\$6::uuid is null or/g);
  assert.match(repository, /canViewAllWorkspaceContacts/);
  assert.match(repository, /canManageContent/);
  assert.match(repository, /with visible_projects as/);
  assert.match(repository, /not \$8::boolean[\s\S]*customer_project_access/);
  assert.match(repository, /\$8::boolean[\s\S]*project_pipeline_permissions ppp[\s\S]*ppp\.can_edit_deals = true/);
  assert.doesNotMatch(repository, /contacts scoped_contact|leads scoped_lead|deals scoped_deal|tasks scoped_task|seller_listings scoped_listing/);
  assert.match(repository, /\$3::boolean or s\.owner_user_id = \$2 or seller_lead\.assigned_to_user_id = \$2/);
  assert.match(repository, /visible\.id = s\.project_id/);
  assert.match(repository, /visible\.id = u\.project_id/);
  assert.match(repository, /contentDocumentReadAccessSql/);
  assert.match(repository, /contentDocumentReadAccessSql\("doc", "\$2", "\$7"\)/);
  assert.doesNotMatch(repository, /doc\.approval_status = 'approved'[\s\S]*visible_projects/);
  assert.match(contentRepository, /export function contentDocumentReadAccessSql/);
  assert.match(contentRepository, /visibility = 'internal'/);
  assert.match(contentRepository, /visibility = 'customer'/);
  assert.match(contentRepository, /visibility = 'public'/);
  assert.match(contentRepository, /customer_actor\.status = 'active'/);
});

test("search recents use the single productivity source of truth and revalidate access", () => {
  const repository = read("src/lib/db/global-search-repository.ts");
  const migration = read("migrations/082_content_library_privacy.sql");
  assert.match(repository, /insert into crm_recent_records/i);
  assert.match(repository, /join candidates candidate/i);
  assert.match(repository, /recent\.opened_at as "openedAt"/i);
  assert.match(repository, /order by recent\.opened_at desc\s+limit \$10/i);
  assert.match(repository, /claimSafeMutation/);
  assert.doesNotMatch(migration, /crm_record_recents/i);
});

test("closing search shares canonical financial and project-edit policy without metadata inference", () => {
  const repository = read("src/lib/db/global-search-repository.ts");
  const accessPolicy = read("src/lib/broker-flow/access-policy.ts");
  assert.match(repository, /canManageBrokerFinancials\(input\.session\)/);
  assert.match(repository, /canUseBrokerProjectEditScope\(input\.session\)/);
  assert.match(accessPolicy, /"developer_sales"[\s\S]*"project_sales_member"/);
  assert.match(accessPolicy, /session\.role === "assistant"\) return false/);
  assert.match(repository, /case when \$9::boolean then closing\.payment_status end/);
  assert.match(repository, /case when \$9::boolean then closing\.currency end/);
  assert.match(repository, /\$9::boolean and closing\.payment_status ilike/);
  assert.match(repository, /project_pipeline_permissions closing_permission[\s\S]*closing_permission\.can_edit_deals = true/);
  assert.doesNotMatch(repository, /concat_ws\(' · ', closing\.status, closing\.payment_status, closing\.currency\)/);
});

test("search route and command provide secured mutations and keyboard access", () => {
  const route = read("src/app/api/crm/search/route.ts");
  const command = read("src/components/global-search-command.tsx");
  assert.match(route, /permission: "crm:read"/);
  assert.match(route, /parseIdempotencyKey/);
  assert.match(command, /ctrlKey \|\| event\.metaKey/);
  assert.match(command, /aria-modal="true"/);
  assert.match(command, /ArrowDown/);
  assert.match(command, /event\.key === "Tab"/);
  assert.match(command, /min-h-11/g);
});

test("global-search TypeScript is syntactically valid", () => {
  assertSyntax("src/lib/db/global-search-repository.ts");
  assertSyntax("src/lib/broker-flow/access-policy.ts");
  assertSyntax("src/app/api/crm/search/route.ts");
  assertSyntax("src/components/global-search-command.tsx");
});
