import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const databaseBranchPattern = /^br-[A-Za-z0-9-]{8,128}$/u;
const deploymentHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const gitBranchPattern = /^codex\/[A-Za-z0-9._/-]{1,220}$/u;
const gitShaPattern = /^[a-f0-9]{40}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requiredString(value, label, maximumLength = 512) {
  const normalized = typeof value === "string" ? value.trim() : "";
  assert.ok(normalized && normalized.length <= maximumLength, `${label} is required and must be bounded.`);
  return normalized;
}

export function parseStrictCliArgs(argv, { booleanNames = [], valueNames = [] }) {
  const booleans = new Set(booleanNames);
  const valued = new Set(valueNames);
  for (const name of booleans) assert.ok(!valued.has(name), `CLI argument is configured twice: --${name}`);
  const allowed = new Set([...booleans, ...valued]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    assert.match(argument, /^--[a-z0-9-]+$/u, `Unexpected positional or malformed argument: ${argument}`);
    const name = argument.slice(2);
    assert.ok(allowed.has(name), `Unknown CLI argument: ${argument}`);
    assert.ok(!values.has(name), `Duplicate CLI argument: ${argument}`);
    if (booleans.has(name)) {
      values.set(name, "1");
      continue;
    }
    const value = argv[index + 1];
    assert.ok(value && !value.startsWith("--"), `Missing value for ${argument}`);
    values.set(name, value);
    index += 1;
  }
  return values;
}

export function requirePreviewRuntimeIdentityExpectation(input) {
  const deploymentHost = requiredString(input?.deploymentHost, "Expected deployment host").toLowerCase();
  const deploymentId = requiredString(input?.deploymentId, "Expected deployment id");
  const gitBranch = requiredString(input?.gitBranch, "Expected Git branch", 250);
  const gitSha = requiredString(input?.gitSha, "Expected Git SHA").toLowerCase();
  const databaseBranchId = requiredString(input?.databaseBranchId, "Expected database branch id");

  assert.match(deploymentHost, deploymentHostPattern, "Expected deployment host must be an exact Vercel Preview host.");
  assert.match(deploymentId, deploymentIdPattern, "Expected deployment id is invalid.");
  assert.match(gitBranch, gitBranchPattern, "Expected Git branch must be an exact codex/ branch.");
  assert.match(gitSha, gitShaPattern, "Expected Git SHA must be a full lowercase SHA.");
  assert.match(databaseBranchId, databaseBranchPattern, "Expected database branch id is invalid.");

  return Object.freeze({ databaseBranchId, deploymentHost, deploymentId, gitBranch, gitSha });
}

export function attestPreviewRuntimeIdentity({ expected, payload, status }) {
  assert.equal(status, 200, "Authenticated runtime identity endpoint must return HTTP 200.");
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload), "Runtime identity response must be a JSON object.");
  assert.equal(payload.atomicRegistration, true, "Runtime identity must prove atomic QA registration capability.");
  assert.equal(payload.version, 2, "Runtime identity capability version is unexpected.");
  assert.equal(payload.deploymentHost, expected.deploymentHost, "Runtime deployment host does not match the candidate.");
  assert.equal(payload.deploymentId, expected.deploymentId, "Runtime deployment id does not match the candidate.");
  assert.equal(payload.gitBranch, expected.gitBranch, "Runtime Git branch does not match the candidate.");
  assert.equal(payload.gitSha, expected.gitSha, "Runtime Git SHA does not match the candidate.");
  assert.equal(payload.databaseBranchId, expected.databaseBranchId, "Runtime database branch does not match the isolated QA branch.");

  return Object.freeze({
    databaseBranchId: expected.databaseBranchId,
    deploymentId: expected.deploymentId,
    gitBranch: expected.gitBranch,
    gitSha: expected.gitSha,
    host: expected.deploymentHost,
  });
}

export function requireQaBrowserCredentials(env, { requireTotp = false } = {}) {
  const email = requiredString(env.NOVALURE_QA_PREVIEW_EMAIL, "NOVALURE_QA_PREVIEW_EMAIL").toLowerCase();
  const password = typeof env.NOVALURE_QA_PREVIEW_PASSWORD === "string" ? env.NOVALURE_QA_PREVIEW_PASSWORD : "";
  const workspaceId = requiredString(env.NOVALURE_QA_PREVIEW_WORKSPACE_ID, "NOVALURE_QA_PREVIEW_WORKSPACE_ID").toLowerCase();
  const fixtureMarkerKey = requiredString(
    env.NOVALURE_QA_PREVIEW_FIXTURE_MARKER_KEY,
    "NOVALURE_QA_PREVIEW_FIXTURE_MARKER_KEY",
    64,
  );
  const fixtureMarker = requiredString(
    env.NOVALURE_QA_PREVIEW_FIXTURE_MARKER,
    "NOVALURE_QA_PREVIEW_FIXTURE_MARKER",
    128,
  );
  const role = requiredString(env.NOVALURE_QA_PREVIEW_ROLE, "NOVALURE_QA_PREVIEW_ROLE", 64);
  const productRole = requiredString(
    env.NOVALURE_QA_PREVIEW_PRODUCT_ROLE,
    "NOVALURE_QA_PREVIEW_PRODUCT_ROLE",
    64,
  );
  const totpSecret = (env.NOVALURE_QA_PREVIEW_TOTP_SECRET ?? "").replace(/[\s-]/gu, "").toUpperCase();

  assert.match(email, /^codextest_[a-z0-9._+-]+@[a-z0-9.-]+$/u, "QA email must identify an isolated codextest_ fixture.");
  assert.ok(password.length >= 16 && password.length <= 512, "QA fixture password must contain 16 to 512 characters.");
  assert.match(workspaceId, uuidPattern, "QA fixture workspace id must be an exact UUID.");
  assert.ok(["qaFixture", "qaPrefix"].includes(fixtureMarkerKey), "QA fixture marker key is not approved.");
  assert.match(fixtureMarker, /^[A-Za-z0-9._:-]{1,128}$/u, "QA fixture marker is invalid.");
  assert.match(role, /^[A-Za-z0-9_-]{1,64}$/u, "QA fixture role is invalid.");
  assert.match(productRole, /^[A-Za-z0-9_-]{1,64}$/u, "QA fixture product role is invalid.");
  if (requireTotp) assert.match(totpSecret, /^[A-Z2-7]{16,128}$/u, "QA fixture TOTP secret is required.");
  if (totpSecret) assert.match(totpSecret, /^[A-Z2-7]{16,128}$/u, "QA fixture TOTP secret is invalid.");

  return Object.freeze({
    email,
    fixtureMarker,
    fixtureMarkerKey,
    password,
    productRole,
    role,
    totpSecret,
    workspaceId,
  });
}

export function attestQaBrowserSession(session, credentials) {
  assert.equal(session?.authenticated, true, "QA browser session is not authenticated.");
  assert.equal(session?.user?.email?.toLowerCase(), credentials.email, "QA browser session email does not match the fixture.");
  assert.equal(session?.user?.role, credentials.role, "QA browser session role does not match the fixture.");
  assert.equal(session?.user?.productRole, credentials.productRole, "QA browser product role does not match the fixture.");
  assert.equal(session?.workspace?.id?.toLowerCase(), credentials.workspaceId, "QA browser workspace does not match the fixture.");
  assert.equal(
    session?.workspace?.setupState?.[credentials.fixtureMarkerKey],
    credentials.fixtureMarker,
    "QA browser workspace marker does not match the fixture.",
  );
  return Object.freeze({
    fixtureMarker: credentials.fixtureMarker,
    fixtureMarkerKey: credentials.fixtureMarkerKey,
    productRole: credentials.productRole,
    role: credentials.role,
    workspaceId: credentials.workspaceId,
  });
}

export function attestMfaVerificationChallenge({
  hasCodeInput,
  hasEnrollmentControl,
  hasWorkspaceSelectionControl,
  step,
}) {
  if (step === "mfa_enrollment" || hasEnrollmentControl) {
    assert.fail("MFA enrollment is prohibited in a verification-only release gate.");
  }
  if (step === "workspace_selection" || hasWorkspaceSelectionControl) {
    assert.fail("Workspace selection is not an MFA verification challenge.");
  }
  assert.equal(step, "mfa_verification", "QA login must expose the exact mfa_verification challenge step.");
  assert.equal(hasCodeInput, true, "MFA verification code input is unavailable.");
  return "mfa_verification";
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value) {
    const index = alphabet.indexOf(character);
    assert.notEqual(index, -1, "QA fixture TOTP secret is invalid.");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

export function currentTotp(secret, now = Date.now()) {
  assert.match(secret, /^[A-Z2-7]{16,128}$/u, "QA fixture TOTP secret is invalid.");
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}
