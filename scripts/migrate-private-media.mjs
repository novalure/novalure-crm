#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { Pool } from "@neondatabase/serverless";
import { del, get, put } from "@vercel/blob";

const targets = {
  test: { envFile: ".env.local", hostPrefix: "ep-morning-fog-al1enszq", projectSuffix: "98273025" },
  prod: { envFile: ".env.production.local", hostPrefix: "ep-wandering-union-alem0781", projectSuffix: "70835427" },
};

function fail(message) {
  throw new Error(message);
}

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function resolveTarget() {
  const name = process.env.MIGRATION_TARGET;
  if (!name || !(name in targets)) fail("MIGRATION_TARGET must be test or prod");
  const target = targets[name];
  loadEnvFile(join(process.cwd(), target.envFile));
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  const projectId = process.env.POSTGRES_NEON_PROJECT_ID || process.env.NEON_PROJECT_ID || "";
  const legacyToken = process.env.LEGACY_PUBLIC_BLOB_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN || "";
  const privateToken = process.env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN || process.env.PRIVATE_BLOB_READ_WRITE_TOKEN || "";
  if (!databaseUrl || !legacyToken || !privateToken) fail("Database, legacy-public Blob and dedicated private Blob credentials are required");
  if (legacyToken === privateToken) fail("Legacy-public and private Blob stores must use separate credentials");
  const parsed = new URL(databaseUrl.replace(/^['"]|['"]$/g, ""));
  if (!parsed.hostname.startsWith(target.hostPrefix) || !projectId.endsWith(target.projectSuffix)) {
    fail(`Target safety check failed for ${name}`);
  }
  return { apply: process.argv.includes("--apply"), databaseUrl: parsed.toString(), legacyToken, name, privateToken };
}

function verifiedMediaMime(buffer) {
  const bytes = new Uint8Array(buffer);
  const ascii = (start, length) => Buffer.from(bytes.subarray(start, start + length)).toString("ascii");
  const starts = (signature) => signature.every((value, index) => bytes[index] === value);
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (["ftypavif", "ftypavis"].includes(ascii(4, 8))) return "image/avif";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "application/msword";
  if (starts([0x50, 0x4b, 0x03, 0x04])) {
    const archiveText = Buffer.from(bytes).toString("latin1");
    if (archiveText.includes("[Content_Types].xml") && archiveText.includes("word/")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
  }
  return null;
}

async function readBlobBytes(locator, access, token) {
  const blob = await get(locator, { access, token, useCache: false });
  if (!blob?.stream) return null;
  return Buffer.from(await new Response(blob.stream).arrayBuffer());
}

function safePrivatePath(row) {
  const fileName = String(row.relativePath).split("/").filter(Boolean).pop() || `${row.id}.bin`;
  return `private-migrated/${row.id}/${fileName.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
}

async function verifyLegacyDeletion(locator, legacyToken) {
  if (/^https:\/\//i.test(locator)) {
    const response = await fetch(locator, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return response.status === 404 || response.status === 410;
  }
  return (await get(locator, { access: "public", token: legacyToken, useCache: false })) === null;
}

const target = resolveTarget();
const pool = new Pool({ connectionString: target.databaseUrl });
const client = await pool.connect();

try {
  const result = await client.query(
    `
      select asset.id, asset.relative_path as "relativePath", asset.mime_type as "mimeType",
             asset.size_bytes as "sizeBytes", asset.sha256,
             asset.scan_status as "scanStatus", asset.storage_access as "storageAccess",
             coalesce(legacy_blob_url, blob_url, url) as "legacyLocator",
             manifest.private_path as "manifestPrivatePath", manifest.sha256 as "manifestSha256"
      from media_assets asset
      left join media_private_migration_manifest manifest on manifest.asset_id = asset.id
      where asset.storage_provider = 'vercel-blob'
        and (asset.storage_access = 'legacy_public' or asset.legacy_blob_url is not null)
      order by asset.created_at asc
      limit 500
    `,
  );
  const migrationCount = result.rows.filter((row) => row.storageAccess === "legacy_public").length;
  const cleanupCount = result.rows.length - migrationCount;
  console.log(`Target: ${target.name}; migrate: ${migrationCount}; cleanup: ${cleanupCount}; mode: ${target.apply ? "apply" : "dry-run"}`);

  if (target.apply) {
    let migrated = 0;
    let cleaned = 0;
    for (const row of result.rows) {
      try {
        let privatePath = row.manifestPrivatePath || row.relativePath;
        let sha256 = row.manifestSha256 || row.sha256;

        if (row.storageAccess === "legacy_public") {
          const bytes = await readBlobBytes(row.legacyLocator, "public", target.legacyToken);
          if (!bytes) fail(`Legacy blob missing for asset ${row.id}`);
          if (bytes.length !== Number(row.sizeBytes)) fail(`Legacy size mismatch for asset ${row.id}`);
          const detectedMime = verifiedMediaMime(bytes);
          if (detectedMime !== row.mimeType) fail(`Legacy signature mismatch for asset ${row.id}`);
          sha256 = createHash("sha256").update(bytes).digest("hex");
          const uploaded = await put(safePrivatePath(row), bytes, {
            access: "private",
            addRandomSuffix: false,
            contentType: row.mimeType,
            token: target.privateToken,
          });
          privatePath = uploaded.pathname;

          const privateBytes = await readBlobBytes(privatePath, "private", target.privateToken);
          if (!privateBytes || privateBytes.length !== bytes.length) fail(`Private size verification failed for asset ${row.id}`);
          if (createHash("sha256").update(privateBytes).digest("hex") !== sha256) {
            fail(`Private checksum verification failed for asset ${row.id}`);
          }

          const scanStatus = row.mimeType.startsWith("image/") ? "clean" : "pending";
          await client.query("begin");
          try {
            const switched = await client.query(
              `update media_assets set relative_path = $2, blob_url = $2, sha256 = $3,
                 scan_status = $4, storage_access = 'private', url = '/api/media/files/' || id::text,
                 legacy_blob_url = $5, migrated_at = now(), updated_at = now()
               where id = $1 and storage_access = 'legacy_public'`,
              [row.id, privatePath, sha256, scanStatus, row.legacyLocator],
            );
            if (switched.rowCount !== 1) fail(`Concurrent migration detected for asset ${row.id}`);
            await client.query(
              `insert into media_private_migration_manifest (
                 asset_id, legacy_locator_hash, private_path, size_bytes, sha256, status, switched_at, updated_at
               ) values ($1, $2, $3, $4, $5, 'cleanup_pending', now(), now())
               on conflict (asset_id) do update set private_path = excluded.private_path,
                 size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
                 status = 'cleanup_pending', switched_at = now(), last_error = null, updated_at = now()`,
              [row.id, createHash("sha256").update(row.legacyLocator).digest("hex"), privatePath, bytes.length, sha256],
            );
            await client.query("commit");
            migrated += 1;
          } catch (error) {
            await client.query("rollback");
            throw error;
          }
        } else {
          const privateBytes = await readBlobBytes(privatePath, "private", target.privateToken);
          if (!privateBytes || privateBytes.length !== Number(row.sizeBytes)) fail(`Private copy unavailable for asset ${row.id}`);
          if (sha256 && createHash("sha256").update(privateBytes).digest("hex") !== sha256) {
            fail(`Private copy checksum mismatch for asset ${row.id}`);
          }
        }

        await del(row.legacyLocator, { token: target.legacyToken });
        if (!(await verifyLegacyDeletion(row.legacyLocator, target.legacyToken))) {
          fail(`Legacy blob remains anonymously accessible for asset ${row.id}`);
        }
        await client.query("begin");
        try {
          await client.query(
            `update media_assets set legacy_blob_url = null, updated_at = now()
             where id = $1 and storage_access = 'private' and relative_path = $2`,
            [row.id, privatePath],
          );
          await client.query(
            `update media_private_migration_manifest set status = 'completed', legacy_deleted_at = now(),
               last_error = null, updated_at = now() where asset_id = $1`,
            [row.id],
          );
          await client.query("commit");
          cleaned += 1;
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      } catch (error) {
        await client.query(
          `update media_private_migration_manifest set status = case when switched_at is null then 'failed' else 'cleanup_pending' end,
             last_error = $2, updated_at = now() where asset_id = $1`,
          [row.id, error instanceof Error ? error.message.slice(0, 500) : "Migration failed"],
        ).catch(() => undefined);
        console.error(`Asset ${row.id}: migration failed`);
        process.exitCode = 1;
      }
    }
    console.log(`Migrated assets: ${migrated}; verified legacy deletions: ${cleaned}`);
  }
} finally {
  client.release();
  await pool.end();
}
