#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  buildDatabaseRecoveryLiveEvidence,
  canonicalJson,
  sha256,
} from "./lib/database-recovery-live-evidence.mjs";
import { recoveryMigrationPlan } from "./recovery-migration-rehearsal.mjs";
import {
  recoveryBaselineMigrationPlan,
  recoveryQueryPackSha256,
} from "./lib/database-recovery-query-pack.mjs";

const maximumInputBytes = 8 * 1_024 * 1_024;

function fail(code) {
  throw new Error(code);
}

function parseArgs(argv) {
  const values = new Map();
  for (const argument of argv) {
    if (argument === "--execute") {
      values.set("execute", "1");
      continue;
    }
    const match = argument.match(
      /^--(confirm-candidate|evidence-dir|trusted-observer-public-key)=(.+)$/u,
    );
    if (!match) fail("RECOVERY_LIVE_EVIDENCE_ARGUMENT_INVALID");
    if (values.has(match[1])) fail("RECOVERY_LIVE_EVIDENCE_ARGUMENT_DUPLICATE");
    values.set(match[1], match[2].trim());
  }
  if (!values.has("execute")) fail("RECOVERY_LIVE_EVIDENCE_EXECUTE_REQUIRED");
  if (!/^[a-f0-9]{40}$/u.test(values.get("confirm-candidate") ?? "")) {
    fail("RECOVERY_LIVE_EVIDENCE_CANDIDATE_CONFIRMATION_INVALID");
  }
  return values;
}

function outsideDirectory(parent, target) {
  const targetRelative = relative(parent, target);
  return targetRelative !== ""
    && (targetRelative === ".." || targetRelative.startsWith(`..${sep}`));
}

function sameResolvedPath(left, right) {
  const normalize = (value) => {
    const normalized = resolve(value).replace(/^\\\\\?\\/u, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

async function assertNoFilesystemReparsePath(value, code) {
  const target = resolve(value);
  const anchor = parse(target).root;
  const segments = relative(anchor, target).split(sep).filter(Boolean);
  let current = anchor;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const component = await lstat(current);
    if (component.isSymbolicLink()) fail(code);
    if (index < segments.length - 1 && !component.isDirectory()) fail(code);
  }
  const realTarget = await realpath(target);
  if (!sameResolvedPath(realTarget, target)) fail(code);
}

export async function loadExternalRecoveryTrustAnchor({
  environment = process.env,
  publicKeyPath,
  repositoryRoot,
}) {
  if (!publicKeyPath || !isAbsolute(publicKeyPath)) {
    fail("RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_PATH_REQUIRED");
  }
  const resolvedPath = resolve(publicKeyPath);
  if (!outsideDirectory(resolve(repositoryRoot), resolvedPath)) {
    fail("RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_MUST_BE_OUTSIDE_REPOSITORY");
  }
  await Promise.all([
    assertNoFilesystemReparsePath(
      repositoryRoot,
      "RECOVERY_EXTERNAL_TRUST_REPOSITORY_PATH_REPARSE",
    ),
    assertNoFilesystemReparsePath(
      resolvedPath,
      "RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_PATH_REPARSE",
    ),
  ]);
  const before = await lstat(resolvedPath);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size < 1
    || before.size > 64 * 1_024
  ) {
    fail("RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_FILE_INVALID");
  }
  const [realRepositoryRoot, realPublicKeyPath] = await Promise.all([
    realpath(repositoryRoot),
    realpath(resolvedPath),
  ]);
  if (!outsideDirectory(realRepositoryRoot, realPublicKeyPath)) {
    fail("RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_REALPATH_INVALID");
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(resolvedPath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.size !== before.size
      || (before.dev !== undefined && opened.dev !== before.dev)
      || (before.ino !== undefined && opened.ino !== before.ino)
    ) {
      fail("RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_FILE_CHANGED");
    }
    const publicKey = await handle.readFile();
    await assertNoFilesystemReparsePath(
      resolvedPath,
      "RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_PATH_REPARSE",
    );
    const after = await lstat(resolvedPath);
    if (
      !after.isFile()
      || after.size !== opened.size
      || (opened.dev !== undefined && after.dev !== opened.dev)
      || (opened.ino !== undefined && after.ino !== opened.ino)
    ) {
      fail("RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_FILE_CHANGED");
    }
    return Object.freeze({
      expectedKeyId: environment.NOVALURE_RECOVERY_OBSERVER_KEY_ID ?? "",
      expectedPublicKeySha256:
        environment.NOVALURE_RECOVERY_OBSERVER_PUBLIC_KEY_SHA256 ?? "",
      expectedSignerIdentity:
        environment.NOVALURE_RECOVERY_OBSERVER_IDENTITY ?? "",
      publicKey,
    });
  } finally {
    await handle?.close();
  }
}

function gitOutput(args, { encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) fail("RECOVERY_LIVE_EVIDENCE_GIT_VERIFICATION_FAILED");
  return encoding ? result.stdout.trim() : result.stdout;
}

function requireCleanCandidate(expectedCandidateCommit) {
  const status = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) fail("RECOVERY_LIVE_EVIDENCE_DIRTY_CANDIDATE");
  const head = gitOutput(["rev-parse", "HEAD"]);
  if (head !== expectedCandidateCommit) fail("RECOVERY_LIVE_EVIDENCE_HEAD_MISMATCH");
  return head;
}

async function requireEvidenceDirectory(value, repositoryRoot) {
  if (!value || !isAbsolute(value)) fail("RECOVERY_LIVE_EVIDENCE_DIRECTORY_INVALID");
  const directory = resolve(value);
  const repositoryRelative = relative(repositoryRoot, directory);
  if (
    repositoryRelative === ""
    || (repositoryRelative !== ".." && !repositoryRelative.startsWith(`..${sep}`))
  ) {
    fail("RECOVERY_LIVE_EVIDENCE_DIRECTORY_INSIDE_CANDIDATE");
  }
  await mkdir(directory, { recursive: true });
  await Promise.all([
    assertNoFilesystemReparsePath(
      repositoryRoot,
      "RECOVERY_LIVE_EVIDENCE_REPOSITORY_PATH_REPARSE",
    ),
    assertNoFilesystemReparsePath(
      directory,
      "RECOVERY_LIVE_EVIDENCE_DIRECTORY_PATH_REPARSE",
    ),
  ]);
  const [realRepositoryRoot, realDirectory] = await Promise.all([
    realpath(repositoryRoot),
    realpath(directory),
  ]);
  const realRelative = relative(realRepositoryRoot, realDirectory);
  if (realRelative === "" || (realRelative !== ".." && !realRelative.startsWith(`..${sep}`))) {
    fail("RECOVERY_LIVE_EVIDENCE_DIRECTORY_REALPATH_INSIDE_CANDIDATE");
  }
  return realDirectory;
}

function normalizeSql(content) {
  return content.replace(/\r\n/gu, "\n");
}

export async function collectCommittedMigrationPlan() {
  const plan = [];
  for (const version of recoveryMigrationPlan) {
    const path = `migrations/${version}.sql`;
    const worktreeSource = await readFile(path, "utf8");
    const headSource = gitOutput(["show", `HEAD:${path}`], { encoding: null });
    const normalizedWorktree = normalizeSql(worktreeSource);
    const normalizedHead = normalizeSql(headSource.toString("utf8"));
    if (normalizedWorktree !== normalizedHead) {
      fail("RECOVERY_LIVE_EVIDENCE_MIGRATION_NOT_COMMITTED");
    }
    plan.push({ checksum: sha256(normalizedHead), version });
  }
  return plan;
}

export async function verifyCommittedBaselineAndQueryPack() {
  for (const migration of recoveryBaselineMigrationPlan) {
    const path = `migrations/${migration.version}.sql`;
    const headSource = gitOutput(["show", `HEAD:${path}`], { encoding: null });
    if (sha256(normalizeSql(headSource.toString("utf8"))) !== migration.checksum) {
      fail("RECOVERY_LIVE_EVIDENCE_BASELINE_MIGRATION_DRIFT");
    }
  }
  const queryPackPath = "scripts/lib/database-recovery-query-pack.mjs";
  const worktreeSource = normalizeSql(await readFile(queryPackPath, "utf8"));
  const headSource = normalizeSql(
    gitOutput(["show", `HEAD:${queryPackPath}`], { encoding: null }).toString("utf8"),
  );
  if (worktreeSource !== headSource) fail("RECOVERY_LIVE_EVIDENCE_QUERY_PACK_NOT_COMMITTED");
  if (!/^[a-f0-9]{64}$/u.test(recoveryQueryPackSha256)) {
    fail("RECOVERY_LIVE_EVIDENCE_QUERY_PACK_DIGEST_INVALID");
  }
}

export async function readRecoveryEvidenceInputFromStdin(input = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > maximumInputBytes) fail("RECOVERY_LIVE_EVIDENCE_INPUT_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  if (size === 0) fail("RECOVERY_LIVE_EVIDENCE_INPUT_MISSING");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("RECOVERY_LIVE_EVIDENCE_INPUT_JSON_INVALID");
  }
}

export async function writeImmutableRecoveryEvidence({ directory, evidence }) {
  const serialized = canonicalJson(evidence);
  const digest = sha256(serialized);
  const stamp = evidence.generatedAt.replace(/[:.]/gu, "-");
  const shortCandidate = evidence.candidateCommit.slice(0, 12);
  const fileName = `database-recovery-live-evidence-${shortCandidate}-${stamp}.json`;
  const resolvedDirectory = resolve(directory);
  await mkdir(resolvedDirectory, { recursive: true });
  await assertNoFilesystemReparsePath(
    resolvedDirectory,
    "RECOVERY_LIVE_EVIDENCE_DIRECTORY_PATH_REPARSE",
  );
  const evidencePath = join(resolvedDirectory, fileName);
  const sidecarPath = join(resolvedDirectory, `${fileName}.sha256`);
  await writeFile(evidencePath, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    sidecarPath,
    `${digest}  ${basename(fileName)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  await Promise.all([
    assertNoFilesystemReparsePath(
      evidencePath,
      "RECOVERY_LIVE_EVIDENCE_FILE_PATH_REPARSE",
    ),
    assertNoFilesystemReparsePath(
      sidecarPath,
      "RECOVERY_LIVE_EVIDENCE_SIDECAR_PATH_REPARSE",
    ),
  ]);
  const [evidenceStat, sidecarStat] = await Promise.all([
    lstat(evidencePath),
    lstat(sidecarPath),
  ]);
  if (
    !evidenceStat.isFile()
    || evidenceStat.isSymbolicLink()
    || evidenceStat.nlink !== 1
    || !sidecarStat.isFile()
    || sidecarStat.isSymbolicLink()
    || sidecarStat.nlink !== 1
  ) {
    fail("RECOVERY_LIVE_EVIDENCE_WRITTEN_FILE_INVALID");
  }
  return Object.freeze({ digest, fileName });
}

export async function databaseRecoveryLiveEvidenceMain(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const expectedCandidateCommit = args.get("confirm-candidate");
  const repositoryRoot = gitOutput(["rev-parse", "--show-toplevel"]);
  if (resolve(process.cwd()) !== resolve(repositoryRoot)) {
    fail("RECOVERY_LIVE_EVIDENCE_REPOSITORY_ROOT_REQUIRED");
  }
  requireCleanCandidate(expectedCandidateCommit);
  const evidenceDirectory = await requireEvidenceDirectory(args.get("evidence-dir"), repositoryRoot);
  const trustAnchor = args.has("trusted-observer-public-key")
    ? await loadExternalRecoveryTrustAnchor({
      publicKeyPath: args.get("trusted-observer-public-key"),
      repositoryRoot,
    })
    : null;
  const [input, migrationPlan] = await Promise.all([
    readRecoveryEvidenceInputFromStdin(),
    collectCommittedMigrationPlan(),
    verifyCommittedBaselineAndQueryPack(),
  ]);
  requireCleanCandidate(expectedCandidateCommit);
  const evidence = buildDatabaseRecoveryLiveEvidence({
    expectedCandidateCommit,
    input,
    migrationPlan,
    trustAnchor,
  });
  requireCleanCandidate(expectedCandidateCommit);
  const written = await writeImmutableRecoveryEvidence({
    directory: evidenceDirectory,
    evidence,
  });
  requireCleanCandidate(expectedCandidateCommit);
  console.log(JSON.stringify({
    candidateCommit: expectedCandidateCommit,
    evidenceDigest: written.digest,
    evidenceFile: written.fileName,
    passEligible: evidence.passEligible,
    status: evidence.status,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await databaseRecoveryLiveEvidenceMain();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const errorCode = /^RECOVERY_[A-Z0-9_]+$/u.test(message)
      ? message
      : "RECOVERY_LIVE_EVIDENCE_FAILED";
    console.error(JSON.stringify({ errorCode, ok: false }));
    process.exitCode = 1;
  }
}
