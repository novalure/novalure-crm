import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type KeyLike } from "jose";
import { verifyMicrosoftMailboxIdentity } from "../src/lib/integrations/microsoft-oidc-identity";

test("Microsoft mailbox identity requires signature, tenant-scoped issuer, key issuer, audience and nonce", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
  const second = await generateKeyPair("RS256", { modulusLength: 2048 });
  const tenant = randomUUID(), otherTenant = randomUUID(), objectId = randomUUID(), clientId = randomUUID();
  const nonce = "synthetic_nonce_012345678901234567890123456789";
  const publicJwk = { ...await exportJWK(publicKey), kid: "synthetic-key", use: "sig", issuer: "https://login.microsoftonline.com/{tenantid}/v2.0" };
  const keys = async (): Promise<JSONWebKeySet> => ({ keys: [publicJwk] });
  const issue = async (overrides: Record<string, unknown> = {}, signingKey: KeyLike = privateKey) => new SignJWT({ tid: tenant, oid: objectId, nonce, ver: "2.0", ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" }).setAudience(clientId).setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`)
    .setSubject("synthetic-subject").setIssuedAt().setExpirationTime("5m").sign(signingKey);
  const token = await issue();
  const identity = { tenantId: tenant, objectId, subject: "synthetic-subject" };
  assert.deepEqual(await verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: token, clientId, expectedNonce: nonce }, keys), identity);
  // Exercise the actual key-fetch reader with a fully synthetic provider response.
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), {headers: {"content-type":"application/json"}});
    assert.deepEqual(await verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: token, clientId, expectedNonce: nonce }), identity);
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(await verifyMicrosoftMailboxIdentity({ flow: "refresh", idToken: token, clientId, expectedIdentity: identity }, keys), identity);
  const upperClaims = { tid: tenant.toUpperCase(), oid: objectId.toUpperCase() };
  assert.deepEqual(await verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: await issue(upperClaims), clientId, expectedNonce: nonce }, keys), identity);
  const existingBinding = { ...identity, objectId: objectId.toUpperCase() };
  assert.deepEqual(await verifyMicrosoftMailboxIdentity({ flow: "refresh", idToken: token, clientId, expectedIdentity: existingBinding }, keys), identity);
  for (const altered of [{ ...identity, tenantId: otherTenant }, { ...identity, objectId: randomUUID() }, { ...identity, subject: "synthetic-subject".toUpperCase() }]) {
    await assert.rejects(verifyMicrosoftMailboxIdentity({ flow: "refresh", idToken: token, clientId, expectedIdentity: altered }, keys), /MICROSOFT_IDENTITY_UNVERIFIED/);
  }
  await assert.rejects(verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: token, clientId: randomUUID(), expectedNonce: nonce }, keys), /MICROSOFT_IDENTITY_UNVERIFIED/);
  await assert.rejects(verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: token, clientId, expectedNonce: `${nonce}-wrong` }, keys), /MICROSOFT_IDENTITY_UNVERIFIED/);
  await assert.rejects(verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: await issue({}, second.privateKey), clientId, expectedNonce: nonce }, keys), /MICROSOFT_IDENTITY_UNVERIFIED/);
  await assert.rejects(verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: await issue({ tid: otherTenant }), clientId, expectedNonce: nonce }, keys), /MICROSOFT_IDENTITY_UNVERIFIED/);
  await assert.rejects(verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: token, clientId, expectedNonce: nonce }, async () => ({ keys: [{ ...publicJwk, issuer: `https://login.microsoftonline.com/${otherTenant}/v2.0` }] })), /MICROSOFT_IDENTITY_UNVERIFIED/);
  await assert.rejects(verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: await issue({ oid: "not-an-object-id" }), clientId, expectedNonce: nonce }, keys), /MICROSOFT_IDENTITY_UNVERIFIED/);
  const expired = await new SignJWT({ tid: tenant, oid: objectId, nonce, ver: "2.0" }).setProtectedHeader({ alg: "RS256", kid: "synthetic-key" }).setAudience(clientId).setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`).setSubject("synthetic-subject").setIssuedAt().setExpirationTime("-1s").sign(privateKey);
  await assert.rejects(verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: expired, clientId, expectedNonce: nonce }, keys), /MICROSOFT_IDENTITY_UNVERIFIED/);
  await assert.rejects(verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: token, clientId, expectedNonce: nonce }, async () => ({ keys: [publicJwk, publicJwk] })), /MICROSOFT_IDENTITY_UNVERIFIED/);
  await assert.rejects(verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: token, clientId, expectedNonce: nonce }, async () => ({ keys: [] })), /MICROSOFT_IDENTITY_UNAVAILABLE/);
  await assert.rejects(verifyMicrosoftMailboxIdentity({ flow: "authorization", idToken: token, clientId, expectedNonce: nonce }, async () => { throw new Error("synthetic network failure"); }), /MICROSOFT_IDENTITY_UNAVAILABLE/);
});

test("Microsoft signing-key fetch and body have a shared deadline and bounded cancellation", {timeout: 15_000}, async () => {
  const originalFetch = globalThis.fetch;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({alg:"RS256",kid:"synthetic"})}.${encode({})}.AA`;
  const input = { flow: "authorization" as const, idToken: token, clientId: randomUUID(), expectedNonce: "synthetic_nonce_012345678901234567890123456789" };
  let cancelCount = 0;
  const hangingCancel = () => { cancelCount++; return new Promise<void>(() => {}); };
  try {
    // A large response used to hang when the underlying cancel promise hung.
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(262145)); }, cancel: hangingCancel,
    }));
    await assert.rejects(verifyMicrosoftMailboxIdentity(input), /MICROSOFT_IDENTITY_UNAVAILABLE/);
    assert.equal(cancelCount, 1);

    // An uncooperative transport can ignore abort and respond after the deadline.
    let finishFetch!: (response: Response) => void;
    let lateCancelCount = 0;
    globalThis.fetch = async () => new Promise<Response>(resolve => { finishFetch = resolve; });
    const stalledHeaders = verifyMicrosoftMailboxIdentity(input);

    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([123])); }, cancel: hangingCancel,
    }));
    const stalledBody = verifyMicrosoftMailboxIdentity(input);

    let dripTimer!: ReturnType<typeof setInterval>, dripCount = 0;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { dripTimer = setInterval(() => { dripCount++; controller.enqueue(new Uint8Array([32])); }, 10); },
      cancel() { clearInterval(dripTimer); return hangingCancel(); },
    }));
    const dripping = verifyMicrosoftMailboxIdentity(input);
    await Promise.all([stalledHeaders, stalledBody, dripping].map(promise => assert.rejects(promise, /MICROSOFT_IDENTITY_UNAVAILABLE/)));
    assert.ok(dripCount > 1);
    assert.equal(cancelCount, 3);
    finishFetch(new Response(new ReadableStream<Uint8Array>({cancel() { lateCancelCount++; }})));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(lateCancelCount, 1);

    // Endless zero-length chunks are bounded independently of the deadline.
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array()); }, cancel: hangingCancel,
    }));
    await assert.rejects(verifyMicrosoftMailboxIdentity(input), /MICROSOFT_IDENTITY_UNAVAILABLE/);
    assert.equal(cancelCount, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
