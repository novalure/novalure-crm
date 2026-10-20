import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { getVercelOidcToken, verifyVercelOidcToken } from "@vercel/oidc";
import pinnedContract from "./contract.json" with { type: "json" };

const DEADLINE_MS = 30_000;
const RESPONSE_BYTES = 16_384;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const previewHost = /^[a-z0-9][a-z0-9-]+\.vercel\.app$/;
const BLANK_ENVIRONMENT_KEYS = [
  "EVELYN_EVM04B_DATABASE", "EVELYN_EVM04B_DATABASE_ROLE", "EVELYN_EVM04B_DATABASE_URL",
  "EVELYN_EVM04B_DEPLOYMENT_SCOPE", "EVELYN_EVM04B_NEON_HOST", "EVELYN_EVM04B_QA_ACTOR_ID",
  "EVELYN_EVM04B_VERCEL_PROJECT_ID", "EVELYN_EVM04B_WEBHOOK_SECRET",
  "EVELYN_EVM09A_COMPLIANCE_VERSION", "EVELYN_EVM09A_CREDENTIAL_VERSION", "EVELYN_EVM09A_POLICY_VERSION",
  "EVELYN_PREVIEW_CONFIG", "EVELYN_PREVIEW_DATABASE_URL", "EVELYN_TEST_OWNER_PASSWORD_HASH", "EVELYN_TEST_VIEWER_PASSWORD_HASH",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (body, status = 200) => Response.json(body, { status, headers: {
  "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
} });
class CallerFailure extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
function requireCondition(value, code = "QA_CALLER_DENIED", status = 403) {
  if (!value) throw new CallerFailure(code, status);
}

export function assertPinnedContract(contract) {
  const receiver = new URL(contract.receiverOrigin);
  requireCondition(receiver.protocol === "https:" && receiver.origin === contract.receiverOrigin &&
    previewHost.test(receiver.hostname), "QA_CALLER_CONTRACT_INVALID");
  requireCondition(contract.format === "package4-evelyn-preview-knowledge-caller-v1" &&
    contract.receiverProjectId === "prj_R32Okl6AHijTohvuKmryuTLjWMsk" &&
    contract.callerProjectId === "prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I" &&
    contract.ownerId === "team_sjD78IkSicXJK6TAOR1JC7Wv" &&
    contract.issuer === "https://oidc.vercel.com/novalure" &&
    contract.subject === "owner:novalure:project:evelyn:environment:preview" &&
    contract.environment === "preview" &&
    contract.audience === `urn:novalure:crm:knowledge-qa:${contract.receiverProjectId}:${contract.workspaceId}` &&
    contract.trustedAudience === "https://vercel.com/novalure" &&
    contract.workspaceId === "603df0e3-5b1f-4a9f-a914-e7986a2d3a08" &&
    contract.botId === "4cbc599d-a1f0-42ef-8bcb-9acb72cb02a5" &&
    JSON.stringify(contract.blankEnvironmentKeys) === JSON.stringify(BLANK_ENVIRONMENT_KEYS) &&
    contract.triggerPath === "/api/package4-machine-proof" &&
    typeof contract.query === "string" && contract.query.trim().length > 0 && contract.query.length <= 2000 &&
    typeof contract.expectedExcerptMarker === "string" && contract.expectedExcerptMarker === "09:00" &&
    contract.forbiddenExcerptMarker === "11:00" && uuidV4.test(contract.expectedSourceId) &&
    uuidV4.test(contract.expectedVersionId) && contract.originalPdfProvenance.bytes === 877 &&
    /^[0-9a-f]{64}$/.test(contract.originalPdfProvenance.sha256) &&
    JSON.stringify(contract.channels) === JSON.stringify([
      { channel: "webchat", path: "/api/integrations/knowledge/webchat", maxResults: 5 },
      { channel: "voice", path: "/api/integrations/knowledge/voice", maxResults: 3 },
    ]), "QA_CALLER_CONTRACT_INVALID");
  return contract;
}

async function readBoundedJson(response, signal) {
  const declared = response.headers.get("content-length");
  requireCondition(!declared || (/^\d+$/.test(declared) && Number(declared) <= RESPONSE_BYTES), "QA_CALLER_RESPONSE_TOO_LARGE");
  const reader = response.body?.getReader();
  requireCondition(reader, "QA_CALLER_RESPONSE_INVALID");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      requireCondition(size <= RESPONSE_BYTES, "QA_CALLER_RESPONSE_TOO_LARGE");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(chunks, size);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new CallerFailure("QA_CALLER_RESPONSE_INVALID"); }
}

function verifyOptions(contract, audience) {
  return { algorithms: ["RS256"], issuer: contract.issuer, audience,
    subject: contract.subject, projectId: contract.callerProjectId, ownerId: contract.ownerId,
    environment: "preview", requiredClaims: ["aud", "exp", "iat", "iss", "sub"], typ: "JWT" };
}

function validateClaims(verified, contract, audience, nowSeconds, expectedJti) {
  const p = verified.payload;
  requireCondition(verified.protectedHeader.alg === "RS256" && verified.protectedHeader.typ === "JWT" &&
    typeof verified.protectedHeader.kid === "string" && p.iss === contract.issuer && p.aud === audience &&
    p.sub === contract.subject && p.project_id === contract.callerProjectId && p.owner_id === contract.ownerId &&
    p.environment === "preview" && Number.isSafeInteger(p.iat) && Number.isSafeInteger(p.exp) &&
    p.iat <= nowSeconds + 30 && p.exp > nowSeconds && p.exp > p.iat && p.exp - p.iat <= 43_200 &&
    (!expectedJti || (p.jti === expectedJti && uuidV4.test(p.jti) && Number.isSafeInteger(p.nbf) &&
      p.nbf <= nowSeconds + 30)), "QA_CALLER_WORKLOAD_DENIED");
}

/** Dependency overrides exist only for local tests; the deployed export uses the native SDK. */
export function createCaller({ contract = pinnedContract, env = process.env, getToken = getVercelOidcToken,
  verifyToken = verifyVercelOidcToken, fetchImpl = fetch, now = Date.now, timeoutMs = DEADLINE_MS } = {}) {
  return async (request) => {
    const controller = new AbortController();
    const results = [];
    let at;
    let environmentIsolation;
    let timer;
    try {
      const work = async () => {
        assertPinnedContract(contract);
        requireCondition(env.VERCEL === "1" && env.VERCEL_ENV === "preview" &&
          env.VERCEL_PROJECT_ID === contract.callerProjectId && previewHost.test(env.VERCEL_URL ?? ""));
        const url = new URL(request.url);
        requireCondition(request.method === "POST" && url.origin === `https://${env.VERCEL_URL}` &&
          url.pathname === contract.triggerPath && url.search === "" && url.hash === "", "QA_CALLER_TRIGGER_DENIED", 400);
        const challenge = env.PACKAGE4_QA_CALLER_CHALLENGE ?? "";
        const supplied = request.headers.get("x-package4-qa-challenge") ?? "";
        const expiresAt = Number(env.PACKAGE4_QA_CALLER_EXPIRES_AT);
        const nowSeconds = Math.floor(now() / 1000);
        requireCondition(/^[A-Za-z0-9_-]{43,128}$/.test(challenge) && supplied.length <= 128 &&
          timingSafeEqual(Buffer.from(digest(challenge), "hex"), Buffer.from(digest(supplied), "hex")) &&
          Number.isSafeInteger(expiresAt) && expiresAt > nowSeconds && expiresAt - nowSeconds <= 3600);
        const bodyReader = request.body?.getReader();
        if (bodyReader) {
          try { requireCondition((await bodyReader.read()).done, "QA_CALLER_BODY_DENIED", 400); }
          finally { await bodyReader.cancel().catch(() => {}); }
        }
        controller.signal.throwIfAborted();
        const observedBlankKeyCount = contract.blankEnvironmentKeys.filter((key) => env[key] === "").length;
        environmentIsolation = { expectedBlankKeyCount: BLANK_ENVIRONMENT_KEYS.length, observedBlankKeyCount,
          allBlank: observedBlankKeyCount === BLANK_ENVIRONMENT_KEYS.length };
        requireCondition(environmentIsolation.allBlank, "QA_CALLER_ENVIRONMENT_ISOLATION_DENIED");
        const trusted = await getToken();
        controller.signal.throwIfAborted();
        validateClaims(await verifyToken(trusted, verifyOptions(contract, contract.trustedAudience)),
          contract, contract.trustedAudience, Math.floor(now() / 1000));
        controller.signal.throwIfAborted();
        for (const channel of contract.channels) {
          for (const scenario of ["published-knowledge", "missing-bearer", "default-audience", "wrong-audience"]) {
            at = { channel: channel.channel, scenario };
            let jti;
            try {
              let bearer;
              if (scenario === "default-audience") bearer = trusted;
              else if (scenario !== "missing-bearer") {
                jti = randomUUID();
                const audience = scenario === "wrong-audience" ? `${contract.audience}:denied` : contract.audience;
                bearer = await getToken({ audience, jti, skipCache: true });
                controller.signal.throwIfAborted();
                validateClaims(await verifyToken(bearer, { ...verifyOptions(contract, audience),
                  requiredClaims: ["aud", "exp", "iat", "iss", "jti", "nbf", "sub"] }),
                contract, audience, Math.floor(now() / 1000), jti);
              }
              controller.signal.throwIfAborted();
              const upstream = await fetchImpl(`${contract.receiverOrigin}${channel.path}`, {
                method: "POST", redirect: "error", signal: controller.signal,
                headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), "content-type": "application/json",
                  accept: "application/json", "x-vercel-trusted-oidc-idp-token": trusted },
                body: JSON.stringify({ query: contract.query, maxResults: channel.maxResults }),
              });
              at = { ...at, httpStatus: upstream.status };
              requireCondition(/^application\/json(?:;|$)/i.test(upstream.headers.get("content-type") ?? ""),
                "QA_CALLER_RESPONSE_INVALID");
              const context = await readBoundedJson(upstream, controller.signal);
              const applicationCode = context?.code === "ASSISTANT_ACCESS_DENIED" ? "ASSISTANT_ACCESS_DENIED" : null;
              const common = { ...at, applicationCode, ...(jti ? { jtiSha256: digest(jti) } : {}) };
              if (scenario !== "published-knowledge") {
                const matched = [401, 403].includes(upstream.status) && applicationCode === "ASSISTANT_ACCESS_DENIED";
                results.push({ ...common, matched, expectedDenialMatched: matched });
                continue;
              }
              const excerpts = Array.isArray(context?.excerpts) ? context.excerpts : [];
              const schemaValid = context?.contractVersion === "knowledge-context-v1" && context.answerStatus === "grounded" &&
                context.fallback === null && excerpts.length > 0 && excerpts.length <= channel.maxResults &&
                excerpts.every((excerpt) => excerpt && typeof excerpt.text === "string" && excerpt.text.length <= 600 &&
                  uuidV4.test(excerpt.sourceId) && uuidV4.test(excerpt.versionId) && excerpt.trust === "retrieved_knowledge_data");
              const expectedSourceVersionMatched = schemaValid && excerpts.every((excerpt) =>
                excerpt.sourceId === contract.expectedSourceId && excerpt.versionId === contract.expectedVersionId);
              const uniqueMarkerMatched = schemaValid && excerpts.some((excerpt) => excerpt.text.includes(contract.query));
              const publishedTimeMatched = schemaValid && excerpts.some((excerpt) => excerpt.text.includes(contract.expectedExcerptMarker));
              const draftTimeExcluded = schemaValid && excerpts.every((excerpt) => !excerpt.text.includes(contract.forbiddenExcerptMarker));
              const matched = upstream.status === 200 && schemaValid && expectedSourceVersionMatched &&
                uniqueMarkerMatched && publishedTimeMatched && draftTimeExcluded;
              results.push({ ...common, matched, schemaValid, answerStatus: schemaValid ? "grounded" : null,
                excerptCount: excerpts.length, expectedSourceVersionMatched, uniqueMarkerMatched, publishedTimeMatched,
                draftTimeExcluded, expectedEvidenceMatched: matched,
                sourceVersionSha256: schemaValid ? digest(JSON.stringify(excerpts.map(({ sourceId, versionId }) => ({ sourceId, versionId })))) : null });
            } catch (error) {
              controller.signal.throwIfAborted();
              results.push({ ...at, matched: false, code: error instanceof CallerFailure ? error.code : "QA_CALLER_FAILED",
                ...(jti ? { jtiSha256: digest(jti) } : {}) });
            }
          }
        }
        return json({ format: contract.format, status: results.length === 8 && results.every((result) => result.matched) ? "PASS" : "FAIL", workload: {
          issuer: contract.issuer, audience: contract.audience, subject: contract.subject,
          environment: "preview", projectId: contract.callerProjectId, ownerId: contract.ownerId,
        }, environmentIsolation, results });
      };
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new CallerFailure("QA_CALLER_DEADLINE", 504));
      }, timeoutMs); });
      return await Promise.race([work(), deadline]);
    } catch (error) {
      return json({ status: "FAIL", code: error instanceof CallerFailure ? error.code : "QA_CALLER_FAILED",
        ...(at ? { at } : {}), ...(environmentIsolation ? { environmentIsolation } : {}), results },
        error instanceof CallerFailure ? error.status : 502);
    } finally { clearTimeout(timer); controller.abort(); }
  };
}

export const caller = createCaller();
