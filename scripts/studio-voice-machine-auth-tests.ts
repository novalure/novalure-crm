import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { test } from "node:test";
import {
  CRM_MACHINE_AUDIENCE,
  CRM_MACHINE_ENVIRONMENT,
  CRM_MACHINE_ISSUER,
  CRM_MACHINE_OWNER_ID,
  CRM_MACHINE_PROJECT_ID,
  CRM_MACHINE_SUBJECT,
  CRM_MACHINE_WORKSPACE_ID,
  verifyCrmMachineToken,
} from "../src/lib/crm-machine-auth";
import {
  STUDIO_VOICE_AUDIENCE,
  verifyStudioVoiceMachineToken,
  type StudioVoiceMachineAuthOptions,
} from "../src/lib/studio-voice-machine-auth";

// Offline cryptographic evidence only. Keys exist in this test process and no
// production credentials, provider transports or remote JWKS are consumed.
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const unrelated = generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = new Date("2026-11-08T12:00:00.000Z");
const seconds = Math.floor(now.valueOf() / 1000);
const runtime = { STUDIO_VOICE_AUTH_ENABLED: "1", NODE_ENV: "production", VERCEL_ENV: "production" } as NodeJS.ProcessEnv;
type Verifier = NonNullable<StudioVoiceMachineAuthOptions["verifier"]>;
type VerificationResult = Awaited<ReturnType<Verifier>>;

function payload(patch: Record<string, unknown> = {}) {
  return {
    aud: STUDIO_VOICE_AUDIENCE,
    environment: CRM_MACHINE_ENVIRONMENT,
    exp: seconds + 300,
    iat: seconds - 5,
    iss: CRM_MACHINE_ISSUER,
    jti: randomUUID(),
    nbf: seconds - 5,
    owner_id: CRM_MACHINE_OWNER_ID,
    project_id: CRM_MACHINE_PROJECT_ID,
    sub: CRM_MACHINE_SUBJECT,
    ...patch,
  };
}

function token(claims = payload(), header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: "offline-studio-key" }, key = keys.privateKey) {
  const parts = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url"));
  const input = parts.join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}

const offlineVerifier: Verifier = async raw => {
  const [header, body, signature] = raw.split(".");
  if (!header || !body || !signature || !verify("RSA-SHA256", Buffer.from(`${header}.${body}`), keys.publicKey, Buffer.from(signature, "base64url"))) {
    throw new Error("OFFLINE_SIGNATURE_REJECTED");
  }
  return { protectedHeader: JSON.parse(Buffer.from(header, "base64url").toString("utf8")), payload: JSON.parse(Buffer.from(body, "base64url").toString("utf8")) } as VerificationResult;
};
const options = (patch: Partial<StudioVoiceMachineAuthOptions> = {}): StudioVoiceMachineAuthOptions => ({ env: runtime, now, verifier: offlineVerifier, ...patch });

test("Studio voice has a separate audience and identity using an offline RSA signature", async () => {
  let called = 0;
  const input = payload();
  const claims = await verifyStudioVoiceMachineToken(token(input), options({ verifier: async (raw, expected) => {
    called++;
    assert.deepEqual(expected!.algorithms, ["RS256"]);
    assert.equal(expected!.typ, "JWT");
    assert.equal(expected!.audience, "urn:novalure:crm:studio:voice-booking:production");
    assert.equal(expected!.issuer, CRM_MACHINE_ISSUER);
    assert.equal(expected!.ownerId, CRM_MACHINE_OWNER_ID);
    assert.equal(expected!.projectId, CRM_MACHINE_PROJECT_ID);
    assert.equal(expected!.environment, "production");
    for (const field of ["aud", "exp", "iat", "iss", "jti", "nbf", "sub"]) assert.equal(expected!.requiredClaims?.includes(field), true);
    return offlineVerifier(raw, expected);
  } }));
  assert.equal(called, 1);
  assert.equal(claims.audience, STUDIO_VOICE_AUDIENCE);
  assert.notEqual(STUDIO_VOICE_AUDIENCE as string, CRM_MACHINE_AUDIENCE);
  assert.equal(claims.identityId, "NOVALURE_STUDIO_VOICE_BOOKING");
  assert.equal(claims.workspaceId, CRM_MACHINE_WORKSPACE_ID);
  assert.equal(claims.jtiHash, createHash("sha256").update(input.jti).digest("hex"));
  assert.equal(Object.isFrozen(claims), true);
});

test("Studio and generic CRM token audiences cannot be exchanged", async () => {
  await assert.rejects(verifyStudioVoiceMachineToken(token(payload({ aud: CRM_MACHINE_AUDIENCE })), options()));
  await assert.rejects(verifyCrmMachineToken(token(), {
    env: { CRM_MACHINE_AUTH_ENABLED: "1", VERCEL_ENV: "production", NODE_ENV: "production" },
    now,
    verifier: offlineVerifier,
  }));
  await assert.rejects(verifyStudioVoiceMachineToken(token(payload({ aud: [STUDIO_VOICE_AUDIENCE, CRM_MACHINE_AUDIENCE] })), options()));
});

test("disabled or non-production Studio runtime denies before invoking the verifier", async () => {
  for (const env of [
    { ...runtime, STUDIO_VOICE_AUTH_ENABLED: "0" },
    { ...runtime, STUDIO_VOICE_AUTH_ENABLED: undefined },
    { ...runtime, VERCEL_ENV: "preview" },
    { ...runtime, VERCEL_ENV: undefined },
  ]) {
    let called = false;
    await assert.rejects(verifyStudioVoiceMachineToken(token(), options({ env, verifier: async (...args) => { called = true; return offlineVerifier(...args); } })));
    assert.equal(called, false);
  }
});

test("Studio voice rejects foreign claims, unsafe lifetimes and incomplete protected headers", async t => {
  const claims: Record<string, unknown>[] = [
    { iss: "https://oidc.vercel.com/foreign" }, { sub: "owner:novalure:project:foreign:environment:production" },
    { owner_id: "team_foreign" }, { project_id: "prj_foreign" }, { environment: "preview" },
    { jti: undefined }, { jti: "not-a-uuid" }, { iat: undefined }, { exp: undefined }, { nbf: undefined },
    { iat: seconds + 120 }, { nbf: seconds + 120 }, { exp: seconds - 120 }, { exp: seconds - 10, iat: seconds - 5 },
    { exp: seconds + 86_400 }, { iat: seconds - 5.5 }, { exp: "2030" },
  ];
  for (const patch of claims) await t.test(JSON.stringify(patch), async () => {
    await assert.rejects(verifyStudioVoiceMachineToken(token(payload(patch)), options()));
  });
  for (const header of [
    { alg: "HS256", typ: "JWT", kid: "offline-studio-key" },
    { alg: "none", typ: "JWT", kid: "offline-studio-key" },
    { alg: "RS256", typ: "at+jwt", kid: "offline-studio-key" },
    { alg: "RS256", typ: "JWT" },
    { alg: "RS256", typ: "JWT", kid: "x" },
  ]) await t.test(JSON.stringify(header), async () => {
    await assert.rejects(verifyStudioVoiceMachineToken(token(payload(), header), options()));
  });
});

test("malformed and tampered RSA tokens never become Studio claims", async () => {
  const valid = token();
  const parts = valid.split(".");
  const alteredBody = Buffer.from(JSON.stringify(payload({ sub: "tampered" }))).toString("base64url");
  for (const raw of ["malformed", `${parts[0]}.${alteredBody}.${parts[2]}`, token(payload(), undefined, unrelated.privateKey)]) {
    await assert.rejects(verifyStudioVoiceMachineToken(raw, options()));
  }
  await assert.rejects(verifyStudioVoiceMachineToken(valid, options({ verifier: async () => { throw new Error("OFFLINE_UNAVAILABLE"); } })));
});
