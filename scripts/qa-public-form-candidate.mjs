#!/usr/bin/env node

import { createHmac, randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { assertQaTarget } from "./qa-target-guard.mjs";
import { listWebsiteForms, upsertWebsiteForm } from "../src/lib/db/form-repositories.ts";
import { getRolePermissions } from "../src/lib/auth/permissions.ts";
import { getProductRoleCapabilities } from "../src/lib/product-model.ts";

const qa = await assertQaTarget();
if (process.env.DATABASE_URL?.trim() !== qa.databaseUrl) {
  throw new Error("QA_FORM_RUNTIME_TARGET_INVALID");
}
const ownerUrl = process.env.NOVALURE_QA_MIGRATION_DATABASE_URL?.trim();
const lookupUrl = process.env.CRM_PUBLIC_FORM_LOOKUP_DATABASE_URL?.trim();
const salesSecret = process.env.NOVALURE_STUDIO_INGESTION_SECRET?.trim();
const base = process.env.NOVALURE_QA_BASE_URL?.trim();
const productionHost = process.env.NOVALURE_PRODUCTION_DATABASE_HOST?.trim().toLowerCase();

function requireProof(condition, code) {
  if (!condition) throw new Error(code);
}

function safeUrl(value, role, pooled) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("QA_CONNECTION_INVALID"); }
  requireProof(parsed.protocol === "postgresql:" && decodeURIComponent(parsed.username) === role
    && parsed.pathname === "/neondb" && parsed.hostname.endsWith(".neon.tech")
    && parsed.hostname.includes("-pooler.") === pooled
    && parsed.hostname.toLowerCase() !== productionHost
    && ["require", "verify-full"].includes(parsed.searchParams.get("sslmode")), "QA_CONNECTION_SCOPE_INVALID");
  parsed.searchParams.set("sslmode", "verify-full");
  return parsed;
}

requireProof(Boolean(ownerUrl && lookupUrl && base && productionHost && salesSecret?.length >= 32), "QA_INPUT_MISSING");
const ownerTarget = safeUrl(ownerUrl, "neondb_owner", false);
requireProof(new URL(lookupUrl).searchParams.get("sslmode") === "verify-full", "QA_LOOKUP_TLS_MODE_INVALID");
const lookupTarget = safeUrl(lookupUrl, "novalure_public_form_lookup", true);
const appTarget = safeUrl(qa.databaseUrl, "novalure_app", true);
requireProof(lookupTarget.hostname === appTarget.hostname && lookupTarget.searchParams.get("sslmode") === "verify-full", "QA_LOOKUP_BINDING_INVALID");
requireProof(base === "http://127.0.0.1:3000", "QA_HTTP_TARGET_INVALID");

const owner = new pg.Pool({ connectionString: ownerTarget.toString(), ssl: { rejectUnauthorized: true }, max: 2 });
const app = new pg.Pool({ connectionString: appTarget.toString(), ssl: { rejectUnauthorized: true }, max: 2 });
const lookup = new pg.Pool({ connectionString: lookupTarget.toString(), ssl: { rejectUnauthorized: true }, max: 2 });
const marker = randomBytes(12).toString("hex");
const own = { workspace: randomUUID(), actor: randomUUID(), project: randomUUID(), form: randomUUID(), draft: randomUUID(), key: `qa-${marker}` };
const foreign = { workspace: randomUUID(), actor: randomUUID(), project: randomUUID(), form: randomUUID(), key: `qa-foreign-${marker}` };
const salesForm = "0f98b9fd-d300-4a34-a14c-54a1a61b2415";
const salesWorkspace = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const slug = `candidate-${marker}`;
const draftSlug = `draft-${marker}`;
const formFields = JSON.stringify([
  { id: "name", crmField: "name", label: "Name", type: "text", required: true },
  { id: "email", crmField: "email", label: "Email", type: "email", required: true },
  { id: "privacy", crmField: "privacy", label: "Privacy", type: "consent", required: true },
]);

async function scalar(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0]?.value;
}

async function requireDenied(task, code) {
  try { await task(); } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42501") return;
    throw new Error(`${code}_UNEXPECTED_ERROR`);
  }
  throw new Error(code);
}

async function attestDatabase() {
  const identity = (await owner.query(`select current_setting('neon.project_id',true) project,
    current_setting('neon.branch_id',true) branch,current_database() database,current_user role`)).rows[0];
  requireProof(identity.project === qa.expectedProjectId && identity.branch === qa.expectedBranchId
    && identity.database === qa.expectedDatabase && identity.role === "neondb_owner", "QA_OWNER_FINGERPRINT_INVALID");
  for (const number of ["094", "095"]) {
    const name = number === "094" ? "website_sales_ingestion" : "form_tenant_isolation";
    const version = `${number}_${name}`;
    const bytes = await readFile(new URL(`../migrations/${version}.sql`, import.meta.url));
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const ledger = await owner.query("select checksum from novalure_schema_migrations where version=$1", [version]);
    requireProof(ledger.rows.length === 1 && ledger.rows[0].checksum === checksum, `QA_LEDGER_${number}_INVALID`);
  }
  const flags = (await owner.query(`select relname,relrowsecurity,relforcerowsecurity from pg_class
    where oid in ('public.forms'::regclass,'public.form_submissions'::regclass) order by relname`)).rows;
  requireProof(flags.length === 2 && flags.every(row => row.relrowsecurity && row.relforcerowsecurity), "QA_FORM_RLS_INVALID");
  const role = (await owner.query(`select rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication
    from pg_roles where rolname='novalure_public_form_lookup'`)).rows[0];
  requireProof(role?.rolcanlogin && !role.rolsuper && !role.rolbypassrls && !role.rolcreatedb
    && !role.rolcreaterole && !role.rolreplication, "QA_LOOKUP_ROLE_UNSAFE");
  requireProof(await scalar(lookup, "select not has_table_privilege(current_user,'public.forms','SELECT') and not has_table_privilege(current_user,'public.form_submissions','SELECT') as value") === true, "QA_LOOKUP_TABLE_GRANT_UNSAFE");
}

async function seedForms() {
  const client = await owner.connect();
  try {
    await client.query("begin");
    for (const fixture of [own, foreign]) {
      await client.query("insert into workspaces(id,name,operating_model,public_key) values($1,$2,'self_service_customer',$3)",
        [fixture.workspace, `SYNTHETIC Candidate ${marker}`, fixture.key]);
      await client.query(`insert into workspace_users(id,workspace_id,name,email,role,product_role,status)
        values($1,$2,'SYNTHETIC owner',$3,'owner','customer_owner','active')`,
      [fixture.actor, fixture.workspace, `candidate-${fixture.actor}@example.invalid`]);
      await client.query("insert into projects(id,workspace_id,name,type) values($1,$2,$3,'Bauträger')",
        [fixture.project, fixture.workspace, `SYNTHETIC Candidate ${marker}`]);
    }
    await client.query(`insert into forms(id,workspace_id,project_id,owner_user_id,name,slug,status,fields,actions)
      values($1,$2,$3,$4,$5,$6,'aktiv',$7::jsonb,'{}'::jsonb),
            ($8,$2,$3,$4,$9,$10,'entwurf',$7::jsonb,'{}'::jsonb),
            ($11,$12,$13,$14,$15,$16,'aktiv',$7::jsonb,'{}'::jsonb)`,
    [own.form, own.workspace, own.project, own.actor, `SYNTHETIC Published ${marker}`, slug, formFields,
      own.draft, `SYNTHETIC Draft ${marker}`, draftSlug,
      foreign.form, foreign.workspace, foreign.project, foreign.actor, `SYNTHETIC Foreign ${marker}`, `foreign-${marker}`]);
    await client.query("insert into form_submissions(id,workspace_id,project_id,form_id) values($1,$2,$3,$4)",
      [randomUUID(), foreign.workspace, foreign.project, foreign.form]);
    await client.query("commit");
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

async function attestRls() {
  requireProof(await scalar(owner, "select count(*)::int as value from form_submissions where form_id=$1", [foreign.form]) === 1,
    "QA_FOREIGN_SUBMISSION_FIXTURE_MISSING");
  requireProof(await scalar(app, "select count(*)::int as value from forms where id=$1", [own.form]) === 0, "QA_NO_CONTEXT_FORM_LEAK");
  requireProof(await scalar(app, "select count(*)::int as value from form_submissions where form_id=$1", [own.form]) === 0, "QA_NO_CONTEXT_SUBMISSION_LEAK");
  await requireDenied(() => app.query("select version from novalure_schema_migrations limit 1"), "QA_LEDGER_READ_ALLOWED");
  await requireDenied(() => lookup.query("select id from forms limit 1"), "QA_LOOKUP_BASE_READ_ALLOWED");
  await requireDenied(() => lookup.query("select id from form_submissions limit 1"), "QA_LOOKUP_SUBMISSION_READ_ALLOWED");
  const published = await lookup.query("select crm_public_form_lookup(null,$1,$2) as form", [own.key, slug]);
  const draft = await lookup.query("select crm_public_form_lookup(null,$1,$2) as form", [own.key, draftSlug]);
  requireProof(published.rows[0]?.form?.id === own.form && draft.rows[0]?.form === null, "QA_PUBLIC_LOOKUP_INVALID");
  const client = await app.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [own.workspace, own.actor]);
    requireProof((await client.query("select id from forms where id=$1", [own.form])).rowCount === 1, "QA_SAME_TENANT_DENIED");
    requireProof((await client.query("select id from forms where id=$1", [foreign.form])).rowCount === 0, "QA_CROSS_TENANT_FORM_LEAK");
    requireProof((await client.query("select id from form_submissions where workspace_id=$1", [foreign.workspace])).rowCount === 0, "QA_CROSS_TENANT_SUBMISSION_LEAK");
    requireProof((await client.query(`insert into forms(id,workspace_id,project_id,owner_user_id,name,slug,status,fields,actions)
      values($1,$2,$3,$4,$5,$6,'entwurf',$7::jsonb,'{}'::jsonb) returning id`,
    [randomUUID(), own.workspace, own.project, own.actor, `SYNTHETIC Own ${marker}`, `own-${marker}`, formFields])).rowCount === 1,
    "QA_SAME_TENANT_WRITE_DENIED");
    await client.query("savepoint foreign_form_write");
    await requireDenied(() => client.query(`insert into forms(id,workspace_id,project_id,owner_user_id,name,slug,status,fields,actions)
      values($1,$2,$3,$4,$5,$6,'entwurf',$7::jsonb,'{}'::jsonb)`,
    [randomUUID(), foreign.workspace, foreign.project, foreign.actor, `SYNTHETIC Foreign ${marker}`, `denied-${marker}`, formFields]),
    "QA_CROSS_TENANT_WRITE_ALLOWED");
    await client.query("rollback to savepoint foreign_form_write");
    await client.query("release savepoint foreign_form_write");
    await client.query("savepoint form_delete");
    await requireDenied(() => client.query("delete from forms where id=$1", [own.form]), "QA_FORM_DELETE_ALLOWED");
    await client.query("rollback to savepoint form_delete");
    await client.query("release savepoint form_delete");
    await client.query("rollback");
  } finally { client.release(); }
}

async function attestFormSaving() {
  const session = {
    authenticated: true,
    userId: own.actor,
    workspaceId: own.workspace,
    workspaceName: `SYNTHETIC Candidate ${marker}`,
    name: "SYNTHETIC owner",
    email: `candidate-${own.actor}@example.invalid`,
    role: "owner",
    productRole: "customer_owner",
    permissions: getRolePermissions("owner"),
    productPermissions: getProductRoleCapabilities("customer_owner"),
    source: "database",
  };
  const loaded = await listWebsiteForms({ session });
  requireProof(loaded.source === "database", "QA_FORM_LOAD_FAILED");
  const form = loaded.forms.find(item => item.id === own.form);
  requireProof(Boolean(form), "QA_FORM_FIXTURE_MISSING");
  const saved = await upsertWebsiteForm({
    session,
    form: { ...form, name: `SYNTHETIC Saved ${marker}`, projectId: foreign.project, workspaceId: foreign.workspace },
  });
  requireProof(saved.persisted && saved.form?.projectId === own.project
    && saved.form.name === `SYNTHETIC Saved ${marker}`
    && JSON.stringify(saved.form.fields) === JSON.stringify(form.fields), "QA_FORM_SAVE_PROJECT_OR_FIELDS_CHANGED");
  const row = await owner.query("select workspace_id,project_id,name from forms where id=$1", [own.form]);
  requireProof(row.rows[0]?.workspace_id === own.workspace && row.rows[0]?.project_id === own.project
    && row.rows[0]?.name === `SYNTHETIC Saved ${marker}`, "QA_FORM_SAVE_DATABASE_SCOPE_INVALID");

  const created = await upsertWebsiteForm({
    session,
    form: { ...form, id: `candidate-new-${marker}`, name: `SYNTHETIC Created ${marker}`,
      slug: `created-${marker}`, workspaceId: foreign.workspace, projectId: foreign.project },
  });
  requireProof(created.persisted && created.form?.workspaceId === own.workspace
    && created.form.projectId === own.project, "QA_FORM_CREATE_WRITABLE_PROJECT_FAILED");
  const createdRow = await owner.query("select workspace_id,project_id from forms where id=$1", [created.form.id]);
  requireProof(createdRow.rows[0]?.workspace_id === own.workspace && createdRow.rows[0]?.project_id === own.project,
    "QA_FORM_CREATE_DATABASE_SCOPE_INVALID");

  const otherProject = randomUUID();
  const otherFunnel = randomUUID();
  await owner.query("insert into projects(id,workspace_id,name,type) values($1,$2,$3,'Bauträger')",
    [otherProject, own.workspace, `SYNTHETIC Candidate Other ${marker}`]);
  await owner.query("insert into funnels(id,workspace_id,project_id,name,goal,audience,entry_channel) values($1,$2,$3,$4,'lead','buyer','web')",
    [otherFunnel, own.workspace, otherProject, `SYNTHETIC Candidate Other ${marker}`]);
  const deniedMove = await upsertWebsiteForm({ session, form: { ...saved.form, funnelId: otherFunnel } });
  requireProof(!deniedMove.persisted, "QA_FORM_CROSS_PROJECT_MOVE_ALLOWED");
  const deniedForeign = await upsertWebsiteForm({ session, form: { ...form, id: foreign.form } });
  requireProof(!deniedForeign.persisted, "QA_FORM_CROSS_TENANT_SAVE_ALLOWED");
  const unchanged = await owner.query("select project_id,name from forms where id=$1", [own.form]);
  requireProof(unchanged.rows[0]?.project_id === own.project
    && unchanged.rows[0]?.name === `SYNTHETIC Saved ${marker}`, "QA_FORM_DENIED_MOVE_CHANGED_ROW");
}

function hiddenInputs(html) {
  const values = new Map();
  for (const tag of html.match(/<input\b[^>]*>/giu) ?? []) {
    const name = tag.match(/\bname="([^"]+)"/u)?.[1];
    const value = tag.match(/\bvalue="([^"]*)"/u)?.[1];
    if (name && value !== undefined) values.set(name, value.replaceAll("&amp;", "&"));
  }
  return values;
}

async function attestHttp() {
  const publicPath = `/forms/${own.key}/${slug}`;
  const published = await fetch(`${base}${publicPath}`, { redirect: "manual" });
  const html = await published.text();
  requireProof(published.status === 200 && html.includes(`SYNTHETIC Published ${marker}`), "QA_ANONYMOUS_PUBLISHED_FORM_FAILED");
  const draft = await fetch(`${base}/forms/${own.key}/${draftSlug}`, { redirect: "manual" });
  const draftHtml = await draft.text();
  requireProof(!draftHtml.includes(`SYNTHETIC Draft ${marker}`), "QA_ANONYMOUS_DRAFT_LEAK");
  const inputs = hiddenInputs(html);
  const required = ["_novalure_idempotency_key", "_novalure_proof_issued_at", "_novalure_proof_expires_at", "_novalure_proof"];
  requireProof(required.every(key => inputs.get(key)), "QA_PUBLIC_PROOF_MISSING");
  const body = new URLSearchParams({ form_id: `${own.key}/${slug}`, form_slug: `${own.key}/${slug}`,
    return_to: publicPath, name: `SYNTHETIC Lead ${marker}`, email: `candidate-${marker}@example.invalid`,
    privacy: "true", ...Object.fromEntries(required.map(key => [key, inputs.get(key)])) }).toString();
  const before = await scalar(owner, "select count(*)::int as value from form_submissions where form_id=$1", [own.form]);
  const options = { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.42" }, body };
  const first = await fetch(`${base}/api/forms/submissions`, options);
  const second = await fetch(`${base}/api/forms/submissions`, options);
  const after = await scalar(owner, "select count(*)::int as value from form_submissions where form_id=$1", [own.form]);
  requireProof([302,303].includes(first.status) && second.status === first.status && after === before + 1, "QA_ANONYMOUS_SUBMISSION_OR_REPLAY_FAILED");
  requireProof(first.headers.get("location") === second.headers.get("location"), "QA_SUBMISSION_REPLAY_MISMATCH");
  requireProof(await scalar(app, "select count(*)::int as value from form_submissions where form_id=$1", [own.form]) === 0, "QA_ANONYMOUS_SUBMISSION_READ_LEAK");
  const tenant = await app.connect();
  try {
    await tenant.query("begin");
    await tenant.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [own.workspace, own.actor]);
    requireProof((await tenant.query("select id from form_submissions where form_id=$1", [own.form])).rowCount === 1,
      "QA_SAME_TENANT_SUBMISSION_READ_DENIED");
    requireProof((await tenant.query("select id from form_submissions where form_id=$1", [foreign.form])).rowCount === 0,
      "QA_CROSS_TENANT_SUBMISSION_LEAK");
    await tenant.query("rollback");
  } finally { tenant.release(); }
  const anonymousRead = await fetch(`${base}/api/forms/submissions`, { redirect: "manual" });
  requireProof(anonymousRead.status >= 400, "QA_ANONYMOUS_SUBMISSION_API_READ_ALLOWED");
}

async function attestWebsiteSales() {
  const idempotencyKey = randomBytes(24).toString("base64url");
  const payload = { version: "website-sales-lead-v1", name: `SYNTHETIC Studio ${marker}`,
    email: `studio-${marker}@example.invalid`, packageInterest: "BUSINESS",
    message: "SYNTHETIC candidate Website Sales ingestion verification.", consent: true,
    syntheticTest: true, idempotencyKey };
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", salesSecret).update(`website-sales-lead-v1.${timestamp}.${body}`, "utf8").digest("base64url");
  const headers = { "content-type": "application/json", "x-novalure-client-ip": "198.51.100.43",
    "x-novalure-signature": signature, "x-novalure-timestamp": timestamp };
  const before = await scalar(owner, "select count(*)::int as value from form_submissions where form_id=$1", [salesForm]);
  const businessBefore = await scalar(owner, `select count(*)::int as value from leads where workspace_id=$1
    and metadata->>'businessLine'='WEBSITE_SALES' and (metadata #>> '{websiteSales,syntheticTest}') is distinct from 'true'`, [salesWorkspace]);
  const first = await fetch(`${base}/api/public/website-sales`, { method: "POST", headers, body });
  const firstBody = await first.json().catch(() => ({}));
  const replay = await fetch(`${base}/api/public/website-sales`, { method: "POST", headers, body });
  const replayBody = await replay.json().catch(() => ({}));
  const after = await scalar(owner, "select count(*)::int as value from form_submissions where form_id=$1", [salesForm]);
  const businessAfter = await scalar(owner, `select count(*)::int as value from leads where workspace_id=$1
    and metadata->>'businessLine'='WEBSITE_SALES' and (metadata #>> '{websiteSales,syntheticTest}') is distinct from 'true'`, [salesWorkspace]);
  requireProof(first.status === 202 && replay.status === 202 && firstBody.reference === replayBody.reference
    && after === before + 1 && businessAfter === businessBefore, "QA_WEBSITE_SALES_OR_KPI_FAILED");
  const tampered = await fetch(`${base}/api/public/website-sales`, { method: "POST", headers: { ...headers, "x-novalure-signature": "invalid" }, body });
  requireProof(tampered.status === 401, "QA_WEBSITE_SALES_SIGNATURE_BYPASS");
}

try {
  await attestDatabase();
  await seedForms();
  await attestRls();
  await attestFormSaving();
  await attestHttp();
  await attestWebsiteSales();
  console.log(`CRM_CANDIDATE_QA_PASS project=${qa.expectedProjectId} branch=${qa.expectedBranchId} migration=094,095 forms=RLS_FORCE formSave=PASS lookup=SCOPED anonymous=PASS sales=PASS replay=PASS`);
} catch (error) {
  const code = error instanceof Error && /^QA_[A-Z0-9_]+$/u.test(error.message) ? error.message : "QA_UNEXPECTED_FAILURE";
  console.error(`CRM_CANDIDATE_QA_FAIL code=${code}`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([owner.end(), app.end(), lookup.end()]);
}
