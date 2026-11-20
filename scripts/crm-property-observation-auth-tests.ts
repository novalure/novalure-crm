import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { PROPERTY_READER_AUDIENCE, assertVerifiedPropertyReaderIdentity, verifyPropertyReaderIdentity } from "../src/lib/crm-property-observation-auth";

const keys = ["NODE_ENV", "VERCEL_ENV", "CRM_PROPERTY_READER_ENABLED", "CRM_PROPERTY_READER_ISSUER", "CRM_PROPERTY_READER_SUBJECT", "CRM_PROPERTY_READER_OWNER_ID", "CRM_PROPERTY_READER_PROJECT_ID"];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const token = `eyJ${"a".repeat(20)}.${"b".repeat(24)}.${"c".repeat(24)}`;
type Verifier = NonNullable<Parameters<typeof verifyPropertyReaderIdentity>[1]>;
function verifier(overrides: Record<string, unknown> = {}): Verifier {
  const now = Math.floor(Date.now() / 1000);
  return async () => ({ payload: {
    iss: process.env.CRM_PROPERTY_READER_ISSUER, sub: process.env.CRM_PROPERTY_READER_SUBJECT, aud: PROPERTY_READER_AUDIENCE,
    owner_id: process.env.CRM_PROPERTY_READER_OWNER_ID, project_id: process.env.CRM_PROPERTY_READER_PROJECT_ID,
    environment: "production", iat: now - 5, nbf: now - 5, exp: now + 300, jti: randomUUID(), ...overrides,
  }, protectedHeader: { alg: "RS256", typ: "JWT", kid: "synthetic-key" } } as Awaited<ReturnType<Verifier>>);
}
before(() => Object.assign(process.env, { NODE_ENV: "test", VERCEL_ENV: "production", CRM_PROPERTY_READER_ENABLED: "1", CRM_PROPERTY_READER_ISSUER: "https://issuer.example.invalid/team", CRM_PROPERTY_READER_SUBJECT: "property-reader", CRM_PROPERTY_READER_OWNER_ID: "team-test", CRM_PROPERTY_READER_PROJECT_ID: "project-test" }));
after(() => { for (const [key,value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });

test("property identity uses a separate verified audience and cannot be forged by cloning", async () => {
  const identity = await verifyPropertyReaderIdentity(token, verifier());
  assert.equal(identity.audience, PROPERTY_READER_AUDIENCE);
  assert.doesNotThrow(() => assertVerifiedPropertyReaderIdentity(identity));
  assert.throws(() => assertVerifiedPropertyReaderIdentity({ ...identity }), /CRM_PROPERTY_AUTH_DENIED/);
});

test("wrong signature, existing CRM audience, issuer, scope and expired claims are denied", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { aud: "urn:novalure:crm:production" }, { iss: "https://other.example.invalid/team" }, { sub: "other" },
    { owner_id: "other" }, { project_id: "other" }, { environment: "preview" },
    { exp: now - 1 }, { nbf: now + 300 }, { jti: "not-a-uuid" },
  ]) await assert.rejects(verifyPropertyReaderIdentity(token, verifier(claims)), /CRM_PROPERTY_AUTH_DENIED/);
  await assert.rejects(verifyPropertyReaderIdentity(token, async () => { throw new Error("invalid signature"); }), /CRM_PROPERTY_AUTH_DENIED/);
  await assert.rejects(verifyPropertyReaderIdentity("bad-token", verifier()), /CRM_PROPERTY_AUTH_DENIED/);
});

test("disabling or changing the server identity binding invalidates an already verified token", async () => {
  const identity = await verifyPropertyReaderIdentity(token, verifier());
  process.env.CRM_PROPERTY_READER_ENABLED = "0";
  try { assert.throws(() => assertVerifiedPropertyReaderIdentity(identity), /CRM_PROPERTY_AUTH_DENIED/); }
  finally { process.env.CRM_PROPERTY_READER_ENABLED = "1"; }
  process.env.CRM_PROPERTY_READER_SUBJECT = "different-subject";
  try { assert.throws(() => assertVerifiedPropertyReaderIdentity(identity), /CRM_PROPERTY_AUTH_DENIED/); }
  finally { process.env.CRM_PROPERTY_READER_SUBJECT = "property-reader"; }
});

test("the test verifier cannot be used in a production process", async () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  try { await assert.rejects(verifyPropertyReaderIdentity(token, verifier()), /CRM_PROPERTY_AUTH_DENIED/); }
  finally { Object.assign(process.env, { NODE_ENV: "test" }); }
});
