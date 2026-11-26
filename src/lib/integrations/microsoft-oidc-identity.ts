import "server-only";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWK } from "jose";

const microsoftKeysUrl = "https://login.microsoftonline.com/common/discovery/v2.0/keys";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type MicrosoftSigningKey = JWK & { issuer?: string };
export type MicrosoftVerifiedIdentity = Readonly<{ tenantId: string; objectId: string; subject: string }>;
export class MicrosoftIdentityError extends Error {
  constructor(public readonly code: "MICROSOFT_IDENTITY_UNAVAILABLE" | "MICROSOFT_IDENTITY_UNVERIFIED") { super(code); }
}

async function loadMicrosoftKeys(): Promise<JSONWebKeySet> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  const unavailable = () => new Error("MICROSOFT_IDENTITY_UNAVAILABLE");
  // A single wall-clock deadline covers response headers and the entire body,
  // even if a transport ignores abort or continuously supplies tiny chunks.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 8_000);
  });
  const cancel = (body: ReadableStream<Uint8Array> | null) => {
    try { if (body) void body.cancel().catch(() => undefined); } catch { /* best effort */ }
  };
  try {
    const pending = fetch(microsoftKeysUrl, { headers: { accept: "application/json" }, redirect: "error", cache: "no-store", signal: controller.signal }).then((value) => {
      // A non-cooperative transport might deliver a response after the deadline.
      if (controller.signal.aborted) { cancel(value.body); throw unavailable(); }
      return value;
    });
    response = await Promise.race([pending, deadline]);
    if (!response.ok || Number(response.headers.get("content-length") || 0) > 262144) throw unavailable();
    reader = response.body?.getReader();
    if (!reader) throw unavailable();
    let length = 0, reads = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) { complete = true; break; }
      // Bound promise handlers and CPU even for an endless stream of empty chunks.
      if (++reads > 8192) throw unavailable();
      length += part.value.byteLength;
      if (length > 262144) throw unavailable();
      chunks.push(part.value);
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as JSONWebKeySet).keys) || (raw as JSONWebKeySet).keys.length > 200) throw unavailable();
    return raw as JSONWebKeySet;
  } finally {
    if (timer) clearTimeout(timer);
    if (!complete) {
      controller.abort();
      if (reader) { try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ } }
      else if (response) cancel(response.body);
    }
    reader?.releaseLock();
  }
}

/** Verify only an ID token from the just-completed OAuth flow, never a Graph access token.
 * The optional key loader is for isolated tests; no request parameter may select keys. */
export async function verifyMicrosoftMailboxIdentity(input: { idToken: string; clientId: string } & ({ flow: "authorization"; expectedNonce: string } | { flow: "refresh"; expectedIdentity: MicrosoftVerifiedIdentity }), loadKeys: () => Promise<JSONWebKeySet> = loadMicrosoftKeys): Promise<MicrosoftVerifiedIdentity> {
  try {
    if (!uuid.test(input.clientId) || input.flow === "authorization" && !/^[A-Za-z0-9_-]{32,128}$/.test(input.expectedNonce) || input.idToken.length > 16384) throw new Error();
    const header = decodeProtectedHeader(input.idToken);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256) throw new Error();
    let jwks: JSONWebKeySet;
    try { jwks = await loadKeys(); } catch { throw new MicrosoftIdentityError("MICROSOFT_IDENTITY_UNAVAILABLE"); }
    const matching = jwks.keys.filter(key => key.kid === header.kid && key.kty === "RSA" && (!key.use || key.use === "sig")) as MicrosoftSigningKey[];
    if (matching.length === 0) throw new MicrosoftIdentityError("MICROSOFT_IDENTITY_UNAVAILABLE");
    if (matching.length !== 1 || typeof matching[0].issuer !== "string") throw new Error();
    const { payload } = await jwtVerify(input.idToken, createLocalJWKSet({ keys: matching }), {
      algorithms: ["RS256"], audience: input.clientId, requiredClaims: ["aud", "iss", "sub", "exp", "iat", "tid", "oid", ...(input.flow === "authorization" ? ["nonce"] : [])], clockTolerance: 0,
    });
    if (payload.aud !== input.clientId || typeof payload.tid !== "string" || !uuid.test(payload.tid) ||
        typeof payload.oid !== "string" || !uuid.test(payload.oid) || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255 ||
        input.flow === "authorization" && payload.nonce !== input.expectedNonce || payload.ver !== "2.0" || !Number.isSafeInteger(payload.iat) || payload.iat! > Math.floor(Date.now() / 1000) + 30) throw new Error();
    const issuer = `https://login.microsoftonline.com/${payload.tid}/v2.0`;
    if (payload.iss !== issuer || matching[0].issuer.replace(/\{tenantid\}/gi, payload.tid) !== issuer) throw new Error();
    const identity = Object.freeze({ tenantId: payload.tid, objectId: payload.oid, subject: payload.sub });
    if (input.flow === "refresh" && (identity.tenantId !== input.expectedIdentity.tenantId || identity.objectId !== input.expectedIdentity.objectId || identity.subject !== input.expectedIdentity.subject)) throw new Error();
    return identity;
  } catch (error) { if (error instanceof MicrosoftIdentityError) throw error; throw new MicrosoftIdentityError("MICROSOFT_IDENTITY_UNVERIFIED"); }
}
