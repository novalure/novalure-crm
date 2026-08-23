#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  ProviderFailClosedRunnerError,
  assertEvidenceIsRedacted,
  canonicalJson,
  executeProviderFailClosedPreview,
  parseProviderFailClosedInput,
} from "./lib/provider-fail-closed-preview.mjs";

function usage() {
  return [
    "Preview provider fail-closed HTTP gate",
    "",
    "  --execute --input-stdin",
    "",
    "Action-time JSON is read only from bounded stdin. URLs, session cookies and share tokens are never accepted as arguments, evidence or logs.",
    "A technical HTTP PASS remains release BLOCKED while independent provider-log or DB postconditions are UNPROVEN.",
  ].join("\n");
}

function validateArgs(argv) {
  const allowed = new Set(["--execute", "--help", "-h", "--input-stdin"]);
  if (argv.some((argument) => !allowed.has(argument))) throw new ProviderFailClosedRunnerError("ARGUMENT_INVALID");
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  if (!argv.includes("--execute") || !argv.includes("--input-stdin") || argv.length !== 2) {
    throw new ProviderFailClosedRunnerError("EXECUTION_CONFIRMATION_REQUIRED");
  }
  return "execute";
}

async function readBoundedStdin(maximumBytes = 16_384) {
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new ProviderFailClosedRunnerError("ACTION_INPUT_TOO_LARGE");
  }
  return value;
}

function safeEvidenceDirectory(env, candidateLabel = "failed") {
  const configured = env.NOVALURE_QA_PROVIDER_EVIDENCE_DIR?.trim();
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  const safeCandidate = /^[a-f0-9]{40}$/u.test(candidateLabel) ? candidateLabel.slice(0, 12) : "failed";
  const runDirectory = `${safeCandidate}-${timestamp}-${randomBytes(4).toString("hex")}`;
  const target = path.resolve(configured || path.join("artifacts", "qa", "provider-fail-closed-preview", runDirectory));
  const relative = path.relative(process.cwd(), target);
  if (relative.startsWith("..") || path.isAbsolute(relative) || target === process.cwd()) {
    throw new ProviderFailClosedRunnerError("EVIDENCE_DIRECTORY_INVALID");
  }
  return target;
}

export async function writeProviderFailClosedEvidence(evidence, directory) {
  assertEvidenceIsRedacted(evidence);
  await mkdir(directory, { recursive: true });
  const fileName = "provider-fail-closed-evidence.json";
  const finalPath = path.join(directory, fileName);
  const temporaryPath = path.join(directory, `.${fileName}.${process.pid}.tmp`);
  const sidecarPath = `${finalPath}.sha256`;
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
      throw new ProviderFailClosedRunnerError("EVIDENCE_DIGEST_MISMATCH");
    }
    return { digest, finalPath, sidecarPath };
  } finally {
    await Promise.all([
      rm(temporaryPath, { force: true }),
      rm(temporarySidecarPath, { force: true }),
    ]);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const mode = validateArgs(argv);
  if (mode === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  let evidenceDirectory = null;
  try {
    const input = parseProviderFailClosedInput(await readBoundedStdin());
    evidenceDirectory = safeEvidenceDirectory(env, input.expectedGitSha);
    const evidence = await executeProviderFailClosedPreview({ env, input });
    const written = await writeProviderFailClosedEvidence(evidence, evidenceDirectory);
    process.stdout.write(`[provider-fail-closed] http=${evidence.httpTechnicalStatus} release=${evidence.releaseGateStatus} evidence=${path.relative(process.cwd(), written.finalPath)} digest=${written.digest}\n`);
    return evidence.releaseGateStatus === "BLOCKED" ? 2 : 0;
  } catch (error) {
    const code = error instanceof ProviderFailClosedRunnerError ? error.code : "UNEXPECTED_FAILURE";
    const failureEvidence = {
      cleanup: {
        databaseCleanup: "UNPROVEN",
        externalSessionCreatedByRunner: false,
        sensitiveInputPersistence: "NONE",
        status: "PARTIAL",
      },
      completedAt: new Date().toISOString(),
      databaseWritePostcondition: {
        reasonCode: code === "DATABASE_WRITE_OBSERVED" ? code : "RUN_FAILED_BEFORE_POSTCONDITION",
        status: code === "DATABASE_WRITE_OBSERVED" ? "FAIL" : "UNPROVEN",
      },
      failureCode: code,
      httpTechnicalStatus: "FAIL",
      providerSideEffectPostcondition: {
        independentProviderLogs: "UNPROVEN",
        reasonCode: "RUN_FAILED_BEFORE_POSTCONDITION",
      },
      releaseGateStatus: "BLOCKED",
      schemaVersion: 1,
    };
    try {
      evidenceDirectory ??= safeEvidenceDirectory(env);
      const written = await writeProviderFailClosedEvidence(failureEvidence, evidenceDirectory);
      process.stderr.write(`[provider-fail-closed] status=FAIL code=${code} evidence=${path.relative(process.cwd(), written.finalPath)} digest=${written.digest}\n`);
    } catch {
      process.stderr.write(`[provider-fail-closed] status=FAIL code=${code} evidence=WRITE_FAILED\n`);
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
