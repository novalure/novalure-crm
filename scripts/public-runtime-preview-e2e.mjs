#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  PublicRuntimePreviewError,
  assertPublicRuntimeEvidenceSafe,
  canonicalJson,
  executePublicRuntimePreview,
  parsePublicRuntimeActionInput,
} from "./lib/public-runtime-preview-e2e.mjs";

function usage() {
  return [
    "Final-SHA-bound Preview public Form/Funnel gate",
    "",
    "  --execute --input-stdin",
    "",
    "Action-time database/session/share values are accepted only in bounded stdin JSON.",
    "The runner creates and publishes QA-only Form/Funnel fixtures, proves long-session proof",
    "refresh, exactly-once submissions, token rotation, tenant isolation and exact batch reset.",
  ].join("\n");
}

function validateArgs(argv) {
  const allowed = new Set(["--execute", "--help", "-h", "--input-stdin"]);
  if (argv.some((argument) => !allowed.has(argument))) throw new PublicRuntimePreviewError("ARGUMENT_INVALID");
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  if (argv.length !== 2 || !argv.includes("--execute") || !argv.includes("--input-stdin")) {
    throw new PublicRuntimePreviewError("EXECUTION_CONFIRMATION_REQUIRED");
  }
  return "execute";
}

async function readBoundedStdin(maximumBytes = 32_768) {
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new PublicRuntimePreviewError("ACTION_INPUT_TOO_LARGE");
  }
  return value;
}

function safeEvidenceDirectory(env, candidateSha = "") {
  const configured = env.NOVALURE_QA_PUBLIC_RUNTIME_EVIDENCE_DIR?.trim();
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  const candidate = /^[a-f0-9]{40}$/u.test(candidateSha) ? candidateSha.slice(0, 12) : "failed";
  const run = `${candidate}-${timestamp}-${randomBytes(4).toString("hex")}`;
  const target = path.resolve(configured || path.join("artifacts", "qa", "public-runtime-preview", run));
  const relative = path.relative(process.cwd(), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PublicRuntimePreviewError("EVIDENCE_DIRECTORY_INVALID");
  }
  return target;
}

export async function writePublicRuntimeEvidence(evidence, directory) {
  assertPublicRuntimeEvidenceSafe(evidence);
  await mkdir(directory, { recursive: true });
  const fileName = "public-runtime-preview-evidence.json";
  const finalPath = path.join(directory, fileName);
  const sidecarPath = `${finalPath}.sha256`;
  const temporaryPath = path.join(directory, `.${fileName}.${process.pid}.tmp`);
  const temporarySidecarPath = `${sidecarPath}.${process.pid}.tmp`;
  const content = canonicalJson(evidence);
  const digest = createHash("sha256").update(content).digest("hex");
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await writeFile(temporarySidecarPath, `${digest}  ${fileName}\n`, { encoding: "utf8", flag: "wx" });
    await copyFile(temporaryPath, finalPath, fileConstants.COPYFILE_EXCL);
    try {
      await copyFile(temporarySidecarPath, sidecarPath, fileConstants.COPYFILE_EXCL);
    } catch (error) {
      await rm(finalPath, { force: true });
      throw error;
    }
    const persisted = await readFile(finalPath, "utf8");
    if (createHash("sha256").update(persisted).digest("hex") !== digest) {
      await Promise.all([rm(finalPath, { force: true }), rm(sidecarPath, { force: true })]);
      throw new PublicRuntimePreviewError("EVIDENCE_DIGEST_MISMATCH");
    }
    return { digest, finalPath, sidecarPath };
  } finally {
    await Promise.all([rm(temporaryPath, { force: true }), rm(temporarySidecarPath, { force: true })]);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const mode = validateArgs(argv);
  if (mode === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  let directory = null;
  try {
    const input = parsePublicRuntimeActionInput(await readBoundedStdin());
    directory = safeEvidenceDirectory(env, input.expectedGitSha);
    const evidence = await executePublicRuntimePreview({ env, input });
    const written = await writePublicRuntimeEvidence(evidence, directory);
    process.stdout.write(`[public-runtime-preview] http=${evidence.httpReadOnlyStatus} release=${evidence.releaseGateStatus} evidence=${path.relative(process.cwd(), written.finalPath)} digest=${written.digest}\n`);
    return evidence.releaseGateStatus === "BLOCKED" ? 2 : 0;
  } catch (error) {
    const code = error instanceof PublicRuntimePreviewError ? error.code : "UNEXPECTED_FAILURE";
    const evidence = {
      cleanup: { databaseCleanup: "UNPROVEN", status: "PARTIAL" },
      completedAt: new Date().toISOString(),
      databaseAttestation: { status: code === "DATABASE_WRITE_OBSERVED" ? "FAIL" : "UNPROVEN" },
      failureCode: code,
      httpReadOnlyStatus: "FAIL",
      mutationGate: { reasonCode: "RUN_FAILED_BEFORE_MUTATION_GATE", status: "BLOCKED" },
      releaseGateStatus: "BLOCKED",
      schemaVersion: 1,
    };
    try {
      directory ??= safeEvidenceDirectory(env);
      const written = await writePublicRuntimeEvidence(evidence, directory);
      process.stderr.write(`[public-runtime-preview] status=FAIL code=${code} evidence=${path.relative(process.cwd(), written.finalPath)} digest=${written.digest}\n`);
    } catch {
      process.stderr.write(`[public-runtime-preview] status=FAIL code=${code} evidence=WRITE_FAILED\n`);
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
