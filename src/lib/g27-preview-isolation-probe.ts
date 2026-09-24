import "server-only";
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { getVercelOidcToken } from "@vercel/oidc";
import { CRM_VERCEL_PROJECT_ID, NOVALURE_VERCEL_TEAM_ID, EVELYN_PREVIEW_AUDIENCE,
  EVELYN_V2_PREVIEW_URL, evelynRequestJtiV2 } from "./evelyn-approval-client";

// Temporary G27 acceptance probe. Remove before merging PR65. It has no database
// dependency and cannot send a caller-supplied URL, tenant, body or audience.
const branch = "codex/crm-production-readiness-g27";
const probePath = "/api/qa/g27-isolation";
const expiresAt = Date.parse("2026-09-25T00:00:00Z");
const context = "novalure:g27:preview-isolation-probe:v1";
const headers = { "cache-control": "no-store" };
type ProbeTransport = { fetch: typeof fetch; token: typeof getVercelOidcToken };
type ProbeEnvironment = Readonly<Record<string, string | undefined>>;

export function probeSignature(secret: string, timestamp: string, nonce: string, commit: string) {
  const key = Buffer.from(hkdfSync("sha256", secret, context, "request-authentication", 32));
  return createHmac("sha256", key).update(`${context}\n${timestamp}\n${nonce}\n${commit}`).digest("hex");
}

function authorized(request: Request, env: ProbeEnvironment, now: number) {
  if (now >= expiresAt || env.VERCEL !== "1" || env.VERCEL_ENV !== "preview"
    || (env.VERCEL_TARGET_ENV !== undefined && env.VERCEL_TARGET_ENV !== "preview")
    || env.VERCEL_PROJECT_ID !== CRM_VERCEL_PROJECT_ID || env.VERCEL_GIT_COMMIT_REF !== branch
    || !/^[a-f0-9]{40}$/.test(env.VERCEL_GIT_COMMIT_SHA ?? "")
    || !env.VERCEL_URL || new URL(request.url).origin !== `https://${env.VERCEL_URL}`
    || new URL(request.url).pathname !== probePath || new URL(request.url).search
    || request.method !== "POST") return false;
  const timestamp = request.headers.get("x-g27-time") ?? "";
  const nonce = request.headers.get("x-g27-nonce") ?? "";
  const signature = request.headers.get("x-g27-signature") ?? "";
  const secret = env.NOVALURE_SESSION_SECRET;
  if (!secret || secret.length < 32 || !/^\d{13}$/.test(timestamp)
    || Math.abs(now - Number(timestamp)) > 30_000
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce)
    || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = probeSignature(secret, timestamp, nonce, env.VERCEL_GIT_COMMIT_SHA!);
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

function assertTokenBinding(token: string) {
  // The SDK supplies this token; Evelyn independently verifies its signature.
  // Decode only in memory to reject a wrong source runtime before any request.
  const claim = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  if (claim.project_id !== CRM_VERCEL_PROJECT_ID || claim.owner_id !== NOVALURE_VERCEL_TEAM_ID
    || claim.environment !== "preview") throw new Error("SOURCE_RUNTIME_MISMATCH");
}

export async function runG27IsolationProbe(request: Request, env: ProbeEnvironment = process.env,
  transport: ProbeTransport = { fetch: globalThis.fetch, token: getVercelOidcToken }, now = Date.now()) {
  if (!authorized(request, env, now)) return Response.json({ code: "NOT_FOUND" }, { status: 404, headers });
  // Vercel may represent a bodyless POST as a closed stream rather than null.
  // Accept only clean EOF without data, with bounded reads and elapsed time.
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && contentLength !== "0") {
    return Response.json({ code: "BODY_DENIED" }, { status: 400, headers });
  }
  if (request.body !== null) {
    const reader = request.body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let empty = false;
    try {
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("BODY_TIMEOUT")), 2000); });
      for (let chunks = 0; chunks < 32; chunks++) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk.done) { empty = true; break; }
        if (chunk.value.byteLength > 0) break;
      }
    } catch { empty = false; }
    finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!empty) return Response.json({ code: "BODY_DENIED" }, { status: 400, headers });
  }
  try {
    const results = [];
    for (const [name, tenantId, expectedStatus, expectedCode] of [
      ["control", "afeac3f9-7534-47f5-b749-b3fd91b8f91b", 400, "INVALID_INPUT"],
      ["foreign", "d7ec955a-812d-4d3d-a65a-369d8fa9c0c2", 401, "SERVICE_AUTH_DENIED"],
    ] as const) {
      const body = { action: { tenantId } };
      const nonce = randomUUID();
      const token = await transport.token({ audience: EVELYN_PREVIEW_AUDIENCE,
        jti: evelynRequestJtiV2(nonce, body, "create"), skipCache: true });
      const protection = await transport.token();
      assertTokenBinding(token);
      assertTokenBinding(protection);
      const response = await transport.fetch(`${EVELYN_V2_PREVIEW_URL}/api/v2/approvals/requests`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
          "x-vercel-trusted-oidc-idp-token": protection, "x-evelyn-request-nonce": nonce },
        body: JSON.stringify(body), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12_000),
      });
      const json = response.headers.get("content-type")?.includes("application/json") === true;
      const noStore = response.headers.get("cache-control")?.includes("no-store") === true;
      const noCookie = !response.headers.has("set-cookie");
      const text = await response.text();
      if (text.length > 4096 || !json) throw new Error("UNEXPECTED_RESPONSE");
      const payload = JSON.parse(text);
      const code = payload.code ?? payload.error;
      const pass = response.status === expectedStatus && code === expectedCode && noStore && noCookie;
      results.push({ name, status: response.status, code: code === expectedCode ? code : "UNEXPECTED_CODE",
        json, noStore, noCookie, pass });
      if (!pass) break;
    }
    const pass = results.length === 2 && results.every(result => result.pass);
    return Response.json({ status: pass ? "PASS" : "BLOCKED", results,
      directDatabaseAccess: false, completeBusinessPayloads: false,
      remotePersistence: "AWAITING_AFTER_SNAPSHOT" }, { status: pass ? 200 : 409, headers });
  } catch {
    return Response.json({ status: "BLOCKED", code: "ISOLATION_PROBE_FAILED" }, { status: 502, headers });
  }
}
