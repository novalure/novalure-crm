#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { neon } from "@neondatabase/serverless";
import { assertConnectedDatabaseTarget } from "./lib/infra-targets.mjs";

const confirmation = "RUN_PUBLIC_RATE_LIMIT_LIVE_DRILL";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; live QA is fail-closed.`);
  return value;
}

async function readConnectionUrl() {
  if (process.env.NOVALURE_QA_DATABASE_URL?.trim()) {
    return process.env.NOVALURE_QA_DATABASE_URL.trim();
  }
  if (!process.argv.includes("--connection-stdin")) {
    throw new Error("NOVALURE_QA_DATABASE_URL or --connection-stdin is required.");
  }

  const rawModeEnabled = Boolean(process.stdin.isTTY && process.stdin.setRawMode);
  if (rawModeEnabled) process.stdin.setRawMode(true);
  const value = await new Promise((resolve, reject) => {
    const onError = (error) => {
      if (rawModeEnabled) process.stdin.setRawMode(false);
      reject(error);
    };
    process.stdin.once("error", onError);
    process.stdin.once("data", (chunk) => {
      process.stdin.off("error", onError);
      if (rawModeEnabled) process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(String(chunk).trim());
    });
    process.stdin.resume();
  });
  if (!value) throw new Error("The QA connection URL was not received.");
  return value;
}

function opaqueKey(runId, label) {
  return createHash("sha256").update(`${runId}\0${label}`).digest("hex");
}

async function loadRateLimitSql() {
  const source = await readFile(
    new URL("../src/lib/db/public-submission-abuse-repository.ts", import.meta.url),
    "utf8",
  );
  const functionStart = source.indexOf(
    "export async function consumePublicSubmissionRateLimits",
  );
  assert.ok(functionStart >= 0, "rate-limit repository function is missing");
  const functionSource = source.slice(functionStart);
  const match = functionSource.match(
    /const row = await transaction\.queryOne<RateLimitRow>\(\s*`([\s\S]*?)`,\s*\[/u,
  );
  assert.ok(match?.[1], "rate-limit SQL could not be extracted");
  return match[1];
}

function policies(keys, limits) {
  return keys
    .map((keyHash, index) => ({
      keyHash,
      limit: limits[index],
      windowSeconds: 600,
    }))
    .sort((left, right) => left.keyHash.localeCompare(right.keyHash));
}

function advisoryLockKeys(requestedPolicies) {
  const upperBound = 1n << 63n;
  const modulus = 1n << 64n;
  return requestedPolicies
    .map((policy) => {
      const unsigned = BigInt(`0x${policy.keyHash.slice(0, 16)}`);
      return unsigned >= upperBound ? unsigned - modulus : unsigned;
    })
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map(String);
}

async function main() {
  if (process.env.NOVALURE_QA_RATE_LIMIT_LIVE_CONFIRM !== confirmation) {
    throw new Error(
      `NOVALURE_QA_RATE_LIMIT_LIVE_CONFIRM=${confirmation} is required.`,
    );
  }

  const databaseUrl = await readConnectionUrl();
  const parsedUrl = new URL(databaseUrl);
  const targetEnv = {
    ...process.env,
    NOVALURE_QA_DATABASE_HOST: parsedUrl.hostname,
    NOVALURE_QA_DATABASE_NAME: parsedUrl.pathname.replace(/^\//u, ""),
    NOVALURE_QA_DATABASE_ROLE: decodeURIComponent(parsedUrl.username),
    NOVALURE_QA_PROJECT_ID: required("NOVALURE_QA_PROJECT_ID"),
    NOVALURE_QA_BRANCH_ID: required("NOVALURE_QA_BRANCH_ID"),
  };
  const database = neon(databaseUrl);
  const targetClient = {
    async query({ text }) {
      return { rows: await database.query(text) };
    },
  };
  const runId = randomUUID();
  const everyKey = [];

  try {
    await assertConnectedDatabaseTarget({
      client: targetClient,
      connectionMode: "pooled",
      env: targetEnv,
      minimumServerVersionNum: 150000,
      purpose: "public submission rate-limit live drill",
      target: "test",
    });

    const sql = await loadRateLimitSql();
    const consume = async (requestedPolicies, holdMilliseconds = 0) => {
      const params = [
        requestedPolicies.map((policy) => policy.keyHash),
        requestedPolicies.map((policy) => policy.limit),
        requestedPolicies.map((policy) => policy.windowSeconds),
      ];
      const results = await database.transaction((transaction) => [
        ...advisoryLockKeys(requestedPolicies).map((lockKey) =>
          transaction.query("select pg_advisory_xact_lock($1::bigint)", [lockKey])
        ),
        ...(holdMilliseconds > 0
          ? [transaction.query("select pg_sleep($1::numeric / 1000)", [holdMilliseconds])]
          : []),
        transaction.query(sql, params),
      ]);
      const rows = results.at(-1);
      return rows?.[0]?.allowed === true;
    };
    const counts = async (keys) => {
      const rows = await database.query(
        `
          select key_hash as "keyHash", request_count as "requestCount"
          from public_submission_rate_limits
          where key_hash = any($1::text[])
        `,
        [keys],
      );
      return new Map(
        rows.map((row) => [row.keyHash, Number(row.requestCount)]),
      );
    };

    const ipLimited = opaqueKey(runId, "ip-limited");
    const identifierFirst = opaqueKey(runId, "identifier-first");
    const identifierBlocked = opaqueKey(runId, "identifier-blocked");
    const sharedScope = opaqueKey(runId, "shared-scope");
    everyKey.push(ipLimited, identifierFirst, identifierBlocked, sharedScope);
    assert.equal(
      await consume(policies([ipLimited, identifierFirst, sharedScope], [1, 10, 10])),
      true,
    );
    assert.equal(
      await consume(policies([ipLimited, identifierBlocked, sharedScope], [1, 10, 10])),
      false,
    );
    let observed = await counts(everyKey);
    assert.equal(observed.get(ipLimited), 1);
    assert.equal(observed.get(identifierFirst), 1);
    assert.equal(observed.get(sharedScope), 1);
    assert.equal(observed.has(identifierBlocked), false);

    const scopeLimited = opaqueKey(runId, "scope-limited");
    const firstIp = opaqueKey(runId, "first-ip");
    const firstIdentifier = opaqueKey(runId, "first-identifier");
    const blockedIp = opaqueKey(runId, "blocked-ip");
    const blockedIdentifier = opaqueKey(runId, "blocked-identifier");
    everyKey.push(scopeLimited, firstIp, firstIdentifier, blockedIp, blockedIdentifier);
    assert.equal(
      await consume(policies([firstIp, firstIdentifier, scopeLimited], [10, 10, 1])),
      true,
    );
    assert.equal(
      await consume(policies([blockedIp, blockedIdentifier, scopeLimited], [10, 10, 1])),
      false,
    );
    observed = await counts([scopeLimited, firstIp, firstIdentifier, blockedIp, blockedIdentifier]);
    assert.equal(observed.get(scopeLimited), 1);
    assert.equal(observed.get(firstIp), 1);
    assert.equal(observed.get(firstIdentifier), 1);
    assert.equal(observed.has(blockedIp), false);
    assert.equal(observed.has(blockedIdentifier), false);

    const overlapLimited = opaqueKey(runId, "overlap-limited");
    const overlapSeedIdentifier = opaqueKey(runId, "overlap-seed-identifier");
    const overlapBlockedIdentifier = opaqueKey(runId, "overlap-blocked-identifier");
    const overlapScope = opaqueKey(runId, "overlap-scope");
    everyKey.push(
      overlapLimited,
      overlapSeedIdentifier,
      overlapBlockedIdentifier,
      overlapScope,
    );
    const heldWinner = consume(
      policies([overlapLimited, overlapSeedIdentifier, overlapScope], [1, 10, 10]),
      500,
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    const waitingLoser = consume(
      policies([overlapLimited, overlapBlockedIdentifier, overlapScope], [1, 10, 10]),
    );
    assert.deepEqual(await Promise.all([heldWinner, waitingLoser]), [true, false]);
    observed = await counts([
      overlapLimited,
      overlapSeedIdentifier,
      overlapBlockedIdentifier,
      overlapScope,
    ]);
    assert.equal(observed.get(overlapLimited), 1);
    assert.equal(observed.get(overlapSeedIdentifier), 1);
    assert.equal(observed.get(overlapScope), 1);
    assert.equal(observed.has(overlapBlockedIdentifier), false);

    const concurrentKeys = [
      opaqueKey(runId, "parallel-ip"),
      opaqueKey(runId, "parallel-identifier"),
      opaqueKey(runId, "parallel-scope"),
    ];
    everyKey.push(...concurrentKeys);
    const concurrentPolicies = policies(concurrentKeys, [5, 5, 5]);
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => consume(concurrentPolicies)),
    );
    assert.equal(decisions.filter(Boolean).length, 5);
    observed = await counts(concurrentKeys);
    assert.deepEqual(
      concurrentKeys.map((key) => observed.get(key)),
      [5, 5, 5],
    );

    console.log(
      JSON.stringify({
        concurrentAllowed: 5,
        exhaustedIpCounterWrites: 0,
        exhaustedScopeCounterWrites: 0,
        overlappingSnapshotCounterWrites: 0,
        result: "pass",
      }),
    );
  } finally {
    try {
      if (everyKey.length) {
        await database.query(
          "delete from public_submission_rate_limits where key_hash = any($1::text[])",
          [everyKey],
        );
      }
    } catch (cleanupError) {
      console.error("Rate-limit live drill cleanup failed.");
      throw cleanupError;
    }
  }
}

await main();
