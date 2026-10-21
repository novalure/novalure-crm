import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startLocalSalesDb } from "./lib/local-sales-db.mjs";
import { package4HostedPrivateAssetInventorySql } from "./package4-neon-hosted-recovery.mjs";

test("private inventory retains the canonical text/UUID tenant column types", async () => {
  const media = await readFile(new URL("../migrations/003_media_storage.sql", import.meta.url), "utf8");
  const knowledge = await readFile(new URL("../migrations/101_knowledge_center.sql", import.meta.url), "utf8");
  assert.match(media, /create table if not exists media_assets\s*\(\s*id uuid[^,]+,\s*workspace_id text not null/iu);
  assert.match(knowledge, /create table knowledge_source_versions\s*\(\s*id uuid[^,]+,\s*workspace_id uuid not null/iu);
});

test("real PostgreSQL private inventory compares UUID tenants to legacy text safely", { timeout: 60_000 }, async t => {
  const db = await startLocalSalesDb();
  try {
    // Minimal column-type fixture, not a migration replay or RLS acceptance.
    // The types are pinned above to unchanged003 and unchanged101.
    await db.admin.query(`create table public.media_assets (
      id uuid primary key,workspace_id text not null,relative_path text not null,
      storage_provider text not null,storage_access text not null,is_public boolean not null,
      public_token text,size_bytes bigint not null);
      create table public.knowledge_source_versions (
      id uuid primary key,workspace_id uuid not null,media_asset_id uuid not null);`);
    const types = (await db.admin.query(`select c.relname,a.attname,format_type(a.atttypid,a.atttypmod) as type
      from pg_attribute a join pg_class c on c.oid=a.attrelid
      where c.relnamespace='public'::regnamespace and c.relname in ('media_assets','knowledge_source_versions')
        and a.attname='workspace_id' order by c.relname`)).rows;
    assert.deepEqual(types, [
      { relname: "knowledge_source_versions", attname: "workspace_id", type: "uuid" },
      { relname: "media_assets", attname: "workspace_id", type: "text" },
    ]);
    const a = randomUUID(), b = randomUUID();
    const paired = randomUUID(), mismatch = randomUUID(), legacy = randomUUID(), publicAsset = randomUUID();
    for (const [id, workspace, access] of [[paired, a, "private"], [mismatch, b, "private"],
      [legacy, "SYNTHETIC-legacy-non-UUID-tenant", "private"], [publicAsset, a, "public"]]) {
      await db.admin.query(`insert into public.media_assets
        (id,workspace_id,relative_path,storage_provider,storage_access,is_public,public_token,size_bytes)
        values($1,$2,$3,'vercel-blob',$4,$5,null,877)`, [id, workspace, `SYNTHETIC/${id}.pdf`, access, access === "public"]);
    }
    await db.admin.query(`insert into public.knowledge_source_versions(id,workspace_id,media_asset_id)
      values($1,$2,$3),($4,$2,$5)`, [randomUUID(), a, paired, randomUUID(), mismatch]);
    // Execute the exact exported SQL used by privateAssetInventory itself.
    // Casting legacy text to UUID instead would fail on the third private row.
    const rows = (await db.admin.query(package4HostedPrivateAssetInventorySql)).rows;
    assert.equal(rows.length, 3);
    const inventory = new Map(rows.map(row => [row.id, row]));
    await t.test("same asset and same tenant are covered", () => {
      assert.equal(inventory.get(paired)?.has_version, true);
      assert.equal(inventory.get(paired)?.workspace_id, a);
      assert.equal(inventory.get(paired)?.size_bytes, "877");
    });
    await t.test("same asset UUID from another tenant is not covered", () => {
      assert.equal(inventory.get(mismatch)?.has_version, false);
      assert.equal(inventory.get(mismatch)?.workspace_id, b);
    });
    await t.test("legacy non-UUID text remains readable and public assets stay excluded", () => {
      assert.equal(inventory.get(legacy)?.has_version, false);
      assert.equal(inventory.get(legacy)?.workspace_id, "SYNTHETIC-legacy-non-UUID-tenant");
      assert.equal(inventory.has(publicAsset), false);
    });
  } finally { await db.stop(); }
});
