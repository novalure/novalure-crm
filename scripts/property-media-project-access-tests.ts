import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import { hashPassword } from "../src/lib/auth/passwords";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { withCrmRead, type TenantTransactionOptions } from "../src/lib/crm-command";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { hashMediaShareToken } from "../src/lib/media-security";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { seedSalesBrowser } from "./lib/sales-browser-fixture.mjs";

test("ordinary property files inherit project access in services and real PostgreSQL RLS", { timeout: 240_000 }, async (t) => {
  const db = await startLocalSalesDb();
  const keys = ["DATABASE_URL", "NODE_ENV", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_MEDIA_ROOT", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN", "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "NOVALURE_DEMO_AUTH_ENABLED", "NOVALURE_TRUST_AUTH_HEADERS", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN", "BLOB_PRIVATE_READ_WRITE_TOKEN", "NOVALURE_PUBLIC_BLOB_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const fixtureRoot = path.resolve(".npm-cache", "qa");
  const filesRoot = await mkdtemp(path.join(fixtureRoot, "project-media-"));
  try {
    const applyManual = async (name: string) => {
      const sql = await readFile(`migrations/${name}`, "utf8");
      const client = await db.admin.connect();
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3) on conflict(version) do nothing",
          [name.replace(/\.sql$/u, ""), name, createHash("sha256").update(sql).digest("hex")]);
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    };
    await applySalesSchema(db, { maxMigrationNumber: 188, afterMigration: async (name: string) => {
      if (Number(name.slice(0, 3)) === 90) {
        // Match the already qualified gateway fixture: enforce actual table
        // postconditions before applying original 092-096, without a fake091.
        await db.admin.query("alter table company_profiles enable row level security;alter table company_profiles force row level security;alter table company_profile_versions enable row level security;alter table company_profile_versions force row level security");
        await db.admin.query("do $$ declare r record; begin for r in select format('%I.%I',n.nspname,c.relname) as q from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity loop execute 'alter table '||r.q||' force row level security'; end loop; end $$");
        for (const manual of ["092_crm_production_machine_identity.sql", "093_crm_machine_internal_context.sql", "094_website_sales_ingestion.sql", "095_form_tenant_isolation.sql", "096_public_integration_gateway.sql"]) await applyManual(manual);
      }
      if (Number(name.slice(0, 3)) === 114) await applyManual("121_webchat_customer_product.sql");
    } });
    await seedSalesBrowser(db); // Existing synthetic HTTP-auth bootstrap grants only.
    for (const key of keys) delete process.env[key];
    const origin = "http://127.0.0.1:3000", secret = randomBytes(48).toString("base64url");
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, NODE_ENV: "test", CRM_LOCAL_TEST_DATABASE: "1", NOVALURE_MEDIA_ROOT: filesRoot, NOVALURE_SESSION_SECRET: secret, NOVALURE_APP_ORIGIN: origin, NOVALURE_AUTH_STRICT: "1", NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"), NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex") });
    const media = await import("../src/lib/media-store");
    const ids = { w: randomUUID(), foreign: randomUUID(), owner: randomUUID(), member: randomUUID(), reader: randomUUID(), partner: randomUUID(), a: randomUUID(), b: randomUUID(), pa: randomUUID(), otherPa: randomUUID(), pb: randomUUID(), nullProperty: randomUUID(), unit: randomUUID(), legacyUnit: randomUUID(), wrongParentUnit: randomUUID() };
    await db.admin.query("insert into workspaces(id,name,operating_model) values($1,'Synthetic media QA','self_service_customer'),($2,'Synthetic foreign QA','self_service_customer')", [ids.w, ids.foreign]);
    const cookies = new Map<string, string>();
    for (const [user, role, productRole] of [[ids.owner, "owner", "customer_owner"], [ids.member, "agent", "project_sales_member"], [ids.reader, "agent", "project_sales_member"], [ids.partner, "agent", "external_partner"]]) {
      const identity = (await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,'Synthetic member',$3,$4,$5,'active',now()) returning auth_identity_id", [user, ids.w, `media-${user}@example.invalid`, role, productRole])).rows[0].auth_identity_id;
      await db.admin.query("update auth_identities set credential_state='active',password_hash=$2 where id=$1", [identity, await hashPassword(randomBytes(32).toString("base64url"))]);
      const cookie = "v2." + randomBytes(32).toString("base64url");
      cookies.set(user, cookie);
      await db.admin.query("insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '1 hour')", [randomUUID(), createHash("sha256").update(cookie).digest("hex"), identity, user, ids.w]);
    }
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$3,'Synthetic project A','Bauträger'),($2,$3,'Synthetic project B','Bauträger')", [ids.a, ids.b, ids.w]);
    await db.admin.query("insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,true),($1,$2,$4,true,false),($1,$5,$6,true,true)", [ids.w, ids.a, ids.member, ids.reader, ids.b, ids.partner]);
    for (const [property, project] of [[ids.pa, ids.a], [ids.otherPa, ids.a], [ids.pb, ids.b], [ids.nullProperty, null]]) {
      await db.admin.query("insert into seller_listings(id,workspace_id,project_id,title,address,region,object_type,area_sqm,price_visibility) values($1,$2,$3,'Synthetic property','Synthetic address','Wien','Wohnung',70,'price_on_request')", [property, ids.w, project]);
    }
    for (const [unit, property] of [[ids.unit, ids.pa], [ids.legacyUnit, null], [ids.wrongParentUnit, ids.otherPa]]) {
      await db.admin.query("insert into property_units(id,workspace_id,project_id,unit_number,status,metadata) values($1,$2,$3,$4,'available',$5::jsonb)", [unit, ids.w, ids.a, unit, JSON.stringify(property ? { sellerListingId: property } : {})]);
    }
    await db.admin.query("update seller_listings set unit_id=$2 where id=$1", [ids.pa, ids.legacyUnit]);
    const owner: AppSession = { authenticated: true, workspaceId: ids.w, userId: ids.owner, workspaceName: "Synthetic media QA", name: "Synthetic owner", email: `media-${ids.owner}@example.invalid`, role: "owner", productRole: "customer_owner", permissions: getRolePermissions("owner"), productPermissions: getProductRoleCapabilities("customer_owner"), source: "cookie" };
    const options: TenantTransactionOptions = { pool: db.pool as unknown as NonNullable<TenantTransactionOptions["pool"]> };
    const scoped = <T>(user: string, callback: () => Promise<T>) => withCrmRead({ ...owner, userId: user }, callback, options);
    const pdf = () => new File(["%PDF-1.7\nSYNTHETIC PRIVATE PROJECT BYTES\n%%EOF"], "synthetic.pdf", { type: "application/pdf" });
    // Seed known private bytes before 189 without depending on the new upload
    // quota function. Actual authenticated uploads are tested after the cutover.
    const save = async (folder: string) => {
      const id = randomUUID(), relative = `${ids.w}/${id}.pdf`, bytes = Buffer.from(await pdf().arrayBuffer());
      await mkdir(path.join(filesRoot, "uploads", ids.w), { recursive: true });
      await writeFile(path.join(filesRoot, "uploads", relative), bytes);
      await db.admin.query("insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,relative_path,storage_provider,storage_access) values($1,$2,'Synthetic file','synthetic.pdf',$3,'application/pdf',$4,$5,$6,'local','private')", [id, ids.w, folder, bytes.length, `/api/media/files/${id}`, relative]);
      const asset = await scoped(ids.owner, () => media.findWorkspaceMediaAsset(id, ids.w)); assert.ok(asset); return asset;
    };
    const own = await save(`properties/${ids.pa}`), denied = await save(`properties/${ids.pb}`), bound = await save("media-uploads"), shared = await save("media-uploads");
    const multiple = await save("media-uploads"), mismatch = await save(`properties/${ids.pa}`), boundOwn = await save("media-uploads");
    await db.admin.query("insert into property_documents(workspace_id,project_id,property_id,media_asset_id,title) values($1,$2,$3,$4,'Synthetic hidden attachment')", [ids.w, ids.b, ids.pb, bound.id]);
    for (const [asset, project, property] of [[multiple.id, ids.a, ids.pa], [multiple.id, ids.b, ids.pb], [mismatch.id, ids.b, ids.pb]]) {
      await db.admin.query("insert into property_media(workspace_id,project_id,property_id,media_asset_id) values($1,$2,$3,$4)", [ids.w, project, property, asset]);
    }
    await db.admin.query("insert into property_documents(workspace_id,project_id,property_id,media_asset_id,title) values($1,$2,$3,$4,'Synthetic own attachment')", [ids.w, ids.a, ids.pa, boundOwn.id]);
    const unitAsset = await save(`properties/${ids.pa}`), legacyUnitAsset = await save(`properties/${ids.pa}`), wrongUnitAsset = await save(`properties/${ids.pa}`), unitOnlyAsset = await save("media-uploads");
    for (const [asset, property, unit] of [[unitAsset.id, ids.pa, ids.unit], [legacyUnitAsset.id, ids.pa, ids.legacyUnit], [wrongUnitAsset.id, ids.pa, ids.wrongParentUnit], [unitOnlyAsset.id, null, ids.unit]]) {
      await db.admin.query("insert into property_media(workspace_id,project_id,property_id,unit_id,media_asset_id) values($1,$2,$3,$4,$5)", [ids.w, ids.a, property, unit, asset]);
    }
    const hiddenShare = "SYNTHETIC-B-public-share";
    await db.admin.query("update media_assets set is_public=true where id=$1", [denied.id]);
    const deniedShare = (await db.admin.query("insert into media_asset_shares(asset_id,workspace_id,token_hash,expires_at) values($1,$2,$3,now()+interval '1 hour') returning id", [denied.id, ids.w, hashMediaShareToken(hiddenShare)])).rows[0].id;
    await t.test("qualify predecessor 188 locally: restricted member can read another project's ordinary private bytes", async () => {
      await scoped(ids.member, async () => {
        assert.equal((await media.findWorkspaceMediaAsset(denied.id, ids.w))?.id, denied.id);
        const content = await media.readMediaAssetContent(denied);
        assert.ok(content); assert.match(await new Response(content.body).text(), /SYNTHETIC PRIVATE PROJECT BYTES/);
        assert.equal((await media.findWorkspaceMediaAsset(bound.id, ids.w))?.id, bound.id);
      });
    });
    await db.admin.query(await readFile("migrations/189_property_media_project_access.sql", "utf8"));
    // Qualify the definer under a real non-superuser schema owner as well as
    // the unprivileged tenant runtime: FORCE RLS stays enabled throughout.
    await db.admin.query("create role synthetic_media_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant usage on schema public to synthetic_media_owner");
    for (const relation of ["workspaces", "workspace_users", "project_pipeline_permissions", "seller_listings", "property_units", "property_media", "property_documents", "media_assets", "media_asset_shares"]) {
      await db.admin.query(`alter table ${relation} owner to synthetic_media_owner`);
    }
    await db.admin.query("alter function crm_property_media_access(text,text,uuid,boolean) owner to synthetic_media_owner; alter function crm_public_media_lookup(text) owner to synthetic_media_owner; alter function crm_workspace_media_usage(text) owner to synthetic_media_owner");
    // Apply the real cumulative successor after the representative owner is fixed.
    await db.admin.query(await readFile("migrations/191_webchat_partner_access_compatibility.sql", "utf8"));
    assert.deepEqual((await db.admin.query("select has_function_privilege('synthetic_media_owner','crm_webchat_customer_member(uuid)','EXECUTE') as predicate, pg_has_role('synthetic_media_owner','novalure_tenant_app','MEMBER') as broad_role")).rows[0], { predicate: true, broad_role: false });
    await t.test("runtime and definer owner have no superuser/BYPASSRLS; media and parents retain FORCE RLS", async () => {
      assert.ok((await db.admin.query("select rolsuper,rolbypassrls from pg_roles where rolname=any($1::text[])", [ [db.role, "novalure_tenant_app", "synthetic_media_owner"] ])).rows.every(row => !row.rolsuper && !row.rolbypassrls));
      assert.ok((await db.admin.query("select relrowsecurity,relforcerowsecurity from pg_class where oid=any($1::regclass[])", [["media_assets", "media_asset_shares", "property_media", "property_documents", "seller_listings", "property_units"]])).rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
    });
    const route = await import("../src/app/api/media/route");
    const files = await import("../src/app/api/media/files/[assetId]/route");
    const publicFiles = await import("../src/app/api/media/public/[token]/route");
    const publicDownload = (token: string) => publicFiles.GET(new Request(origin + "/api/media/public/" + token), { params: Promise.resolve({ token }) });
    const request = (user: string, pathname: string, body?: Record<string, unknown> | FormData) => {
      const cookie = cookies.get(user)!;
      const headers: Record<string, string> = { cookie: "novalure_session=" + cookie, origin, "sec-fetch-site": "same-origin" };
      if (body) headers["x-novalure-csrf-token"] = createCsrfToken({ method: "POST", pathname, secret, sessionCookie: cookie })!.token;
      if (body && !(body instanceof FormData)) headers["content-type"] = "application/json";
      return new Request(origin + pathname, { headers, method: body ? "POST" : "GET", body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    };
    const download = (user: string, assetId: string) => files.GET(request(user, `/api/media/files/${assetId}`), { params: Promise.resolve({ assetId }) });
    const publish = (user: string, assetId: string, action = "publish") => route.POST(request(user, "/api/media", { action, assetId }));
    const sqlDenied = (promise: Promise<unknown>) => assert.rejects(promise, (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "42501"));
    await t.test("cookie service list/private bytes/share denies project B and hidden binding, permits project A", async () => {
      const listing = await route.GET(request(ids.member, "/api/media")); assert.equal(listing.status, 200);
      const visible = (await listing.json()).assets.map((asset: { id: string }) => asset.id);
      assert.ok(visible.includes(own.id)); assert.ok(visible.includes(shared.id));
      for (const asset of [denied, bound, multiple, mismatch]) { assert.ok(!visible.includes(asset.id)); assert.equal((await download(ids.member, asset.id)).status, 404); assert.equal((await publish(ids.member, asset.id)).status, 404); }
      assert.equal((await download(ids.owner, multiple.id)).status, 200);
      assert.equal((await download(ids.owner, mismatch.id)).status, 404);
      assert.equal((await download(ids.member, boundOwn.id)).status, 200);
      for (const asset of [unitAsset, legacyUnitAsset, unitOnlyAsset]) assert.equal((await download(ids.member, asset.id)).status, 200);
      assert.equal((await download(ids.member, wrongUnitAsset.id)).status, 404);
      assert.equal((await publish(ids.member, wrongUnitAsset.id)).status, 404);
      const allowed = await download(ids.member, own.id); assert.equal(allowed.status, 200); assert.match(await allowed.text(), /SYNTHETIC PRIVATE PROJECT BYTES/); assert.equal(allowed.headers.get("cache-control"), "private, no-store");
      assert.equal((await publish(ids.reader, own.id)).status, 404); assert.equal((await download(ids.reader, own.id)).status, 200);
    });
    await t.test("adversarial direct SQL cannot read, edit, launder, insert or mint/extend project B shares", async () => {
      await scoped(ids.member, async () => {
        const { currentTenantTransaction } = await import("../src/lib/db/transaction-context"); const tx = currentTenantTransaction()!.transaction;
        assert.deepEqual(await tx.query("select id from media_assets where id=any($1::uuid[])", [[denied.id, bound.id, multiple.id, mismatch.id]]), []);
        assert.deepEqual(await tx.query("update media_assets set folder='media-uploads' where id=$1 returning id", [denied.id]), []);
        assert.deepEqual(await tx.query("update media_asset_shares set expires_at=now()+interval '2 hours' where id=$1 returning id", [deniedShare]), []);
      });
      await sqlDenied(scoped(ids.member, async () => { const { currentTenantTransaction } = await import("../src/lib/db/transaction-context"); await currentTenantTransaction()!.transaction.execute("insert into media_asset_shares(asset_id,workspace_id,token_hash,expires_at) values($1,$2,$3,now()+interval '1 hour')", [denied.id, ids.w, hashMediaShareToken("SYNTHETIC-unauthorized")]); }));
      await sqlDenied(scoped(ids.member, async () => { const { currentTenantTransaction } = await import("../src/lib/db/transaction-context"); await currentTenantTransaction()!.transaction.execute("update media_assets set folder=$2 where id=$1", [own.id, `properties/${ids.pb}`]); }));
      await sqlDenied(scoped(ids.member, () => media.saveWorkspaceFile({ workspaceId: ids.w, folder: `properties/${ids.pb}`, file: pdf() })));
      await sqlDenied(scoped(ids.owner, () => media.saveWorkspaceFile({ workspaceId: ids.w, folder: `properties/${ids.nullProperty}`, file: pdf() })));
      await sqlDenied(scoped(ids.member, async () => { const { currentTenantTransaction } = await import("../src/lib/db/transaction-context"); await currentTenantTransaction()!.transaction.execute("insert into property_documents(workspace_id,project_id,property_id,media_asset_id,title) values($1,$2,$3,$4,'Forged project binding')", [ids.w, ids.b, ids.pb, shared.id]); }));
      await sqlDenied(scoped(ids.reader, async () => { const { currentTenantTransaction } = await import("../src/lib/db/transaction-context"); await currentTenantTransaction()!.transaction.execute("insert into media_asset_shares(asset_id,workspace_id,token_hash,expires_at) values($1,$2,$3,now()+interval '1 hour')", [own.id, ids.w, hashMediaShareToken("SYNTHETIC-read-only-mint")]); }));
      for (const asset of [bound, multiple, mismatch]) {
        await sqlDenied(scoped(ids.member, async () => { const { currentTenantTransaction } = await import("../src/lib/db/transaction-context"); await currentTenantTransaction()!.transaction.execute("insert into media_asset_shares(asset_id,workspace_id,token_hash,expires_at) values($1,$2,$3,now()+interval '1 hour')", [asset.id, ids.w, hashMediaShareToken("SYNTHETIC-forged-" + asset.id)]); }));
      }
      assert.equal((await db.admin.query("select folder from media_assets where id=$1", [own.id])).rows[0].folder, `properties/${ids.pa}`);
    });
    await t.test("service upload rejects inaccessible, malformed, absent and projectless parent before any storage side effect", async () => {
      const diskBefore = await readdir(path.join(filesRoot, "uploads"), { recursive: true });
      const countBefore = (await db.admin.query("select count(*)::int as n from media_assets")).rows[0].n;
      for (const folder of [`properties/${ids.pb}`, `PROPERTIES/${ids.pb.toUpperCase()}`, "properties/not-a-uuid", `properties/${randomUUID()}`, `properties/${ids.nullProperty}`]) {
        const form = new FormData(); form.set("file", pdf()); form.set("folder", folder);
        assert.equal((await route.POST(request(ids.member, "/api/media", form))).status, 403, folder);
      }
      assert.deepEqual(await readdir(path.join(filesRoot, "uploads"), { recursive: true }), diskBefore);
      assert.equal((await db.admin.query("select count(*)::int as n from media_assets")).rows[0].n, countBefore);
      const form = new FormData(); form.set("file", pdf()); form.set("folder", `properties/${ids.pa}`);
      assert.equal((await route.POST(request(ids.member, "/api/media", form))).status, 201);
    });
    await t.test("hidden project bytes count toward the shared quota and block own-project storage before writes", async () => {
      const actualSize = denied.sizeBytes;
      await db.admin.query("update media_assets set size_bytes=$2 where id=$1", [denied.id, media.workspaceImageQuotaBytes]);
      try {
        const listing = await route.GET(request(ids.member, "/api/media")); assert.equal(listing.status, 200);
        const body = await listing.json(); assert.ok(body.quota.usedBytes >= media.workspaceImageQuotaBytes); assert.equal(body.quota.remainingBytes, 0); assert.ok(!body.assets.some((asset: { id: string }) => asset.id === denied.id));
        const before = await readdir(path.join(filesRoot, "uploads"), { recursive: true });
        const form = new FormData(); form.set("file", pdf()); form.set("folder", `properties/${ids.pa}`);
        const response = await route.POST(request(ids.member, "/api/media", form)); assert.equal(response.status, 409); assert.equal((await response.json()).code, "WORKSPACE_QUOTA_EXCEEDED");
        assert.deepEqual(await readdir(path.join(filesRoot, "uploads"), { recursive: true }), before);
      } finally { await db.admin.query("update media_assets set size_bytes=$2 where id=$1", [denied.id, actualSize]); }
    });
    await t.test("own project share works anonymously, invalid/expired/revoked shares fail closed", async () => {
      const response = await publish(ids.member, own.id); assert.equal(response.status, 200);
      const asset = (await response.json()).asset; const token = new URL(asset.publicUrl, origin).pathname.split("/").at(-1)!;
      assert.equal((await media.findPublicMediaAsset(token))?.id, own.id);
      const publicBytes = await publicDownload(token); assert.equal(publicBytes.status, 200); assert.match(await publicBytes.text(), /SYNTHETIC PRIVATE PROJECT BYTES/);
      await sqlDenied(scoped(ids.member, async () => { const { currentTenantTransaction } = await import("../src/lib/db/transaction-context"); await currentTenantTransaction()!.transaction.execute("update media_asset_shares set asset_id=$2 where asset_id=$1", [own.id, denied.id]); }));
      assert.equal(await media.findPublicMediaAsset("SYNTHETIC-invalid"), null);
      await db.admin.query("update media_asset_shares set expires_at=now()-interval '1 second',created_at=now()-interval '2 seconds' where asset_id=$1", [own.id]);
      assert.equal(await media.findPublicMediaAsset(token), null);
      assert.equal((await publicDownload(token)).status, 404);
      assert.equal((await publish(ids.member, own.id)).status, 200);
      assert.equal((await publish(ids.member, own.id, "revoke")).status, 200);
      assert.equal(await media.findPublicMediaAsset(token), null);
      assert.equal((await publicDownload(token)).status, 404);
    });
    await t.test("fresh project revocation denies the existing cookie and direct SQL without affecting owner", async () => {
      await db.admin.query("update project_pipeline_permissions set can_read=false,can_edit_deals=false where workspace_id=$1 and project_id=$2 and user_id=$3", [ids.w, ids.a, ids.member]);
      assert.equal((await download(ids.member, own.id)).status, 404); assert.equal((await publish(ids.member, own.id)).status, 404);
      assert.equal((await download(ids.owner, own.id)).status, 200);
      assert.equal(await scoped(ids.member, () => media.findWorkspaceMediaAsset(own.id, ids.w)), null);
    });
    await t.test("external partner, Knowledge/Proof prefixes, foreign scope and inactive membership remain denied", async () => {
      const partnerList = await route.GET(request(ids.partner, "/api/media")); assert.equal(partnerList.status, 200);
      const partnerBody = await partnerList.json(); assert.deepEqual(partnerBody.assets, []); assert.equal(partnerBody.quota.usedBytes, 0);
      for (const asset of [own, denied, shared]) { assert.equal((await download(ids.partner, asset.id)).status, 404); assert.equal((await publish(ids.partner, asset.id)).status, 404); }
      const leadId = randomUUID();
      await db.admin.query("insert into leads(id,workspace_id,project_id,type,intent) values($1,$2,$3,'Käufer','Synthetic proof')", [leadId, ids.w, ids.a]);
      const special = [await scoped(ids.owner, () => media.saveKnowledgeFile({ workspaceId: ids.w, actorId: ids.owner, file: pdf() })), await scoped(ids.owner, () => media.saveLeadProofFile({ workspaceId: ids.w, actorId: ids.owner, leadId, file: pdf() }))];
      for (const asset of special) {
        assert.equal((await download(ids.owner, asset.id)).status, 404); assert.equal((await publish(ids.owner, asset.id)).status, 404);
        assert.equal(await media.readMediaAssetContent(asset), null);
        await assert.rejects(scoped(ids.owner, async () => { const { currentTenantTransaction } = await import("../src/lib/db/transaction-context"); await currentTenantTransaction()!.transaction.execute("update media_assets set is_public=true where id=$1", [asset.id]); }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && ["23514", "42501"].includes(String(error.code))));
      }
      const list = (await (await route.GET(request(ids.owner, "/api/media"))).json()).assets;
      assert.ok(special.every(asset => !list.some((entry: { id: string }) => entry.id === asset.id)));
      assert.equal(await scoped(ids.owner, () => media.findWorkspaceMediaAsset(own.id, ids.foreign)), null);
      await db.admin.query("update workspace_users set status='invited' where id=$1", [ids.member]);
      assert.equal((await download(ids.member, own.id)).status, 401);
      assert.equal((await db.pool.query("select count(*)::int as n from media_assets")).rows[0].n, 0);
      assert.equal((await db.pool.query("select count(*)::int as n from media_asset_shares")).rows[0].n, 0);
    });
  } finally {
    await closeLocalTestPool();
    try { await db.stop(); } finally {
      for (const directory of [db.directory, filesRoot]) { assert.ok(path.resolve(directory).startsWith(fixtureRoot + path.sep)); await rm(directory, { recursive: true, force: true }); }
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    }
  }
});
