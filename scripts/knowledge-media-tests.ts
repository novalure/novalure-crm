import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import { withTenantTransaction, type TenantPool } from "../src/lib/db/tenant-client";
import { runWithTenantTransaction } from "../src/lib/db/transaction-context";
import { hashMediaShareToken, mediaPublicShareScope } from "../src/lib/media-security";

const environmentKeys = ["CRM_LOCAL_TEST_DATABASE", "DATABASE_URL", "NODE_ENV", "NOVALURE_MEDIA_ROOT", "VERCEL", "VERCEL_ENV", "VERCEL_URL",
  "NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN", "BLOB_PRIVATE_READ_WRITE_TOKEN", "NOVALURE_PUBLIC_BLOB_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN"];
const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key,process.env[key]]));
let root: string;
let media: typeof import("../src/lib/media-store");
const workspaceId = randomUUID(), foreignWorkspaceId = randomUUID(), actorId = randomUUID();
let db: Awaited<ReturnType<typeof startLocalSalesDb>>;
let document: Awaited<ReturnType<typeof media.saveKnowledgeFile>>;
let ordinary: Awaited<ReturnType<typeof media.saveWorkspaceFile>>;
const pdf = () => new File(["%PDF-1.7\nSYNTHETIC PRIVATE KNOWLEDGE DOCUMENT\n%%EOF"], "private.pdf", { type: "application/pdf" });
const scoped = <T>(callback: () => Promise<T>, workspace = workspaceId, actor = actorId) => {
  const scope = { workspaceId: workspace,actorId: actor };
  return withTenantTransaction(scope,tx => runWithTenantTransaction(scope,tx,callback),{pool:db.pool as unknown as TenantPool});
};

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "knowledge-media-"));
  process.env.NOVALURE_MEDIA_ROOT = root;
  media = await import("../src/lib/media-store");
  db = await startLocalSalesDb();
  await db.admin.query("create role novalure_tenant_app nologin noinherit nosuperuser nobypassrls");
  await db.admin.query(`grant novalure_tenant_app to ${db.role}`);
  await db.admin.query(await readFile("migrations/045_media_schema.sql", "utf8"));
  await db.admin.query(`alter table media_assets add column storage_access text not null default 'private',
    add column studio_enquiry_operation_id uuid;
    alter table media_assets add unique(id,workspace_id),add unique(id,workspace_id,studio_enquiry_operation_id);
    create table media_asset_shares(id uuid primary key default gen_random_uuid(),asset_id uuid,
      workspace_id text not null,token_hash text not null,scope text not null,expires_at timestamptz not null,
      revoked_at timestamptz,created_at timestamptz not null default now(),
      foreign key(asset_id,workspace_id) references media_assets(id,workspace_id) on delete cascade);
    create table bot_document_sends(id uuid primary key,media_asset_id uuid references media_assets(id) on delete set null);
    create table property_documents(id uuid primary key,media_asset_id uuid references media_assets(id) on delete set null);
    create table property_media(id uuid primary key,media_asset_id uuid references media_assets(id) on delete set null);
    create table studio_enquiry_assets(id uuid primary key,media_asset_id uuid,workspace_id text,operation_id uuid,
      foreign key(media_asset_id,workspace_id,operation_id) references media_assets(id,workspace_id,studio_enquiry_operation_id));
    create table knowledge_source_versions(id uuid primary key,media_asset_id uuid references media_assets(id),archived boolean not null default false);
    alter table knowledge_source_versions enable row level security;
    alter table knowledge_source_versions force row level security;
    alter table media_assets enable row level security;
    alter table media_assets force row level security;
    create policy workspace_media on media_assets to novalure_tenant_app
      using(workspace_id=current_setting('app.tenant_id',true))
      with check(workspace_id=current_setting('app.tenant_id',true));
    grant usage on schema public to novalure_tenant_app;
    grant select,insert,update,delete on media_assets,media_asset_shares to novalure_tenant_app;
    -- Synthetic counters exercise the application protocol against actual FKs.
    -- The unchanged production SQL is covered by the migration/security suite.
    create function crm_studio_media_reference_counts(p_asset uuid)
      returns table(media_count integer,document_count integer,send_count integer,share_count integer,studio_count integer)
      language sql stable security definer set search_path=pg_catalog,public as $$
        select (select count(*)::integer from property_media where media_asset_id=p_asset),
          (select count(*)::integer from property_documents where media_asset_id=p_asset),
          (select count(*)::integer from bot_document_sends where media_asset_id=p_asset),
          (select count(*)::integer from media_asset_shares where asset_id=p_asset),
          (select count(*)::integer from studio_enquiry_assets where media_asset_id=p_asset)
        from media_assets where id=p_asset and workspace_id=current_setting('app.tenant_id',true) $$;
    create function crm_knowledge_media_reference_counts(p_asset uuid)
      returns table(media_count integer,document_count integer,send_count integer,share_count integer,studio_count integer,knowledge_count integer)
      language sql stable security definer set search_path=pg_catalog,public as $$
        select previous.*,(select count(*)::integer from knowledge_source_versions where media_asset_id=p_asset)
        from crm_studio_media_reference_counts(p_asset) previous $$;
    revoke all on function crm_studio_media_reference_counts(uuid),crm_knowledge_media_reference_counts(uuid) from public;
    grant execute on function crm_studio_media_reference_counts(uuid),crm_knowledge_media_reference_counts(uuid) to novalure_tenant_app;`);
  for (const key of environmentKeys) if (key !== "NOVALURE_MEDIA_ROOT") delete process.env[key];
  Object.assign(process.env,{CRM_LOCAL_TEST_DATABASE:"1",DATABASE_URL:`postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,NODE_ENV:"test"});
  ordinary = await scoped(() => media.saveWorkspaceFile({workspaceId,file:pdf()}));
  document = await scoped(() => media.saveKnowledgeFile({workspaceId,actorId,file:pdf()}));
  // These rows are deliberately unavailable to runtime. Privacy must not rely
  // on a NOT EXISTS lookup that source/project RLS could make falsely negative.
  await db.admin.query("insert into knowledge_source_versions values($1,$2,false),($3,$2,true)",[randomUUID(),document.id,randomUUID()]);
});

after(async () => {
  await closeLocalTestPool();
  if (db) await db.stop();
  if (root) await rm(root,{recursive:true,force:true});
  for (const [key,value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("generic lists and direct object lookup hide current and archived knowledge attachments", async () => {
  await scoped(async () => {
    const listed = await media.listWorkspaceMedia(workspaceId);
    assert.deepEqual(listed.assets.map(asset => asset.id),[ordinary.id]);
    assert.equal(await media.findWorkspaceMediaAsset(document.id,workspaceId),null);
    assert.equal((await media.findWorkspaceMediaAsset(ordinary.id,workspaceId))?.id,ordinary.id);
    assert.equal(await media.findWorkspaceMediaAsset(document.id,foreignWorkspaceId),null);
  });
  await db.admin.query("delete from knowledge_source_versions where media_asset_id=$1",[document.id]);
  assert.equal(await scoped(() => media.findWorkspaceMediaAsset(document.id,workspaceId)),null,
    "the permanent storage classification survives even removal of all source references");
});

test("generic publication, renewal and deletion cannot expose knowledge attachments", async () => {
  await scoped(async () => {
    assert.equal(await media.publishWorkspaceMedia(document.id,workspaceId),null);
    assert.equal(await media.extendWorkspaceMediaShare(document.id,workspaceId,randomUUID(),86400),null);
    assert.equal(await media.revokeWorkspaceMediaPublication(document.id,workspaceId),null);
  });
  await assert.rejects(media.deleteWorkspaceMedia(document.id,workspaceId,{actorId,pool:db.pool as unknown as TenantPool}),
    error => {
      assert.ok(error instanceof media.MediaStoreError, String(error));
      assert.equal(error.code,"MEDIA_DELETE_IN_USE");
      return true;
    });
  assert.equal((await db.admin.query("select count(*)::int as count from media_asset_shares where asset_id=$1",[document.id])).rows[0].count,0);
});

test("a stale public token cannot serve a marked knowledge attachment", async () => {
  const token = "SYNTHETIC-existing-public-token";
  await db.admin.query("update media_assets set is_public=true where id=$1",[document.id]);
  await db.admin.query("insert into media_asset_shares(asset_id,workspace_id,token_hash,scope,expires_at) values($1,$2,$3,$4,now()+interval '1 hour')",
    [document.id,workspaceId,hashMediaShareToken(token),mediaPublicShareScope]);
  assert.equal(await scoped(() => media.findPublicMediaAsset(token)),null);
  assert.equal(await scoped(() => media.authorizedKnowledgeMediaAsset(document.id,workspaceId)),null);
  await db.admin.query("delete from media_asset_shares where asset_id=$1",[document.id]);
  await db.admin.query("update media_assets set is_public=false where id=$1",[document.id]);
});

test("only the authorized source path obtains an opaque private byte-read capability", async () => {
  assert.equal(await media.readMediaAssetContent(document),null);
  assert.equal(await media.authorizedKnowledgeMediaAsset(document.id,workspaceId),null,"a tenant transaction is required");
  const authorized = await scoped(() => media.authorizedKnowledgeMediaAsset(document.id,workspaceId));
  assert.ok(authorized);
  const content = await media.readMediaAssetContent(authorized);
  assert.ok(content);
  assert.match(String(content.body),/SYNTHETIC PRIVATE KNOWLEDGE/);
  assert.equal(await media.readMediaAssetContent({...authorized}),null,"a cloned object is not an authorization capability");
  assert.equal(await scoped(() => media.authorizedKnowledgeMediaAsset(document.id,workspaceId),foreignWorkspaceId),null);
});

test("generic uploads cannot forge a protected folder and Knowledge uploads bind the authenticated actor", async () => {
  await assert.rejects(scoped(() => media.saveWorkspaceFile({workspaceId,file:pdf(),folder:`Knowledge-Private-${actorId}`})),
    error => error instanceof media.MediaStoreError && error.code === "KNOWLEDGE_MEDIA_PRIVATE");
  await assert.rejects(media.saveKnowledgeFile({workspaceId,actorId,file:pdf()}),
    error => error instanceof media.MediaStoreError && error.code === "KNOWLEDGE_MEDIA_PRIVATE");
  await assert.rejects(scoped(() => media.saveKnowledgeFile({workspaceId,actorId:randomUUID(),file:pdf()})),
    error => error instanceof media.MediaStoreError && error.code === "KNOWLEDGE_MEDIA_PRIVATE");
  assert.equal(document.folder,`${media.knowledgeMediaFolderPrefix}${actorId}`);
  assert.equal(document.storageAccess,"private");
  assert.equal(document.isPublic,false);
});

test("Knowledge uploads support validated UTF-8 documents without broadening generic media uploads", async () => {
  const text = new File(["SYNTHETIC company FAQ"],"faq.txt",{type:"text/plain"});
  const uploaded = await scoped(() => media.saveKnowledgeFile({workspaceId,actorId,file:text}));
  assert.equal(uploaded.mimeType,"text/plain");
  assert.equal(await scoped(() => media.findWorkspaceMediaAsset(uploaded.id,workspaceId)),null);
  await assert.rejects(scoped(() => media.saveWorkspaceFile({workspaceId,file:text})),
    error => error instanceof media.MediaStoreError && error.code === "UNSUPPORTED_FILE_TYPE");
  await assert.rejects(scoped(() => media.saveKnowledgeFile({workspaceId,actorId,
    file:new File([new Uint8Array([0xff,0x00])],"binary.txt",{type:"text/plain"})})),
    error => error instanceof media.MediaStoreError && error.code === "FILE_CONTENT_MISMATCH");
});

test("the deletion protocol checks inaccessible historical Knowledge references before touching bytes", async () => {
  const asset = await scoped(() => media.saveWorkspaceFile({workspaceId,file:pdf()}));
  await db.admin.query("insert into knowledge_source_versions values($1,$2,true)",[randomUUID(),asset.id]);
  await assert.rejects(media.deleteWorkspaceMedia(asset.id,workspaceId,{actorId,pool:db.pool as unknown as TenantPool}),
    error => error instanceof media.MediaStoreError && error.code === "MEDIA_DELETE_IN_USE");
  assert.equal(await media.mediaAssetExists(asset),true);
  assert.equal((await db.admin.query("select count(*)::int as count from media_assets where id=$1",[asset.id])).rows[0].count,1);
});

test("ordinary private media deletion remains usable with the additive Knowledge foreign key", async () => {
  assert.equal(await media.mediaAssetExists(ordinary),true);
  const deleted = await media.deleteWorkspaceMedia(ordinary.id,workspaceId,{actorId,pool:db.pool as unknown as TenantPool});
  assert.equal(deleted?.id,ordinary.id);
  assert.equal(await media.mediaAssetExists(ordinary),false);
  assert.equal((await db.admin.query("select count(*)::int as count from media_assets where id=$1",[ordinary.id])).rows[0].count,0);
});
