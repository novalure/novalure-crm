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

requireProof(Boolean(ownerUrl && base && productionHost && salesSecret?.length >= 32), "QA_INPUT_MISSING");
const ownerTarget = safeUrl(ownerUrl, "neondb_owner", false);
const appTarget = safeUrl(qa.databaseUrl, "novalure_app", true);
requireProof(base === "http://127.0.0.1:3000", "QA_HTTP_TARGET_INVALID");

const owner = new pg.Pool({ connectionString: ownerTarget.toString(), ssl: { rejectUnauthorized: true }, max: 2 });
const app = new pg.Pool({ connectionString: appTarget.toString(), ssl: { rejectUnauthorized: true }, max: 2 });
const marker = randomBytes(12).toString("hex");
const own = { workspace: randomUUID(), actor: randomUUID(), viewer: randomUUID(), project: randomUUID(),
  form: randomUUID(), deniedForm: randomUUID(), draft: randomUUID(), key: `qa-${marker}` };
const foreign = { workspace: randomUUID(), actor: randomUUID(), project: randomUUID(), form: randomUUID(), key: `qa-foreign-${marker}` };
const salesForm = "0f98b9fd-d300-4a34-a14c-54a1a61b2415";
const salesWorkspace = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const slug = `candidate-${marker}`;
const draftSlug = `draft-${marker}`;
const siteKey = `nov_pk_${own.form.replaceAll("-", "")}`;
const foreignSiteKey = `nov_pk_${foreign.form.replaceAll("-", "")}`;
const publicOrigin = base;
const foreignOrigin = "https://foreign-candidate.example";
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
  for (const number of ["094", "095", "096"]) {
    const name = number === "094" ? "website_sales_ingestion"
      : number === "095" ? "form_tenant_isolation" : "public_integration_gateway";
    const version = `${number}_${name}`;
    const bytes = await readFile(new URL(`../migrations/${version}.sql`, import.meta.url));
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const ledger = await owner.query("select checksum from novalure_schema_migrations where version=$1", [version]);
    requireProof(ledger.rows.length === 1 && ledger.rows[0].checksum === checksum, `QA_LEDGER_${number}_INVALID`);
  }
  const flags = (await owner.query(`select relname,relrowsecurity,relforcerowsecurity from pg_class
    where oid in ('public.forms'::regclass,'public.form_submissions'::regclass,
      'public.external_integrations'::regclass,'public.external_integration_widget_configs'::regclass,
      'public.external_chat_sessions'::regclass,'public.external_chat_messages'::regclass,
      'public.external_integration_events'::regclass) order by relname`)).rows;
  requireProof(flags.length === 7 && flags.every(row => row.relrowsecurity && row.relforcerowsecurity), "QA_GATEWAY_RLS_INVALID");
  const role = (await owner.query(`select r.rolcanlogin,r.rolsuper,r.rolbypassrls,r.rolcreatedb,
      r.rolcreaterole,r.rolreplication,a.rolpassword
    from pg_roles r join pg_authid a on a.oid=r.oid where r.rolname='novalure_public_form_lookup'`)).rows[0];
  requireProof(!role?.rolcanlogin && role.rolpassword === null && !role.rolsuper && !role.rolbypassrls
    && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication, "QA_LOOKUP_ROLE_NOT_DISABLED");
  // Immutable CRM events prevent cascading deletion of a seeded workspace.
  // Each disposable branch therefore runs this candidate matrix only once.
  requireProof(await scalar(owner, `select count(*)::int as value from workspaces
    where public_key like 'qa-%' and name like 'SYNTHETIC Candidate %'`) === 0,
  "QA_CANDIDATE_BRANCH_ALREADY_USED");
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
    await client.query(`insert into workspace_users(id,workspace_id,name,email,role,product_role,status)
      values($1,$2,'SYNTHETIC restricted form owner',$3,'agent','broker_agent','active')`,
    [own.viewer, own.workspace, `candidate-${own.viewer}@example.invalid`]);
    await client.query(`insert into forms(id,workspace_id,project_id,owner_user_id,name,slug,status,fields,actions)
      values($1,$2,$3,$4,$5,$6,'aktiv',$7::jsonb,'{}'::jsonb),
            ($8,$2,$3,$4,$9,$10,'entwurf',$7::jsonb,'{}'::jsonb),
            ($11,$12,$13,$14,$15,$16,'aktiv',$7::jsonb,'{}'::jsonb)`,
    [own.form, own.workspace, own.project, own.actor, `SYNTHETIC Published ${marker}`, slug, formFields,
      own.draft, `SYNTHETIC Draft ${marker}`, draftSlug,
      foreign.form, foreign.workspace, foreign.project, foreign.actor, `SYNTHETIC Foreign ${marker}`, `foreign-${marker}`]);
    await client.query(`insert into forms(id,workspace_id,project_id,owner_user_id,name,slug,status,fields,actions)
      values($1,$2,$3,$4,$5,$6,'entwurf',$7::jsonb,'{}'::jsonb)`,
    [own.deniedForm, own.workspace, own.project, own.viewer, `SYNTHETIC restricted ${marker}`, `restricted-${marker}`, formFields]);
    await client.query("insert into form_submissions(id,workspace_id,project_id,form_id) values($1,$2,$3,$4)",
      [randomUUID(), foreign.workspace, foreign.project, foreign.form]);
    for (const [fixture, key, allowedOrigin] of [
      [own, siteKey, publicOrigin],
      [foreign, foreignSiteKey, foreignOrigin],
    ]) {
      const integration = await client.query(`insert into external_integrations(
        public_site_key,workspace_id,project_id,form_id,integration_type,status,mode,
        allowed_origins,capabilities,configuration,metadata
      ) values($1,$2,$3,$4,'public_form','active','training',array[$5],
        array['form.read','form.submit','lead.create','chat.start','chat.message'],'{}','{"synthetic":true}')
      on conflict(public_site_key) do update set
        allowed_origins=excluded.allowed_origins,
        capabilities=excluded.capabilities,
        status='active',
        mode='training',
        metadata=external_integrations.metadata || excluded.metadata
      returning id`, [key, fixture.workspace, fixture.project, fixture.form, allowedOrigin]);
      await client.query(`insert into external_integration_widget_configs(
        integration_id,workspace_id,brand_name,assistant_name,enabled_capabilities,
        lead_capture_enabled,chat_enabled
      ) values($1,$2,'SYNTHETIC Candidate','Evelyn',
        array['form.read','form.submit','lead.create','chat.start','chat.message'],true,true)
      on conflict(integration_id) do update set
        enabled_capabilities=excluded.enabled_capabilities,
        lead_capture_enabled=true,
        chat_enabled=true`,
      [integration.rows[0].id, fixture.workspace]);
    }
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
  const published = await app.query("select crm_public_form_lookup(null,$1,$2) as form", [own.key, slug]);
  const directGateway = await app.query("select crm_external_legacy_form_lookup(null,$1,$2) as form", [own.key, slug]);
  const draft = await app.query("select crm_public_form_lookup(null,$1,$2) as form", [own.key, draftSlug]);
  requireProof(published.rows[0]?.form?.id === own.form && directGateway.rows[0]?.form?.id === own.form
    && draft.rows[0]?.form === null, "QA_PUBLIC_LOOKUP_INVALID");
  const resolved = await app.query("select * from crm_external_integration_resolve($1,$2,'form.read',$3)",
    [siteKey, publicOrigin, own.form]);
  const deniedOrigin = await app.query("select * from crm_external_integration_resolve($1,$2,'form.read',$3)",
    [siteKey, "https://wrong.example", own.form]);
  const deniedProjectForm = await app.query("select * from crm_external_integration_resolve($1,$2,'form.read',$3)",
    [siteKey, publicOrigin, foreign.form]);
  const deniedForeignOrigin = await app.query("select * from crm_external_integration_resolve($1,$2,'form.read',$3)",
    [foreignSiteKey, publicOrigin, foreign.form]);
  const resolvedForeign = await app.query("select * from crm_external_integration_resolve($1,$2,'form.read',$3)",
    [foreignSiteKey, foreignOrigin, foreign.form]);
  requireProof(resolved.rowCount === 1 && deniedOrigin.rowCount === 0 && deniedProjectForm.rowCount === 0
    && deniedForeignOrigin.rowCount === 0 && resolvedForeign.rowCount === 1,
    "QA_GATEWAY_RESOLUTION_INVALID");
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
    await client.query("begin");
    await client.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [own.workspace, own.viewer]);
    requireProof((await client.query("select id from forms where id=$1", [own.deniedForm])).rowCount === 0,
      "QA_FORM_OWNER_PROJECT_ACCESS_BYPASS");
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
  requireProof(saved.persisted && saved.form?.name === `SYNTHETIC Saved ${marker}`
    && JSON.stringify(saved.form.fields) === JSON.stringify(form.fields), "QA_FORM_SAVE_PROJECT_OR_FIELDS_CHANGED");
  const row = await owner.query("select workspace_id,project_id,name from forms where id=$1", [own.form]);
  requireProof(row.rows[0]?.workspace_id === own.workspace && row.rows[0]?.project_id === own.project
    && row.rows[0]?.name === `SYNTHETIC Saved ${marker}`, "QA_FORM_SAVE_DATABASE_SCOPE_INVALID");

  const created = await upsertWebsiteForm({
    session,
    form: { ...form, id: `candidate-new-${marker}`, name: `SYNTHETIC Created ${marker}`,
      slug: `created-${marker}`, workspaceId: foreign.workspace, projectId: foreign.project },
  });
  requireProof(created.persisted && Boolean(created.form?.id), "QA_FORM_CREATE_WRITABLE_PROJECT_FAILED");
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
  requireProof(published.status === 200 && html.includes(`SYNTHETIC Saved ${marker}`), "QA_ANONYMOUS_PUBLISHED_FORM_FAILED");
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
  const negativePage = await fetch(`${base}${publicPath}`, { redirect: "manual" });
  const negativeInputs = hiddenInputs(await negativePage.text());
  requireProof(required.every(key => negativeInputs.get(key)), "QA_NEGATIVE_CONSENT_PROOF_MISSING");
  const negativeBody = new URLSearchParams({ form_id: `${own.key}/${slug}`, form_slug: `${own.key}/${slug}`,
    return_to: publicPath, name: `SYNTHETIC Denied ${marker}`, email: `denied-${marker}@example.invalid`,
    privacy: "false",
    ...Object.fromEntries(required.map(key => [key, negativeInputs.get(key)])) }).toString();
  const negativeResponse = await fetch(`${base}/api/forms/submissions`, {
    ...options,
    body: negativeBody,
    headers: { ...options.headers, accept: "application/json" },
  });
  requireProof(negativeResponse.status === 422
    && await scalar(owner, "select count(*)::int as value from form_submissions where form_id=$1", [own.form]) === after,
  "QA_FALSE_CONSENT_ACCEPTED");
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

async function gatewayBusinessEffects() {
  const row = (await owner.query(`select jsonb_build_object(
    'contacts',(select count(*)::int from contacts where workspace_id=$1),
    'leads',(select count(*)::int from leads where workspace_id=$1),
    'deals',(select count(*)::int from deals where workspace_id=$1),
    'tasks',(select count(*)::int from tasks where workspace_id=$1),
    'consents',(select count(*)::int from consent_records where workspace_id=$1),
    'submissions',(select count(*)::int from form_submissions where workspace_id=$1),
    'timeline',(select count(*)::int from contact_timeline_items where workspace_id=$1),
    'audit',(select count(*)::int from audit_logs where workspace_id=$1),
    'analytics',(select count(*)::int from analytics_events where workspace_id=$1),
    'speedToLead',(select count(*)::int from speed_to_lead_events where workspace_id=$1)
  ) value`, [own.workspace])).rows[0];
  return row.value;
}

async function attestGateway() {
  const headers = {
    origin: publicOrigin,
    "x-forwarded-for": "198.51.100.44",
    "x-novalure-site-key": siteKey,
  };
  const lookup = await fetch(`${base}/api/public/integrations/forms?form_id=${own.form}`, { headers });
  const lookupBody = await lookup.json().catch(() => ({}));
  requireProof(lookup.status === 200 && lookupBody.form?.id === own.form
    && !JSON.stringify(lookupBody).includes(own.workspace)
    && !JSON.stringify(lookupBody).includes(own.project), "QA_GATEWAY_PUBLIC_LOOKUP_FAILED");
  const wrongOrigin = await fetch(`${base}/api/public/integrations/forms?form_id=${own.form}`, {
    headers: { ...headers, origin: "https://wrong.example" },
  });
  const wrongForm = await fetch(`${base}/api/public/integrations/forms?form_id=${foreign.form}`, { headers });
  requireProof(wrongOrigin.status === 404 && wrongForm.status === 404, "QA_GATEWAY_SCOPE_BYPASS");

  const submissionKey = randomBytes(24).toString("base64url");
  const submissionBody = JSON.stringify({
    fields: {
      email: `gateway-${marker}@example.invalid`,
      name: `SYNTHETIC Gateway ${marker}`,
      privacy: "true",
    },
    formId: own.form,
  });
  const submissionHeaders = {
    ...headers,
    "content-type": "application/json",
    "idempotency-key": submissionKey,
  };
  const beforeEffects = await gatewayBusinessEffects();
  const first = await fetch(`${base}/api/public/integrations/forms/submissions`, {
    body: submissionBody, headers: submissionHeaders, method: "POST",
  });
  const firstBody = await first.json().catch(() => ({}));
  const afterFirstEffects = await gatewayBusinessEffects();
  const replay = await fetch(`${base}/api/public/integrations/forms/submissions`, {
    body: submissionBody, headers: submissionHeaders, method: "POST",
  });
  const replayBody = await replay.json().catch(() => ({}));
  const afterReplayEffects = await gatewayBusinessEffects();
  requireProof(first.status === 202 && replay.status === 202 && firstBody.reference === replayBody.reference
    && afterFirstEffects.submissions === beforeEffects.submissions + 1
    && JSON.stringify(afterReplayEffects) === JSON.stringify(afterFirstEffects)
    && !JSON.stringify(firstBody).includes(own.workspace), "QA_GATEWAY_SUBMISSION_FAILED");
  const formEvents = (await owner.query(`select outcome,count(*)::int count
    from external_integration_events where workspace_id=$1 and event_type='form.submit'
    group by outcome order by outcome`, [own.workspace])).rows;
  requireProof(JSON.stringify(formEvents) === JSON.stringify([
    { outcome: "accepted", count: 1 }, { outcome: "duplicate", count: 1 },
  ]), "QA_GATEWAY_REPLAY_AUDIT_INVALID");

  const chatStartKey = randomBytes(24).toString("base64url");
  const chatStart = await fetch(`${base}/api/public/integrations/chat/sessions`, {
    body: JSON.stringify({ idempotencyKey: chatStartKey, language: "en" }),
    headers: { ...headers, "content-type": "application/json" },
    method: "POST",
  });
  const session = await chatStart.json().catch(() => ({}));
  requireProof(chatStart.status === 201 && session.mode === "training"
    && typeof session.sessionId === "string" && typeof session.sessionToken === "string",
  "QA_GATEWAY_CHAT_START_FAILED");
  const message = await fetch(`${base}/api/public/integrations/chat/messages`, {
    body: JSON.stringify({
      idempotencyKey: randomBytes(24).toString("base64url"),
      message: "SYNTHETIC Candidate chat message",
      sessionId: session.sessionId,
    }),
    headers: {
      ...headers,
      "content-type": "application/json",
      "x-novalure-session-token": session.sessionToken,
    },
    method: "POST",
  });
  const context = await fetch(
    `${base}/api/public/integrations/chat/sessions?session_id=${session.sessionId}`,
    { headers: { ...headers, "x-novalure-session-token": session.sessionToken } },
  );
  const contextBody = await context.json().catch(() => ({}));
  requireProof(message.status === 202 && context.status === 200
    && contextBody.mode === "training" && contextBody.messages?.length === 1
    && contextBody.messages[0]?.content === "SYNTHETIC Candidate chat message",
  "QA_GATEWAY_CHAT_CONTEXT_FAILED");
  requireProof(await scalar(owner, `select count(*)::int as value from external_chat_sessions
    where integration_id=(select id from external_integrations where public_site_key=$1) and synthetic`, [siteKey]) === 1,
  "QA_GATEWAY_CHAT_NOT_SYNTHETIC");
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
  await attestGateway();
  await attestWebsiteSales();
  console.log(`CRM_CANDIDATE_QA_PASS project=${qa.expectedProjectId} branch=${qa.expectedBranchId} migration=094,095,096 forms=RLS_FORCE formSave=PASS gateway=PASS chat=TRAINING sales=PASS replay=PASS lookupRole=NOLOGIN`);
} catch (error) {
  const code = error instanceof Error && /^QA_[A-Z0-9_]+$/u.test(error.message) ? error.message : "QA_UNEXPECTED_FAILURE";
  console.error(`CRM_CANDIDATE_QA_FAIL code=${code}`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([owner.end(), app.end()]);
}
