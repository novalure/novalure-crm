#!/usr/bin/env node

import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Pool } from "@neondatabase/serverless";
import { del, get, list, put } from "@vercel/blob";
import {
  createFileCutoverJournal,
  LegacyBlobCutoverError,
  resolvePreviewCutoverConfig,
  resolveSafeJournalPath,
  runLegacyBlobCutover,
} from "./lib/legacy-blob-cutover.mjs";
import {
  assertConnectedDatabaseTarget,
  assertDatabaseTarget,
} from "./lib/infra-targets.mjs";

const advisoryLockKey = 2_608_230_404;
const queryTimeoutMs = 15_000;

function parseValueArgument(argument, name) {
  return argument.startsWith(`${name}=`) ? argument.slice(name.length + 1).trim() : null;
}

export function parseLegacyBlobCutoverArgs(argv) {
  const parsed = {
    confirmation: "",
    deleteDelayHours: undefined,
    execute: false,
    journal: "",
    limit: undefined,
    maximumBlobBytes: undefined,
    mode: "plan",
    notBefore: "",
    runId: "",
  };
  const recognized = new Set();
  for (const argument of argv) {
    if (argument === "--execute") {
      parsed.execute = true;
      recognized.add(argument);
      continue;
    }
    const definitions = [
      ["--confirm-finalize", "confirmation"],
      ["--delete-delay-hours", "deleteDelayHours"],
      ["--journal", "journal"],
      ["--limit", "limit"],
      ["--maximum-blob-bytes", "maximumBlobBytes"],
      ["--mode", "mode"],
      ["--not-before", "notBefore"],
      ["--run-id", "runId"],
    ];
    for (const [flag, key] of definitions) {
      const value = parseValueArgument(argument, flag);
      if (value === null) continue;
      parsed[key] = value;
      recognized.add(argument);
      break;
    }
  }
  const unknown = argv.filter((argument) => !recognized.has(argument));
  if (unknown.length) {
    throw new LegacyBlobCutoverError("ARGUMENT_INVALID", "An unknown cutover argument was rejected.");
  }
  return parsed;
}

async function readStreamWithLimit(stream, maximumBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("cutover-size-limit");
        throw new LegacyBlobCutoverError("BLOB_SIZE_LIMIT_EXCEEDED", "A Blob exceeded the cutover read limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readSdkBlob(pathname, { access, maximumBytes, token }) {
  const result = await get(pathname, {
    abortSignal: AbortSignal.timeout(30_000),
    access,
    token,
    useCache: false,
  });
  if (!result || result.statusCode !== 200) return null;
  const body = await readStreamWithLimit(result.stream, maximumBytes);
  return {
    body,
    contentType: result.blob.contentType,
    pathname: result.blob.pathname,
    sizeBytes: result.blob.size,
  };
}

function publicSourceObjectUrl(storeId, pathname) {
  const encodedPath = pathname.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `https://${storeId}.public.blob.vercel-storage.com/${encodedPath}`;
}

export function createVercelBlobCutoverAdapter(config, { fetchImpl = globalThis.fetch } = {}) {
  return Object.freeze({
    async deleteDestination(pathname) {
      await del(pathname, { token: config.destinationToken });
    },
    async deleteSource(pathname) {
      await del(pathname, { token: config.sourceToken });
    },
    async putDestination(pathname, body, { contentType, maximumBlobBytes }) {
      const result = await put(pathname, body, {
        abortSignal: AbortSignal.timeout(60_000),
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType,
        maximumSizeInBytes: maximumBlobBytes,
        token: config.destinationToken,
      });
      return { pathname: result.pathname };
    },
    async listSourceObjects(maximumObjects) {
      if (!Number.isSafeInteger(maximumObjects) || maximumObjects < 1 || maximumObjects > 1_001) {
        throw new LegacyBlobCutoverError("BLOB_LIST_LIMIT_INVALID", "The source Blob list limit is invalid.");
      }
      const pathnames = [];
      let cursor;
      for (let page = 0; page < 1_001 && pathnames.length < maximumObjects; page += 1) {
        const result = await list({
          cursor,
          limit: Math.min(1_000, maximumObjects - pathnames.length),
          token: config.sourceToken,
        });
        if (!result || !Array.isArray(result.blobs)) {
          throw new LegacyBlobCutoverError("SOURCE_LIST_INVALID", "The source Blob store returned an invalid listing.");
        }
        for (const blob of result.blobs) {
          const pathname = String(blob?.pathname ?? "");
          if (!pathname || pathname.includes("\0") || pathname.startsWith("/") || pathname.includes("../")) {
            throw new LegacyBlobCutoverError("SOURCE_LIST_PATH_INVALID", "The source Blob listing contained an invalid pathname.");
          }
          pathnames.push(pathname);
          if (pathnames.length >= maximumObjects) break;
        }
        if (!result.hasMore) return pathnames;
        if (typeof result.cursor !== "string" || !result.cursor || result.cursor === cursor) {
          throw new LegacyBlobCutoverError("SOURCE_LIST_CURSOR_INVALID", "The source Blob listing cursor is invalid.");
        }
        cursor = result.cursor;
      }
      return pathnames;
    },
    async readDestination(pathname, maximumBytes) {
      return readSdkBlob(pathname, {
        access: "private",
        maximumBytes,
        token: config.destinationToken,
      });
    },
    async readSource(pathname, maximumBytes) {
      return readSdkBlob(pathname, {
        access: "public",
        maximumBytes,
        token: config.sourceToken,
      });
    },
    async readSourcePublic(pathname) {
      if (typeof fetchImpl !== "function") {
        throw new LegacyBlobCutoverError("PUBLIC_READ_ADAPTER_MISSING", "The public source read adapter is unavailable.");
      }
      const response = await fetchImpl(publicSourceObjectUrl(config.sourceStoreId, pathname), {
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/octet-stream" },
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      return { status: response.status };
    },
  });
}

function normalizeMediaRow(row) {
  return {
    id: String(row.id),
    isPublic: row.isPublic === true,
    mimeType: String(row.mimeType || "application/octet-stream"),
    relativePath: String(row.relativePath || ""),
    sizeBytes: Number(row.sizeBytes),
    storageAccess: String(row.storageAccess || ""),
    storageProvider: String(row.storageProvider || ""),
    workspaceId: String(row.workspaceId || ""),
  };
}

function connectedIdentityFingerprint(identity) {
  return createHash("sha256")
    .update(
      [identity.projectId, identity.branchId, identity.databaseName, identity.roleName].join("\0"),
    )
    .digest("hex");
}

async function readCurrentMediaState(client, asset) {
  const current = await client.query({
    query_timeout: queryTimeoutMs,
    text: `
      select
        is_public as "isPublic",
        relative_path as "relativePath",
        size_bytes::text as "sizeBytes",
        storage_access as "storageAccess",
        storage_provider as "storageProvider"
      from public.media_assets
      where id = $1::uuid and workspace_id = $2
    `,
    values: [asset.id, asset.workspaceId],
  });
  return current.rows[0] ?? null;
}

function isPrivateDestinationState(row, destination) {
  return (
    row?.isPublic === false &&
    row?.storageAccess === "private" &&
    row?.storageProvider === "vercel-blob" &&
    row?.relativePath === destination.destinationPath &&
    Number(row?.sizeBytes) === destination.sizeBytes
  );
}

export function createPreviewDatabaseCutoverAdapter({ client, config, env = process.env }) {
  let lockAcquired = false;
  let connectedIdentity = null;
  return Object.freeze({
    async acquireCutoverLock() {
      if (lockAcquired) {
        throw new LegacyBlobCutoverError("CUTOVER_LOCK_STATE_INVALID", "The cutover lock is already held.");
      }
      const result = await client.query({
        query_timeout: queryTimeoutMs,
        text: 'select pg_try_advisory_lock($1::bigint) as "acquired"',
        values: [advisoryLockKey],
      });
      if (result.rows[0]?.acquired !== true) {
        throw new LegacyBlobCutoverError("CUTOVER_LOCK_UNAVAILABLE", "Another legacy Blob cutover holds the target lock.");
      }
      lockAcquired = true;
    },
    async compareAndSwapLegacyAsset(asset, destination) {
      await client.query("begin");
      try {
        await client.query({ query_timeout: queryTimeoutMs, text: "set local lock_timeout = '5s'" });
        await client.query({ query_timeout: queryTimeoutMs, text: "set local statement_timeout = '15s'" });
        const updated = await client.query({
          query_timeout: queryTimeoutMs,
          text: `
            update public.media_assets
            set storage_access = 'private',
                storage_provider = 'vercel-blob',
                relative_path = $5,
                url = '/api/media/files/' || id::text
            where id = $1::uuid
              and workspace_id = $2
              and storage_provider = 'vercel-blob'
              and storage_access = 'legacy-public'
              and is_public = false
              and relative_path = $3
              and size_bytes = $4::bigint
            returning id
          `,
          values: [asset.id, asset.workspaceId, asset.relativePath, destination.sizeBytes, destination.destinationPath],
        });
        if (updated.rowCount === 1) {
          await client.query("commit");
          return { updated: true };
        }
        const row = await readCurrentMediaState(client, asset);
        const alreadyApplied = isPrivateDestinationState(row, destination);
        await client.query("commit");
        return { alreadyApplied, updated: false };
      } catch (error) {
        let rollbackSucceeded = true;
        try {
          await client.query("rollback");
        } catch {
          rollbackSucceeded = false;
        }
        try {
          const row = await readCurrentMediaState(client, asset);
          if (isPrivateDestinationState(row, destination)) {
            return { alreadyApplied: true, updated: false };
          }
          if (rollbackSucceeded) throw error;
        } catch (inspectionError) {
          if (inspectionError === error && rollbackSucceeded) throw error;
        }
        throw new LegacyBlobCutoverError(
          "DATABASE_CAS_INDETERMINATE",
          "The CAS outcome could not be reconciled; the private destination was retained.",
          { cause: error },
        );
      }
    },
    async listLegacyAssets(limit) {
      const result = await client.query({
        query_timeout: queryTimeoutMs,
        text: `
          select
            id::text as id,
            is_public as "isPublic",
            mime_type as "mimeType",
            relative_path as "relativePath",
            size_bytes::text as "sizeBytes",
            storage_access as "storageAccess",
            storage_provider as "storageProvider",
            workspace_id::text as "workspaceId"
          from public.media_assets
          where storage_access = 'legacy-public'
            and storage_provider = 'vercel-blob'
          order by created_at, id
          limit $1
        `,
        values: [limit],
      });
      return result.rows.map(normalizeMediaRow);
    },
    async listPrivateAssets(assetKeys, limit) {
      if (!assetKeys.length) return [];
      const result = await client.query({
        query_timeout: queryTimeoutMs,
        text: `
          select
            id::text as id,
            is_public as "isPublic",
            mime_type as "mimeType",
            relative_path as "relativePath",
            size_bytes::text as "sizeBytes",
            storage_access as "storageAccess",
            storage_provider as "storageProvider",
            workspace_id::text as "workspaceId"
          from public.media_assets
          where storage_access = 'private'
            and storage_provider = 'vercel-blob'
            and encode(
              digest(
                convert_to('legacy-blob-asset:v1' || chr(0) || workspace_id::text || chr(0) || id::text, 'UTF8'),
                'sha256'
              ),
              'hex'
            ) = any($1::text[])
          order by created_at, id
          limit $2
        `,
        values: [assetKeys, limit],
      });
      return result.rows.map(normalizeMediaRow);
    },
    async releaseCutoverLock() {
      if (!lockAcquired) return;
      const result = await client.query({
        query_timeout: queryTimeoutMs,
        text: 'select pg_advisory_unlock($1::bigint) as "released"',
        values: [advisoryLockKey],
      });
      lockAcquired = false;
      if (result.rows[0]?.released !== true) {
        throw new LegacyBlobCutoverError("CUTOVER_LOCK_RELEASE_FAILED", "The cutover lock could not be released cleanly.");
      }
    },
    async verifyPreviewTarget() {
      if (connectedIdentity) return connectedIdentity;
      assertDatabaseTarget({
        connectionMode: "pooled",
        databaseUrl: config.databaseUrl,
        env,
        projectId: env.POSTGRES_NEON_PROJECT_ID || env.NEON_PROJECT_ID || env.NOVALURE_QA_PROJECT_ID,
        purpose: "isolated Preview legacy Blob cutover",
        target: "test",
      });
      const identity = await assertConnectedDatabaseTarget({
        client,
        connectionMode: "pooled",
        env,
        purpose: "isolated Preview legacy Blob cutover",
        target: "test",
      });
      await client.query({ query_timeout: queryTimeoutMs, text: "set search_path = public" });
      const searchPath = await client.query({
        query_timeout: queryTimeoutMs,
        text: `select current_schema() as "currentSchema", current_setting('search_path') as "searchPath"`,
      });
      if (searchPath.rows[0]?.currentSchema !== "public" || searchPath.rows[0]?.searchPath !== "public") {
        throw new LegacyBlobCutoverError("DATABASE_SEARCH_PATH_INVALID", "The Preview database search path is not public.");
      }
      connectedIdentity = Object.freeze({
        branchId: identity.branchId,
        databaseName: identity.databaseName,
        fingerprint: `sha256:${connectedIdentityFingerprint(identity).slice(0, 20)}`,
        projectId: identity.projectId,
        roleName: identity.roleName,
      });
      return connectedIdentity;
    },
  });
}

export async function legacyBlobCutoverMain(argv = process.argv.slice(2), env = process.env) {
  const args = parseLegacyBlobCutoverArgs(argv);
  const config = resolvePreviewCutoverConfig({ args, env });
  const journalPath = resolveSafeJournalPath({
    projectRoot: process.cwd(),
    requestedPath: args.journal,
    runId: config.runId,
  });
  const pool = new Pool({
    allowExitOnIdle: true,
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: 60_000,
    max: 1,
    query_timeout: queryTimeoutMs,
  });
  const client = await pool.connect();
  try {
    const result = await runLegacyBlobCutover({
      blob: config.execute ? createVercelBlobCutoverAdapter(config) : null,
      config,
      database: createPreviewDatabaseCutoverAdapter({ client, config, env }),
      journal: createFileCutoverJournal(journalPath),
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await legacyBlobCutoverMain();
  } catch (error) {
    const errorCode = error instanceof LegacyBlobCutoverError ? error.code : "UNEXPECTED_FAILURE";
    console.error(JSON.stringify({ errorCode, ok: false }));
    process.exitCode = 1;
  }
}
