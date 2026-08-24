import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  assertExactObjectKeys,
  canonicalJson,
  requireIsoTimestamp,
  requireSafeText,
  requireSha256,
  sha256,
  validateExternalGateRuntimeBinding,
  verifyExternalGateReceipt,
} from "./external-gate-receipts.mjs";

export const protectedWorkflowProvenanceRole = "github-actions-attestor";
export const protectedWorkflowProvenanceRecordType =
  "NOVALURE_GITHUB_ARTIFACT_ATTESTATION_RECEIPT";
export const protectedWorkflowArtifactManifestRecordType =
  "NOVALURE_PROTECTED_WORKFLOW_ARTIFACT_MANIFEST";
export const twoTenantParentBaseArtifactFile = "two-tenant-parent-base.json";
export const protectedWorkflowEvidenceFiles = Object.freeze([
  "execute-two-tenant-e2e.json",
  "execute-two-tenant-e2e.sha256",
  "preflight-two-tenant-e2e.json",
  "preflight-two-tenant-e2e.sha256",
  twoTenantParentBaseArtifactFile,
]);

export const githubArtifactAttestationAction =
  "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6";
export const githubArtifactAttestationCliVersion = "2.97.0";
export const githubArtifactAttestationOidcIssuer =
  "https://token.actions.githubusercontent.com";
export const githubArtifactAttestationPredicateType =
  "https://slsa.dev/provenance/v1";

export const githubArtifactAttestationCliPins = Object.freeze({
  "linux-x64": Object.freeze({
    executableSha256: "141507c337e8b202ad398550c3b73d72f5af92e86f71665214538a81efd4c409",
  }),
  "win32-x64": Object.freeze({
    executableSha256: "e2efa10a5d2ce93cac9bc4b676932b62947c0967c01c8f2c3a9cb4437ad358d3",
  }),
});

const inTotoStatementType = "https://in-toto.io/Statement/v1";
const verificationResultMediaType =
  "application/vnd.dev.sigstore.verificationresult+json;version=0.1";
const maximumArtifactBytes = 64 * 1024 * 1024;
const maximumBundleBytes = 16 * 1024 * 1024;
const maximumCliBytes = 128 * 1024 * 1024;
const maximumTrustedRootBytes = 4 * 1024 * 1024;
const maximumVerifierOutputBytes = 32 * 1024 * 1024;
const tarBlockBytes = 512;
const tarEndMarkerBytes = tarBlockBytes * 2;
const cryptographicallyVerifiedAttestations = new WeakSet();

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function validateArtifactName(value) {
  return requireSafeText(value, "PROTECTED_WORKFLOW_ARTIFACT_NAME_INVALID", {
    maximumLength: 180,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{7,179}$/u,
  });
}

function validateArtifactManifest(manifest, expectedArtifactDigest, {
  expectedEvidenceFiles = protectedWorkflowEvidenceFiles,
  expectedRecordType = protectedWorkflowArtifactManifestRecordType,
} = {}) {
  assertExactObjectKeys(manifest, [
    "artifactDigest",
    "artifactName",
    "files",
    "recordType",
    "schemaVersion",
  ], "PROTECTED_WORKFLOW_ARTIFACT_MANIFEST");
  invariant(manifest.schemaVersion === 1, "PROTECTED_WORKFLOW_ARTIFACT_MANIFEST_SCHEMA_INVALID");
  invariant(
    manifest.recordType === expectedRecordType,
    "PROTECTED_WORKFLOW_ARTIFACT_MANIFEST_TYPE_INVALID",
  );
  validateArtifactName(manifest.artifactName);
  requireSha256(manifest.artifactDigest, "PROTECTED_WORKFLOW_ARTIFACT_DIGEST_INVALID");
  invariant(
    manifest.artifactDigest === expectedArtifactDigest,
    "PROTECTED_WORKFLOW_ARTIFACT_DIGEST_MISMATCH",
  );
  invariant(
    Array.isArray(manifest.files)
      && manifest.files.length === expectedEvidenceFiles.length,
    "PROTECTED_WORKFLOW_ARTIFACT_FILE_COUNT_INVALID",
  );
  const sortedFiles = [...manifest.files].sort((left, right) => left.name.localeCompare(right.name));
  invariant(
    sortedFiles.every((file, index) => file?.name === [...expectedEvidenceFiles].sort()[index]),
    "PROTECTED_WORKFLOW_ARTIFACT_FILE_INVENTORY_INVALID",
  );
  for (const file of sortedFiles) {
    assertExactObjectKeys(file, ["name", "sha256", "sizeBytes"], "PROTECTED_WORKFLOW_ARTIFACT_FILE");
    requireSha256(file.sha256, "PROTECTED_WORKFLOW_ARTIFACT_FILE_DIGEST_INVALID");
    invariant(
      Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0 && file.sizeBytes <= 16 * 1024 * 1024,
      "PROTECTED_WORKFLOW_ARTIFACT_FILE_SIZE_INVALID",
    );
  }
  return manifest;
}

function validateExpectedEvidenceFiles(expectedEvidenceFiles) {
  invariant(
    Array.isArray(expectedEvidenceFiles)
      && expectedEvidenceFiles.length > 0
      && expectedEvidenceFiles.length <= 32
      && new Set(expectedEvidenceFiles).size === expectedEvidenceFiles.length
      && expectedEvidenceFiles.every((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{1,179}$/u.test(name)),
    "PROTECTED_WORKFLOW_EXPECTED_EVIDENCE_FILES_INVALID",
  );
  return [...expectedEvidenceFiles].sort((left, right) => left.localeCompare(right));
}

function isZeroFilled(bytes) {
  return bytes.every((value) => value === 0);
}

function parseTarText(field, code) {
  const terminator = field.indexOf(0);
  const end = terminator === -1 ? field.length : terminator;
  invariant(
    terminator === -1 || isZeroFilled(field.subarray(terminator)),
    code,
  );
  const valueBytes = field.subarray(0, end);
  invariant(
    valueBytes.every((value) => value >= 0x20 && value <= 0x7e),
    code,
  );
  return valueBytes.toString("ascii");
}

function parseTarOctal(field, code) {
  invariant((field[0] & 0x80) === 0, code);
  const source = field.toString("ascii").replaceAll("\0", "").trim();
  invariant(/^[0-7]+$/u.test(source), code);
  const value = Number.parseInt(source, 8);
  invariant(Number.isSafeInteger(value) && value >= 0, code);
  return value;
}

function validateTarHeaderChecksum(header) {
  const recorded = parseTarOctal(
    header.subarray(148, 156),
    "PROTECTED_WORKFLOW_ARTIFACT_TAR_CHECKSUM_INVALID",
  );
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const actual = checksumHeader.reduce((sum, value) => sum + value, 0);
  invariant(actual === recorded, "PROTECTED_WORKFLOW_ARTIFACT_TAR_CHECKSUM_INVALID");
}

export function validateProtectedWorkflowArtifactTar({
  artifactBytes,
  artifactManifest,
  expectedEvidenceFiles = protectedWorkflowEvidenceFiles,
  expectedManifestRecordType = protectedWorkflowArtifactManifestRecordType,
}) {
  invariant(
    Buffer.isBuffer(artifactBytes)
      && artifactBytes.length >= tarEndMarkerBytes
      && artifactBytes.length <= maximumArtifactBytes
      && artifactBytes.length % tarBlockBytes === 0,
    "PROTECTED_WORKFLOW_ARTIFACT_TAR_SIZE_INVALID",
  );
  const expectedNames = validateExpectedEvidenceFiles(expectedEvidenceFiles);
  const artifactDigest = sha256(artifactBytes);
  validateArtifactManifest(artifactManifest, artifactDigest, {
    expectedEvidenceFiles: expectedNames,
    expectedRecordType: expectedManifestRecordType,
  });
  const manifestByName = new Map(artifactManifest.files.map((entry) => [entry.name, entry]));
  const observedNames = [];
  let offset = 0;
  let terminated = false;
  while (offset + tarBlockBytes <= artifactBytes.length) {
    const header = artifactBytes.subarray(offset, offset + tarBlockBytes);
    if (isZeroFilled(header)) {
      invariant(
        offset + tarEndMarkerBytes <= artifactBytes.length
          && isZeroFilled(artifactBytes.subarray(offset)),
        "PROTECTED_WORKFLOW_ARTIFACT_TAR_TERMINATOR_INVALID",
      );
      terminated = true;
      break;
    }
    validateTarHeaderChecksum(header);
    invariant(
      header.subarray(257, 263).equals(Buffer.from("ustar\0", "ascii"))
        && header.subarray(263, 265).equals(Buffer.from("00", "ascii")),
      "PROTECTED_WORKFLOW_ARTIFACT_TAR_FORMAT_INVALID",
    );
    const name = parseTarText(
      header.subarray(0, 100),
      "PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_NAME_INVALID",
    );
    const prefix = parseTarText(
      header.subarray(345, 500),
      "PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_NAME_INVALID",
    );
    invariant(
      prefix === "" && expectedNames.includes(name),
      "PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_INVENTORY_INVALID",
    );
    invariant(
      !observedNames.includes(name),
      "PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_DUPLICATED",
    );
    const typeFlag = header[156];
    invariant(
      (typeFlag === 0 || typeFlag === 0x30)
        && parseTarText(
          header.subarray(157, 257),
          "PROTECTED_WORKFLOW_ARTIFACT_TAR_LINK_NAME_INVALID",
        ) === "",
      "PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_TYPE_INVALID",
    );
    const sizeBytes = parseTarOctal(
      header.subarray(124, 136),
      "PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_SIZE_INVALID",
    );
    const manifestEntry = manifestByName.get(name);
    invariant(
      manifestEntry && sizeBytes === manifestEntry.sizeBytes,
      "PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_SIZE_MISMATCH",
    );
    const contentStart = offset + tarBlockBytes;
    const contentEnd = contentStart + sizeBytes;
    invariant(
      contentEnd <= artifactBytes.length - tarEndMarkerBytes,
      "PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_TRUNCATED",
    );
    const paddedContentEnd = Math.ceil(contentEnd / tarBlockBytes) * tarBlockBytes;
    invariant(
      paddedContentEnd <= artifactBytes.length - tarEndMarkerBytes
        && isZeroFilled(artifactBytes.subarray(contentEnd, paddedContentEnd)),
      "PROTECTED_WORKFLOW_ARTIFACT_TAR_PADDING_INVALID",
    );
    invariant(
      sha256(artifactBytes.subarray(contentStart, contentEnd)) === manifestEntry.sha256,
      "PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_DIGEST_MISMATCH",
    );
    observedNames.push(name);
    offset = paddedContentEnd;
  }
  invariant(terminated, "PROTECTED_WORKFLOW_ARTIFACT_TAR_TERMINATOR_INVALID");
  invariant(
    observedNames.length === expectedNames.length
      && observedNames.every((name, index) => name === expectedNames[index]),
    "PROTECTED_WORKFLOW_ARTIFACT_TAR_MEMBER_INVENTORY_INVALID",
  );
  return Object.freeze({
    artifactDigest,
    memberCount: observedNames.length,
    memberNames: Object.freeze(observedNames),
    status: "VERIFIED",
  });
}

function sameResolvedPath(left, right) {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink;
}

function readBoundedRegularFile(filePath, { code, maximumBytes }) {
  invariant(
    typeof filePath === "string" && path.isAbsolute(filePath),
    `${code}_ABSOLUTE_PATH_REQUIRED`,
  );
  const resolvedPath = path.resolve(filePath);
  let state;
  try {
    state = lstatSync(resolvedPath);
  } catch {
    invariant(false, `${code}_UNREADABLE`);
  }
  invariant(
    state.isFile()
      && !state.isSymbolicLink()
      && state.nlink === 1
      && state.size > 0
      && state.size <= maximumBytes,
    `${code}_NOT_BOUNDED_REGULAR_FILE`,
  );
  let realPath;
  try {
    realPath = realpathSync.native(resolvedPath);
  } catch {
    invariant(false, `${code}_UNREADABLE`);
  }
  invariant(sameResolvedPath(realPath, resolvedPath), `${code}_SYMLINK_PATH_REJECTED`);
  let descriptor;
  try {
    descriptor = openSync(
      realPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const openedState = fstatSync(descriptor);
    invariant(
      openedState.isFile()
        && openedState.nlink === 1
        && sameFilesystemIdentity(openedState, state)
        && openedState.size > 0
        && openedState.size <= maximumBytes,
      `${code}_FILE_CHANGED_DURING_READ`,
    );
    const bytes = readFileSync(descriptor);
    const afterState = fstatSync(descriptor);
    invariant(
      bytes.length === openedState.size
        && sameFilesystemIdentity(openedState, afterState)
        && openedState.mtimeMs === afterState.mtimeMs,
      `${code}_FILE_CHANGED_DURING_READ`,
    );
    return Object.freeze({
      bytes,
      identity: Object.freeze({
        dev: openedState.dev,
        ino: openedState.ino,
        nlink: openedState.nlink,
        size: openedState.size,
      }),
      path: realPath,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(code)) throw error;
    invariant(false, `${code}_UNREADABLE`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJsonBytes(bytes, code) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    invariant(false, `${code}_JSON_INVALID`);
  }
}

function validateJsonLines(bytes, code) {
  let source;
  try {
    source = bytes.toString("utf8");
  } catch {
    invariant(false, `${code}_UTF8_INVALID`);
  }
  const lines = source.split(/\r?\n/u).filter((line) => line.length > 0);
  invariant(lines.length >= 1 && lines.length <= 16, `${code}_JSONL_COUNT_INVALID`);
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      invariant(false, `${code}_JSONL_INVALID`);
    }
    invariant(entry && typeof entry === "object" && !Array.isArray(entry), `${code}_JSONL_OBJECT_REQUIRED`);
  }
}

function parseWorkflowIdentity(expectedWorkflowRef, expectedWorkflowSha) {
  invariant(/^[a-f0-9]{40}$/u.test(expectedWorkflowSha ?? ""), "PROTECTED_WORKFLOW_EXPECTED_SHA_INVALID");
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(\.github\/workflows\/livegang-e2e\.yml)@(refs\/heads\/main)$/u
    .exec(expectedWorkflowRef ?? "");
  invariant(match, "PROTECTED_WORKFLOW_EXPECTED_REF_INVALID");
  const [, repository, workflowPath, sourceRef] = match;
  const owner = repository.split("/")[0];
  return Object.freeze({
    certificateIdentity: `https://github.com/${expectedWorkflowRef}`,
    owner,
    ownerUri: `https://github.com/${owner}`,
    repository,
    sourceRef,
    sourceRepositoryUri: `https://github.com/${repository}`,
    workflowPath,
    workflowRef: expectedWorkflowRef,
    workflowSha: expectedWorkflowSha,
    workflowUri: `https://github.com/${expectedWorkflowRef}`,
  });
}

function parseRunInvocation(value, identity) {
  const escapedRepository = identity.repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `^https://github\\.com/${escapedRepository}/actions/runs/(\\d{6,20})/attempts/(\\d{1,4})$`,
    "u",
  ).exec(value ?? "");
  invariant(match, "PROTECTED_WORKFLOW_RUN_INVOCATION_INVALID");
  const runAttempt = Number(match[2]);
  invariant(
    Number.isSafeInteger(runAttempt) && runAttempt >= 1 && runAttempt <= 1_000,
    "PROTECTED_WORKFLOW_RUN_ATTEMPT_INVALID",
  );
  return Object.freeze({ runAttempt, runId: match[1] });
}

function validateVerifiedTimestamps(value) {
  invariant(
    Array.isArray(value) && value.length >= 1 && value.length <= 16,
    "PROTECTED_WORKFLOW_VERIFIED_TIMESTAMPS_INVALID",
  );
  const instants = [];
  for (const timestamp of value) {
    assertExactObjectKeys(timestamp, ["timestamp", "type", "uri"], "PROTECTED_WORKFLOW_VERIFIED_TIMESTAMP");
    invariant(
      timestamp.type === "Tlog" || timestamp.type === "TSA",
      "PROTECTED_WORKFLOW_VERIFIED_TIMESTAMP_TYPE_INVALID",
    );
    requireSafeText(timestamp.uri, "PROTECTED_WORKFLOW_VERIFIED_TIMESTAMP_URI_INVALID", {
      maximumLength: 1_024,
      pattern: /^[^\u0000-\u001f\u007f]+$/u,
    });
    const instant = Date.parse(timestamp.timestamp);
    invariant(Number.isFinite(instant), "PROTECTED_WORKFLOW_VERIFIED_TIMESTAMP_VALUE_INVALID");
    instants.push(instant);
  }
  return Object.freeze({
    attestedAt: new Date(Math.min(...instants)).toISOString(),
    count: value.length,
    sha256: sha256(canonicalJson(value)),
  });
}

function requireNumericIdentifier(value, code) {
  invariant(/^\d{1,30}$/u.test(value ?? ""), code);
  return value;
}

function validateCertificate(certificate, identity) {
  invariant(certificate && typeof certificate === "object", "PROTECTED_WORKFLOW_CERTIFICATE_REQUIRED");
  invariant(
    certificate.issuer === githubArtifactAttestationOidcIssuer,
    "PROTECTED_WORKFLOW_OIDC_ISSUER_INVALID",
  );
  invariant(
    certificate.subjectAlternativeName === identity.certificateIdentity,
    "PROTECTED_WORKFLOW_CERTIFICATE_SUBJECT_MISMATCH",
  );
  invariant(
    certificate.githubWorkflowTrigger === "workflow_dispatch"
      && certificate.buildTrigger === "workflow_dispatch",
    "PROTECTED_WORKFLOW_TRIGGER_INVALID",
  );
  invariant(
    certificate.githubWorkflowSHA === identity.workflowSha
      && certificate.buildSignerDigest === identity.workflowSha
      && certificate.buildConfigDigest === identity.workflowSha
      && certificate.sourceRepositoryDigest === identity.workflowSha,
    "PROTECTED_WORKFLOW_CERTIFICATE_SHA_MISMATCH",
  );
  invariant(
    certificate.githubWorkflowRepository === identity.repository,
    "PROTECTED_WORKFLOW_CERTIFICATE_REPOSITORY_MISMATCH",
  );
  invariant(
    certificate.githubWorkflowRef === identity.sourceRef
      && certificate.sourceRepositoryRef === identity.sourceRef,
    "PROTECTED_WORKFLOW_CERTIFICATE_REF_MISMATCH",
  );
  invariant(
    certificate.buildSignerURI === identity.workflowUri
      && certificate.buildConfigURI === identity.workflowUri,
    "PROTECTED_WORKFLOW_CERTIFICATE_WORKFLOW_URI_MISMATCH",
  );
  invariant(
    certificate.sourceRepositoryURI === identity.sourceRepositoryUri,
    "PROTECTED_WORKFLOW_SOURCE_REPOSITORY_URI_MISMATCH",
  );
  invariant(
    certificate.sourceRepositoryOwnerURI === identity.ownerUri,
    "PROTECTED_WORKFLOW_SOURCE_OWNER_URI_MISMATCH",
  );
  invariant(
    certificate.runnerEnvironment === "github-hosted",
    "PROTECTED_WORKFLOW_RUNNER_ENVIRONMENT_INVALID",
  );
  requireNumericIdentifier(
    certificate.sourceRepositoryIdentifier,
    "PROTECTED_WORKFLOW_SOURCE_REPOSITORY_IDENTIFIER_INVALID",
  );
  requireNumericIdentifier(
    certificate.sourceRepositoryOwnerIdentifier,
    "PROTECTED_WORKFLOW_SOURCE_OWNER_IDENTIFIER_INVALID",
  );
  invariant(
    ["public", "private", "internal"].includes(certificate.sourceRepositoryVisibilityAtSigning),
    "PROTECTED_WORKFLOW_SOURCE_VISIBILITY_INVALID",
  );
  const run = parseRunInvocation(certificate.runInvocationURI, identity);
  return Object.freeze({
    buildConfigDigest: certificate.buildConfigDigest,
    buildConfigUri: certificate.buildConfigURI,
    buildSignerDigest: certificate.buildSignerDigest,
    buildSignerUri: certificate.buildSignerURI,
    buildTrigger: certificate.buildTrigger,
    githubWorkflowRef: certificate.githubWorkflowRef,
    issuer: certificate.issuer,
    repository: certificate.githubWorkflowRepository,
    runAttempt: run.runAttempt,
    runId: run.runId,
    runInvocationUri: certificate.runInvocationURI,
    runnerEnvironment: certificate.runnerEnvironment,
    sourceRepositoryDigest: certificate.sourceRepositoryDigest,
    sourceRepositoryIdentifier: certificate.sourceRepositoryIdentifier,
    sourceRepositoryOwnerIdentifier: certificate.sourceRepositoryOwnerIdentifier,
    sourceRepositoryOwnerUri: certificate.sourceRepositoryOwnerURI,
    sourceRepositoryRef: certificate.sourceRepositoryRef,
    sourceRepositoryUri: certificate.sourceRepositoryURI,
    sourceRepositoryVisibilityAtSigning: certificate.sourceRepositoryVisibilityAtSigning,
    subjectAlternativeName: certificate.subjectAlternativeName,
    workflowReference: identity.workflowRef,
    workflowSha: certificate.githubWorkflowSHA,
    workflowTrigger: certificate.githubWorkflowTrigger,
  });
}

function validateCliPin(platform, executableSha256) {
  const pin = githubArtifactAttestationCliPins[platform];
  invariant(pin, "PROTECTED_WORKFLOW_GITHUB_CLI_PLATFORM_UNSUPPORTED");
  invariant(
    executableSha256 === pin.executableSha256,
    "PROTECTED_WORKFLOW_GITHUB_CLI_DIGEST_MISMATCH",
  );
  return pin;
}

export function validateVerifiedGitHubAttestationOutput({
  artifactDigest,
  artifactManifestSha256,
  artifactName,
  attestationBundle,
  attestationBundleSha256,
  expectedWorkflowRef,
  expectedWorkflowSha,
  githubCliPlatform,
  githubCliSha256,
  sigstoreTrustedRootSha256,
  verificationOutput,
}) {
  requireSha256(artifactDigest, "PROTECTED_WORKFLOW_ARTIFACT_DIGEST_INVALID");
  requireSha256(artifactManifestSha256, "PROTECTED_WORKFLOW_ARTIFACT_MANIFEST_DIGEST_INVALID");
  validateArtifactName(artifactName);
  requireSha256(attestationBundleSha256, "PROTECTED_WORKFLOW_ATTESTATION_BUNDLE_DIGEST_INVALID");
  requireSha256(githubCliSha256, "PROTECTED_WORKFLOW_GITHUB_CLI_DIGEST_INVALID");
  requireSha256(sigstoreTrustedRootSha256, "PROTECTED_WORKFLOW_SIGSTORE_ROOT_DIGEST_INVALID");
  validateCliPin(githubCliPlatform, githubCliSha256);
  const identity = parseWorkflowIdentity(expectedWorkflowRef, expectedWorkflowSha);
  invariant(
    Array.isArray(verificationOutput) && verificationOutput.length === 1,
    "PROTECTED_WORKFLOW_VERIFICATION_RESULT_COUNT_INVALID",
  );
  const entry = verificationOutput[0];
  assertExactObjectKeys(entry, ["attestation", "verificationResult"], "PROTECTED_WORKFLOW_VERIFICATION_ENTRY");
  invariant(
    entry.attestation?.bundle && typeof entry.attestation.bundle === "object",
    "PROTECTED_WORKFLOW_VERIFIED_BUNDLE_MISSING",
  );
  invariant(
    canonicalJson(entry.attestation.bundle) === canonicalJson(attestationBundle),
    "PROTECTED_WORKFLOW_VERIFIED_BUNDLE_MISMATCH",
  );
  const verificationResult = entry.verificationResult;
  invariant(
    verificationResult?.mediaType === verificationResultMediaType,
    "PROTECTED_WORKFLOW_VERIFICATION_MEDIA_TYPE_INVALID",
  );
  const statement = verificationResult.statement;
  invariant(statement?._type === inTotoStatementType, "PROTECTED_WORKFLOW_STATEMENT_TYPE_INVALID");
  invariant(
    statement.predicateType === githubArtifactAttestationPredicateType,
    "PROTECTED_WORKFLOW_PREDICATE_INVALID",
  );
  invariant(
    Array.isArray(statement.subject) && statement.subject.length === 1,
    "PROTECTED_WORKFLOW_ATTESTATION_SUBJECT_COUNT_INVALID",
  );
  const subject = statement.subject[0];
  assertExactObjectKeys(subject, ["digest", "name"], "PROTECTED_WORKFLOW_ATTESTATION_SUBJECT");
  assertExactObjectKeys(subject.digest, ["sha256"], "PROTECTED_WORKFLOW_ATTESTATION_SUBJECT_DIGEST");
  invariant(subject.name === artifactName, "PROTECTED_WORKFLOW_ATTESTATION_SUBJECT_NAME_MISMATCH");
  invariant(
    subject.digest.sha256 === artifactDigest,
    "PROTECTED_WORKFLOW_ATTESTATION_SUBJECT_DIGEST_MISMATCH",
  );
  const certificate = verificationResult.signature?.certificate;
  const github = validateCertificate(certificate, identity);
  invariant(
    verificationResult.verifiedIdentity?.subjectAlternativeName?.subjectAlternativeName
      === certificate.subjectAlternativeName
      && verificationResult.verifiedIdentity?.issuer?.issuer === certificate.issuer,
    "PROTECTED_WORKFLOW_VERIFIED_IDENTITY_MISMATCH",
  );
  const timestamps = validateVerifiedTimestamps(verificationResult.verifiedTimestamps);
  return Object.freeze({
    artifact: Object.freeze({
      artifactDigest,
      artifactName,
      attestationBundleSha256,
      manifestSha256: artifactManifestSha256,
      predicateType: statement.predicateType,
      statementSha256: sha256(canonicalJson(statement)),
    }),
    attestedAt: timestamps.attestedAt,
    github,
    verification: Object.freeze({
      certificateSha256: sha256(canonicalJson(certificate)),
      githubCliPlatform,
      githubCliSha256,
      githubCliVersion: githubArtifactAttestationCliVersion,
      sigstoreTrustedRootSha256,
      verificationResultSha256: sha256(canonicalJson(verificationOutput)),
      verifiedTimestampCount: timestamps.count,
      verifiedTimestampsSha256: timestamps.sha256,
    }),
  });
}

function sanitizedVerifierEnvironment() {
  const environment = { ...process.env };
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  delete environment.GH_ENTERPRISE_TOKEN;
  environment.GH_NO_UPDATE_NOTIFIER = "1";
  environment.GH_PROMPT_DISABLED = "1";
  return environment;
}

function validateExecutableSnapshotRoot(snapshot) {
  let state;
  let realPath;
  try {
    state = lstatSync(snapshot.rootPath);
    realPath = realpathSync.native(snapshot.rootPath);
  } catch {
    invariant(false, "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_ROOT_UNREADABLE");
  }
  invariant(
    state.isDirectory()
      && !state.isSymbolicLink()
      && state.dev === snapshot.rootIdentity.dev
      && state.ino === snapshot.rootIdentity.ino
      && sameResolvedPath(realPath, snapshot.rootPath),
    "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_ROOT_CHANGED",
  );
}

function validateExecutableSnapshot(snapshot) {
  validateExecutableSnapshotRoot(snapshot);
  const executable = readBoundedRegularFile(snapshot.executablePath, {
    code: "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT",
    maximumBytes: maximumCliBytes,
  });
  invariant(
    sameResolvedPath(executable.path, snapshot.executablePath)
      && sameFilesystemIdentity(executable.identity, snapshot.executableIdentity)
      && sha256(executable.bytes) === snapshot.executableSha256,
    "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_CHANGED",
  );
  for (const input of snapshot.inputs) {
    const file = readBoundedRegularFile(input.path, {
      code: "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_INPUT",
      maximumBytes: input.maximumBytes,
    });
    invariant(
      sameResolvedPath(file.path, input.path)
        && sameFilesystemIdentity(file.identity, input.identity)
        && sha256(file.bytes) === input.sha256,
      "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_INPUT_CHANGED",
    );
  }
  return executable;
}

function cleanupExecutableSnapshot(snapshot) {
  validateExecutableSnapshotRoot(snapshot);
  rmSync(snapshot.rootPath, { force: true, recursive: true });
}

export function withIdentityCheckedExecutableCopy({
  executableBytes,
  expectedSha256,
  inputFiles = [],
  operation,
}) {
  invariant(
    Buffer.isBuffer(executableBytes)
      && executableBytes.length > 0
      && executableBytes.length <= maximumCliBytes,
    "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_BYTES_INVALID",
  );
  requireSha256(expectedSha256, "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_DIGEST_INVALID");
  invariant(
    sha256(executableBytes) === expectedSha256,
    "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_DIGEST_MISMATCH",
  );
  invariant(
    Array.isArray(inputFiles) && inputFiles.length <= 8,
    "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_INPUTS_INVALID",
  );
  const normalizedInputs = inputFiles.map((input) => {
    invariant(
      input
        && typeof input === "object"
        && Buffer.isBuffer(input.bytes)
        && input.bytes.length > 0
        && Number.isSafeInteger(input.maximumBytes)
        && input.maximumBytes > 0
        && input.maximumBytes <= maximumArtifactBytes
        && input.bytes.length <= input.maximumBytes
        && /^[A-Za-z][A-Za-z0-9_-]{1,63}$/u.test(input.key ?? "")
        && /^[A-Za-z0-9][A-Za-z0-9._-]{1,179}$/u.test(input.name ?? ""),
      "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_INPUT_INVALID",
    );
    requireSha256(
      input.expectedSha256,
      "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_INPUT_DIGEST_INVALID",
    );
    invariant(
      sha256(input.bytes) === input.expectedSha256,
      "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_INPUT_DIGEST_MISMATCH",
    );
    return Object.freeze({
      bytes: input.bytes,
      key: input.key,
      maximumBytes: input.maximumBytes,
      name: input.name,
      sha256: input.expectedSha256,
    });
  });
  invariant(
    new Set(normalizedInputs.map((input) => input.key)).size === normalizedInputs.length
      && new Set(normalizedInputs.map((input) => input.name)).size === normalizedInputs.length,
    "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_INPUTS_DUPLICATED",
  );
  invariant(typeof operation === "function", "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_OPERATION_REQUIRED");
  const rootPath = realpathSync.native(mkdtempSync(path.join(tmpdir(), "novalure-gh-cli-")));
  chmodSync(rootPath, 0o700);
  const rootState = lstatSync(rootPath);
  invariant(
    rootState.isDirectory() && !rootState.isSymbolicLink(),
    "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_ROOT_INVALID",
  );
  const executableName = process.platform === "win32" ? "gh.exe" : "gh";
  invariant(
    normalizedInputs.every((input) => input.name !== executableName),
    "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_INPUT_NAME_COLLISION",
  );
  const executablePath = path.join(rootPath, executableName);
  let descriptor;
  let snapshot;
  try {
    descriptor = openSync(
      executablePath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o500,
    );
    writeFileSync(descriptor, executableBytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(executablePath, 0o500);
    const executable = readBoundedRegularFile(executablePath, {
      code: "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT",
      maximumBytes: maximumCliBytes,
    });
    invariant(
      sha256(executable.bytes) === expectedSha256,
      "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_DIGEST_MISMATCH",
    );
    const stagedInputs = [];
    for (const input of normalizedInputs) {
      const inputPath = path.join(rootPath, input.name);
      descriptor = openSync(
        inputPath,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0),
        0o400,
      );
      writeFileSync(descriptor, input.bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(inputPath, 0o400);
      const staged = readBoundedRegularFile(inputPath, {
        code: "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_INPUT",
        maximumBytes: input.maximumBytes,
      });
      invariant(
        sha256(staged.bytes) === input.sha256,
        "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_INPUT_DIGEST_MISMATCH",
      );
      stagedInputs.push(Object.freeze({
        identity: staged.identity,
        key: input.key,
        maximumBytes: input.maximumBytes,
        path: staged.path,
        sha256: input.sha256,
      }));
    }
    snapshot = Object.freeze({
      executableIdentity: executable.identity,
      executablePath: executable.path,
      executableSha256: expectedSha256,
      inputPaths: Object.freeze(Object.fromEntries(stagedInputs.map((input) => [input.key, input.path]))),
      inputs: Object.freeze(stagedInputs),
      rootIdentity: Object.freeze({ dev: rootState.dev, ino: rootState.ino }),
      rootPath,
    });
    validateExecutableSnapshot(snapshot);
    let result;
    let failure = null;
    try {
      result = operation(snapshot);
      invariant(
        !result || typeof result.then !== "function",
        "PROTECTED_WORKFLOW_GITHUB_CLI_SNAPSHOT_ASYNC_OPERATION_PROHIBITED",
      );
    } catch (error) {
      failure = error;
    }
    try {
      validateExecutableSnapshot(snapshot);
    } catch (error) {
      failure = error;
    }
    if (failure) throw failure;
    return result;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (snapshot) cleanupExecutableSnapshot(snapshot);
    else {
      const currentRoot = lstatSync(rootPath);
      if (
        currentRoot.isDirectory()
        && !currentRoot.isSymbolicLink()
        && currentRoot.dev === rootState.dev
        && currentRoot.ino === rootState.ino
      ) rmSync(rootPath, { force: true, recursive: true });
    }
  }
}

function executePinnedGitHubCli(executableSnapshot, args, code) {
  const executable = validateExecutableSnapshot(executableSnapshot);
  const result = spawnSync(executable.path, args, {
    encoding: "utf8",
    env: sanitizedVerifierEnvironment(),
    maxBuffer: maximumVerifierOutputBytes,
    shell: false,
    timeout: 120_000,
    windowsHide: true,
  });
  validateExecutableSnapshot(executableSnapshot);
  invariant(!result.error && result.status === 0 && result.signal === null, code);
  return result.stdout;
}

export function verifyGitHubArtifactAttestation({
  artifactManifest,
  artifactPath,
  attestationBundlePath,
  expectedEvidenceFiles = protectedWorkflowEvidenceFiles,
  expectedManifestRecordType = protectedWorkflowArtifactManifestRecordType,
  expectedSigstoreTrustedRootSha256,
  expectedWorkflowRef,
  expectedWorkflowSha,
  githubCliPath,
  sigstoreTrustedRootPath,
}) {
  const identity = parseWorkflowIdentity(expectedWorkflowRef, expectedWorkflowSha);
  validateExpectedEvidenceFiles(expectedEvidenceFiles);
  requireSafeText(
    expectedManifestRecordType,
    "PROTECTED_WORKFLOW_EXPECTED_MANIFEST_TYPE_INVALID",
    { maximumLength: 120, pattern: /^NOVALURE_[A-Z0-9_]{8,110}$/u },
  );
  validateArtifactManifest(artifactManifest, artifactManifest?.artifactDigest, {
    expectedEvidenceFiles,
    expectedRecordType: expectedManifestRecordType,
  });
  const artifact = readBoundedRegularFile(artifactPath, {
    code: "PROTECTED_WORKFLOW_ARTIFACT",
    maximumBytes: maximumArtifactBytes,
  });
  invariant(
    path.basename(artifact.path) === artifactManifest.artifactName,
    "PROTECTED_WORKFLOW_ARTIFACT_FILENAME_MISMATCH",
  );
  invariant(
    sha256(artifact.bytes) === artifactManifest.artifactDigest,
    "PROTECTED_WORKFLOW_ARTIFACT_BYTES_DIGEST_MISMATCH",
  );
  validateProtectedWorkflowArtifactTar({
    artifactBytes: artifact.bytes,
    artifactManifest,
    expectedEvidenceFiles,
    expectedManifestRecordType,
  });
  const bundle = readBoundedRegularFile(attestationBundlePath, {
    code: "PROTECTED_WORKFLOW_ATTESTATION_BUNDLE",
    maximumBytes: maximumBundleBytes,
  });
  const bundleDocument = parseJsonBytes(bundle.bytes, "PROTECTED_WORKFLOW_ATTESTATION_BUNDLE");
  invariant(
    bundleDocument && typeof bundleDocument === "object" && !Array.isArray(bundleDocument),
    "PROTECTED_WORKFLOW_ATTESTATION_BUNDLE_OBJECT_REQUIRED",
  );
  const trustedRoot = readBoundedRegularFile(sigstoreTrustedRootPath, {
    code: "PROTECTED_WORKFLOW_SIGSTORE_TRUSTED_ROOT",
    maximumBytes: maximumTrustedRootBytes,
  });
  requireSha256(
    expectedSigstoreTrustedRootSha256,
    "PROTECTED_WORKFLOW_SIGSTORE_ROOT_EXPECTED_DIGEST_REQUIRED",
  );
  invariant(
    sha256(trustedRoot.bytes) === expectedSigstoreTrustedRootSha256,
    "PROTECTED_WORKFLOW_SIGSTORE_ROOT_DIGEST_MISMATCH",
  );
  validateJsonLines(trustedRoot.bytes, "PROTECTED_WORKFLOW_SIGSTORE_TRUSTED_ROOT");
  const githubCli = readBoundedRegularFile(githubCliPath, {
    code: "PROTECTED_WORKFLOW_GITHUB_CLI",
    maximumBytes: maximumCliBytes,
  });
  const githubCliPlatform = `${process.platform}-${process.arch}`;
  const githubCliSha256 = sha256(githubCli.bytes);
  validateCliPin(githubCliPlatform, githubCliSha256);
  const output = withIdentityCheckedExecutableCopy({
    executableBytes: githubCli.bytes,
    expectedSha256: githubCliSha256,
    inputFiles: [
      {
        bytes: artifact.bytes,
        expectedSha256: artifactManifest.artifactDigest,
        key: "artifact",
        maximumBytes: maximumArtifactBytes,
        name: artifactManifest.artifactName,
      },
      {
        bytes: bundle.bytes,
        expectedSha256: sha256(bundle.bytes),
        key: "bundle",
        maximumBytes: maximumBundleBytes,
        name: "attestation-bundle.json",
      },
      {
        bytes: trustedRoot.bytes,
        expectedSha256: expectedSigstoreTrustedRootSha256,
        key: "trustedRoot",
        maximumBytes: maximumTrustedRootBytes,
        name: "sigstore-trusted-root.jsonl",
      },
    ],
    operation(executableSnapshot) {
      const versionOutput = executePinnedGitHubCli(
        executableSnapshot,
        ["version"],
        "PROTECTED_WORKFLOW_GITHUB_CLI_VERSION_EXECUTION_FAILED",
      );
      invariant(
        new RegExp(`^gh version ${githubArtifactAttestationCliVersion.replaceAll(".", "\\.")} \\(`, "u")
          .test(versionOutput),
        "PROTECTED_WORKFLOW_GITHUB_CLI_VERSION_MISMATCH",
      );
      return executePinnedGitHubCli(executableSnapshot, [
        "attestation",
        "verify",
        executableSnapshot.inputPaths.artifact,
        "--bundle",
        executableSnapshot.inputPaths.bundle,
        "--custom-trusted-root",
        executableSnapshot.inputPaths.trustedRoot,
        "--repo",
        identity.repository,
        "--signer-repo",
        identity.repository,
        "--signer-workflow",
        `github.com/${identity.repository}/${identity.workflowPath}`,
        "--signer-digest",
        identity.workflowSha,
        "--source-digest",
        identity.workflowSha,
        "--source-ref",
        identity.sourceRef,
        "--cert-identity",
        identity.certificateIdentity,
        "--cert-oidc-issuer",
        githubArtifactAttestationOidcIssuer,
        "--deny-self-hosted-runners",
        "--no-public-good",
        "--predicate-type",
        githubArtifactAttestationPredicateType,
        "--format",
        "json",
      ], "PROTECTED_WORKFLOW_ATTESTATION_CRYPTOGRAPHIC_VERIFICATION_FAILED");
    },
  });
  let verificationOutput;
  try {
    verificationOutput = JSON.parse(output);
  } catch {
    invariant(false, "PROTECTED_WORKFLOW_GITHUB_CLI_OUTPUT_JSON_INVALID");
  }
  const verified = validateVerifiedGitHubAttestationOutput({
    artifactDigest: artifactManifest.artifactDigest,
    artifactManifestSha256: sha256(canonicalJson(artifactManifest)),
    artifactName: artifactManifest.artifactName,
    attestationBundle: bundleDocument,
    attestationBundleSha256: sha256(bundle.bytes),
    expectedWorkflowRef,
    expectedWorkflowSha,
    githubCliPlatform,
    githubCliSha256,
    sigstoreTrustedRootSha256: expectedSigstoreTrustedRootSha256,
    verificationOutput,
  });
  cryptographicallyVerifiedAttestations.add(verified);
  return verified;
}

function validateSignedClaims({
  artifactManifest,
  expectedArtifactDigest,
  expectedWorkflowRef,
  expectedWorkflowSha,
  payload,
}) {
  const identity = parseWorkflowIdentity(expectedWorkflowRef, expectedWorkflowSha);
  assertExactObjectKeys(payload, [
    "artifact",
    "attestedAt",
    "github",
    "runtime",
    "verification",
  ], "PROTECTED_WORKFLOW_PROVENANCE_PAYLOAD");
  requireIsoTimestamp(payload.attestedAt, "PROTECTED_WORKFLOW_ATTESTED_AT_INVALID");
  assertExactObjectKeys(payload.artifact, [
    "artifactDigest",
    "artifactName",
    "attestationBundleSha256",
    "manifestSha256",
    "predicateType",
    "statementSha256",
  ], "PROTECTED_WORKFLOW_ARTIFACT_ATTESTATION");
  const artifact = payload.artifact;
  invariant(artifact.artifactDigest === expectedArtifactDigest, "PROTECTED_WORKFLOW_SIGNED_ARTIFACT_MISMATCH");
  invariant(artifact.artifactName === artifactManifest.artifactName, "PROTECTED_WORKFLOW_ARTIFACT_NAME_MISMATCH");
  invariant(
    artifact.manifestSha256 === sha256(canonicalJson(artifactManifest)),
    "PROTECTED_WORKFLOW_ARTIFACT_MANIFEST_DIGEST_MISMATCH",
  );
  requireSha256(artifact.attestationBundleSha256, "PROTECTED_WORKFLOW_ATTESTATION_BUNDLE_DIGEST_INVALID");
  requireSha256(artifact.statementSha256, "PROTECTED_WORKFLOW_STATEMENT_DIGEST_INVALID");
  invariant(
    artifact.predicateType === githubArtifactAttestationPredicateType,
    "PROTECTED_WORKFLOW_PREDICATE_INVALID",
  );
  assertExactObjectKeys(payload.github, [
    "buildConfigDigest",
    "buildConfigUri",
    "buildSignerDigest",
    "buildSignerUri",
    "buildTrigger",
    "githubWorkflowRef",
    "issuer",
    "repository",
    "runAttempt",
    "runId",
    "runInvocationUri",
    "runnerEnvironment",
    "sourceRepositoryDigest",
    "sourceRepositoryIdentifier",
    "sourceRepositoryOwnerIdentifier",
    "sourceRepositoryOwnerUri",
    "sourceRepositoryRef",
    "sourceRepositoryUri",
    "sourceRepositoryVisibilityAtSigning",
    "subjectAlternativeName",
    "workflowReference",
    "workflowSha",
    "workflowTrigger",
  ], "PROTECTED_WORKFLOW_GITHUB_IDENTITY");
  const github = payload.github;
  invariant(github.repository === identity.repository, "PROTECTED_WORKFLOW_REPOSITORY_MISMATCH");
  invariant(github.workflowReference === identity.workflowRef, "PROTECTED_WORKFLOW_REF_MISMATCH");
  invariant(github.workflowSha === identity.workflowSha, "PROTECTED_WORKFLOW_SHA_MISMATCH");
  invariant(
    github.issuer === githubArtifactAttestationOidcIssuer,
    "PROTECTED_WORKFLOW_OIDC_ISSUER_INVALID",
  );
  invariant(
    github.subjectAlternativeName === identity.certificateIdentity,
    "PROTECTED_WORKFLOW_CERTIFICATE_SUBJECT_MISMATCH",
  );
  invariant(
    github.workflowTrigger === "workflow_dispatch"
      && github.buildTrigger === "workflow_dispatch",
    "PROTECTED_WORKFLOW_TRIGGER_INVALID",
  );
  invariant(
    github.githubWorkflowRef === identity.sourceRef
      && github.sourceRepositoryRef === identity.sourceRef,
    "PROTECTED_WORKFLOW_CERTIFICATE_REF_MISMATCH",
  );
  invariant(
    github.buildConfigDigest === identity.workflowSha
      && github.buildSignerDigest === identity.workflowSha
      && github.sourceRepositoryDigest === identity.workflowSha,
    "PROTECTED_WORKFLOW_CERTIFICATE_SHA_MISMATCH",
  );
  invariant(
    github.buildConfigUri === identity.workflowUri
      && github.buildSignerUri === identity.workflowUri,
    "PROTECTED_WORKFLOW_CERTIFICATE_WORKFLOW_URI_MISMATCH",
  );
  invariant(
    github.sourceRepositoryUri === identity.sourceRepositoryUri
      && github.sourceRepositoryOwnerUri === identity.ownerUri,
    "PROTECTED_WORKFLOW_SOURCE_REPOSITORY_URI_MISMATCH",
  );
  invariant(github.runnerEnvironment === "github-hosted", "PROTECTED_WORKFLOW_RUNNER_ENVIRONMENT_INVALID");
  requireNumericIdentifier(github.runId, "PROTECTED_WORKFLOW_RUN_ID_INVALID");
  invariant(
    Number.isSafeInteger(github.runAttempt) && github.runAttempt >= 1 && github.runAttempt <= 1_000,
    "PROTECTED_WORKFLOW_RUN_ATTEMPT_INVALID",
  );
  invariant(
    parseRunInvocation(github.runInvocationUri, identity).runId === github.runId
      && parseRunInvocation(github.runInvocationUri, identity).runAttempt === github.runAttempt,
    "PROTECTED_WORKFLOW_RUN_INVOCATION_MISMATCH",
  );
  requireNumericIdentifier(
    github.sourceRepositoryIdentifier,
    "PROTECTED_WORKFLOW_SOURCE_REPOSITORY_IDENTIFIER_INVALID",
  );
  requireNumericIdentifier(
    github.sourceRepositoryOwnerIdentifier,
    "PROTECTED_WORKFLOW_SOURCE_OWNER_IDENTIFIER_INVALID",
  );
  invariant(
    ["public", "private", "internal"].includes(github.sourceRepositoryVisibilityAtSigning),
    "PROTECTED_WORKFLOW_SOURCE_VISIBILITY_INVALID",
  );
  assertExactObjectKeys(payload.verification, [
    "certificateSha256",
    "githubCliPlatform",
    "githubCliSha256",
    "githubCliVersion",
    "sigstoreTrustedRootSha256",
    "verificationResultSha256",
    "verifiedTimestampCount",
    "verifiedTimestampsSha256",
  ], "PROTECTED_WORKFLOW_VERIFICATION_BINDING");
  const verification = payload.verification;
  for (const [value, code] of [
    [verification.certificateSha256, "PROTECTED_WORKFLOW_CERTIFICATE_DIGEST_INVALID"],
    [verification.githubCliSha256, "PROTECTED_WORKFLOW_GITHUB_CLI_DIGEST_INVALID"],
    [verification.sigstoreTrustedRootSha256, "PROTECTED_WORKFLOW_SIGSTORE_ROOT_DIGEST_INVALID"],
    [verification.verificationResultSha256, "PROTECTED_WORKFLOW_VERIFICATION_RESULT_DIGEST_INVALID"],
    [verification.verifiedTimestampsSha256, "PROTECTED_WORKFLOW_VERIFIED_TIMESTAMPS_DIGEST_INVALID"],
  ]) requireSha256(value, code);
  invariant(
    verification.githubCliVersion === githubArtifactAttestationCliVersion,
    "PROTECTED_WORKFLOW_GITHUB_CLI_VERSION_MISMATCH",
  );
  validateCliPin(verification.githubCliPlatform, verification.githubCliSha256);
  invariant(
    Number.isSafeInteger(verification.verifiedTimestampCount)
      && verification.verifiedTimestampCount >= 1
      && verification.verifiedTimestampCount <= 16,
    "PROTECTED_WORKFLOW_VERIFIED_TIMESTAMP_COUNT_INVALID",
  );
  return Object.freeze({ artifact, github, verification });
}

export function validateProtectedWorkflowProvenanceReceipt({
  artifactManifest,
  expectedArtifactDigest,
  expectedRuntime,
  expectedWorkflowRef,
  expectedWorkflowSha,
  receipt,
  trustContext,
  verifiedAttestation = null,
}) {
  validateExternalGateRuntimeBinding(expectedRuntime, expectedRuntime);
  requireSha256(expectedArtifactDigest, "PROTECTED_WORKFLOW_EXPECTED_ARTIFACT_DIGEST_REQUIRED");
  validateArtifactManifest(artifactManifest, expectedArtifactDigest);
  verifyExternalGateReceipt({
    expectedRecordType: protectedWorkflowProvenanceRecordType,
    expectedRole: protectedWorkflowProvenanceRole,
    receipt,
    trustContext,
  });
  validateExternalGateRuntimeBinding(receipt.payload?.runtime, expectedRuntime);
  const signed = validateSignedClaims({
    artifactManifest,
    expectedArtifactDigest,
    expectedWorkflowRef,
    expectedWorkflowSha,
    payload: receipt.payload,
  });
  invariant(
    Date.parse(receipt.signedAt) >= Date.parse(receipt.payload.attestedAt),
    "PROTECTED_WORKFLOW_RECEIPT_SIGNED_BEFORE_ATTESTATION",
  );
  let status = "SIGNED_VERIFICATION_RECEIPT";
  if (verifiedAttestation !== null) {
    invariant(
      cryptographicallyVerifiedAttestations.has(verifiedAttestation),
      "PROTECTED_WORKFLOW_CRYPTOGRAPHIC_VERIFICATION_REQUIRED",
    );
    const signedVerificationClaims = {
      artifact: receipt.payload.artifact,
      attestedAt: receipt.payload.attestedAt,
      github: receipt.payload.github,
      verification: receipt.payload.verification,
    };
    invariant(
      canonicalJson(signedVerificationClaims) === canonicalJson(verifiedAttestation),
      "PROTECTED_WORKFLOW_SIGNED_VERIFIED_CLAIMS_MISMATCH",
    );
    status = "VERIFIED";
  }
  return Object.freeze({
    artifactDigest: signed.artifact.artifactDigest,
    artifactManifestSha256: signed.artifact.manifestSha256,
    attestationBundleSha256: signed.artifact.attestationBundleSha256,
    certificateSha256: signed.verification.certificateSha256,
    receiptId: receipt.receiptId,
    runAttempt: signed.github.runAttempt,
    runId: signed.github.runId,
    signerSubject: receipt.signerSubject,
    status,
    workflowRef: signed.github.workflowReference,
    workflowSha: signed.github.workflowSha,
  });
}
