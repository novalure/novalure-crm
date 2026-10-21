import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const studioEnquiryVersion = "studio-enquiry-v1";
export const studioSnapshotVersion = "studio-enquiry-snapshot-v1";
export const studioEnquiryPolicy = "studio-enquiry-2026-10-18";
export const studioEnquiryPublicPolicy = "studio-enquiry-2026-10-19";
export const studioEnquiryMaxBodyBytes = 256_000;
export const studioEnquiryMaxFileBytes = 10_000_000;
export const studioEnquiryProject = "prj_R32Okl6AHijTohvuKmryuTLjWMsk";
export const studioEnquiryBranch = "codex/studio-preview-crm-handoff";
export const studioEnquiryProductionOrigin = "https://www.novalure-crm.app";
export const studioEnquiryStudioOrigin = "https://novalurestudio.ie";
export const studioEnquiryStudioProject = "prj_ktiCTisS9QmWy4vkHLO8HG3BrhQp";
export const studioEnquiryCrmProject = "f7d83c6b-d08d-4d73-b822-1f1c0b4733d2";

/** A private candidate may use only this deployment's own platform-issued host. */
export function studioEnquiryRequestOriginAllowed(request: Pick<Request,"url"|"headers">,
  env: NodeJS.ProcessEnv = process.env) {
  let origin: string;
  try { origin=new URL(request.url).origin; } catch { return false; }
  if (origin===studioEnquiryProductionOrigin) return true;
  const host=env.VERCEL_URL, secret=env.STUDIO_PUBLIC_CANARY_SECRET;
  if (!host || !/^[a-z0-9][a-z0-9.-]*\.vercel\.app$/.test(host) || origin!==`https://${host}` ||
      !secret || Buffer.byteLength(secret)<32) return false;
  const supplied=request.headers.get("x-studio-canary-authorization");
  if (!supplied || supplied.length>1024) return false;
  const expected=Buffer.from(secret),actual=Buffer.from(supplied);
  return expected.length===actual.length && timingSafeEqual(expected,actual);
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const limits: Record<string, number> = {
  goals: 800, projectType: 40, existingUrl: 300, company: 300, industry: 300,
  audience: 300, pages: 300, functions: 300, languages: 300, assets: 300,
  timeline: 300, budget: 300, name: 300, email: 254, phone: 100,
  contactMethod: 20, appointmentKind: 20,
};
const enumValues: Record<string, string[]> = {
  projectType: ["new", "redesign", "unsure"], contactMethod: ["email", "phone"], appointmentKind: ["phone", "teams"],
};
export type StudioAnalysis = { status: "read" | "partial"; summary: string; extractedText: string; limitations: string[] };
export type StudioEnquiryFile = {
  id: string; conversationId: string; name: string; mime: "application/pdf" | "image/webp";
  bytes: number; sha256: string; originalSha256: string; analysis: StudioAnalysis;
  original: { mime: "application/pdf" | "image/jpeg" | "image/png" | "image/webp"; bytes: number; sha256: string };
};
export type StudioEnquiryWebsite = StudioAnalysis & {
  id: string; conversationId: string; domain: string; url: string; sources: string[];
};
export type StudioEnquirySnapshot = {
  schemaVersion: typeof studioSnapshotVersion; conversationId: string; confirmedAt: string;
  consent: { privacy: true; policyVersion: typeof studioEnquiryPolicy | typeof studioEnquiryPublicPolicy };
  brief: { values: Record<string, string>; summary: string; openQuestions: string[] };
  files: StudioEnquiryFile[]; websites: StudioEnquiryWebsite[]; syntheticTest: boolean;
};
export type StudioEnquiryRequest = {
  version: typeof studioEnquiryVersion; action: "reserve" | "status" | "finalize";
  operationId: string; revision: number; payloadHash: string; snapshot: StudioEnquirySnapshot;
};
export class StudioEnquiryError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
}
export const studioEnquiryHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
function keys(v: Record<string, unknown>, expected: string[]) {
  return Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
}
function text(v: unknown, maximum: number, empty = false): v is string {
  return typeof v === "string" && v.length <= maximum && (empty || v.trim().length > 0) && !v.includes("\0");
}
function strings(v: unknown, count: number, maximum: number) {
  return Array.isArray(v) && v.length <= count && v.every(x => text(x, maximum));
}
function publicSource(v: unknown): v is string {
  if (!text(v, 2048)) return false;
  try { const u = new URL(v); return u.protocol === "https:" && Boolean(u.hostname) && !u.username && !u.password && !u.port; }
  catch { return false; }
}
function analysis(v: unknown, summaryMaximum: number, textMaximum: number) {
  return object(v) && keys(v, ["status", "summary", "extractedText", "limitations"]) &&
    ["read", "partial"].includes(String(v.status)) && text(v.summary, summaryMaximum) &&
    text(v.extractedText, textMaximum, true) && strings(v.limitations, 30, 1200);
}
/** Validate without rewriting, trimming or translating confirmed customer material. */
export function parseStudioEnquiryRequest(v: unknown): StudioEnquiryRequest {
  const fail = () => { throw new StudioEnquiryError("invalid_enquiry"); };
  if (!object(v) || !keys(v, ["version", "action", "operationId", "revision", "payloadHash", "snapshot"]) ||
      v.version !== studioEnquiryVersion || !["reserve", "status", "finalize"].includes(String(v.action)) ||
      typeof v.operationId !== "string" || !uuid.test(v.operationId) || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 ||
      typeof v.payloadHash !== "string" || !hash.test(v.payloadHash) || !object(v.snapshot)) return fail();
  const s = v.snapshot;
  if (!keys(s, ["schemaVersion", "conversationId", "confirmedAt", "consent", "brief", "files", "websites", "syntheticTest"]) ||
      s.schemaVersion !== studioSnapshotVersion || typeof s.conversationId !== "string" || !uuid.test(s.conversationId) ||
      typeof s.confirmedAt !== "string" || !Number.isFinite(Date.parse(s.confirmedAt)) ||
      new Date(s.confirmedAt).toISOString() !== s.confirmedAt || Date.parse(s.confirmedAt) > Date.now() + 5000 ||
      typeof s.syntheticTest !== "boolean" || !object(s.consent) || !keys(s.consent, ["privacy", "policyVersion"]) ||
      s.consent.privacy !== true || ![studioEnquiryPolicy,studioEnquiryPublicPolicy].includes(String(s.consent.policyVersion)) || !object(s.brief)) return fail();
  const b = s.brief;
  if (!keys(b, ["values", "summary", "openQuestions"]) || !object(b.values) || !text(b.summary, 10_000) ||
      !strings(b.openQuestions, 8, 500) || Object.entries(b.values).some(([k, value]) =>
        !Object.hasOwn(limits, k) || !text(value, limits[k], true) || (value && enumValues[k] && !enumValues[k].includes(value)))) return fail();
  if (!Array.isArray(s.files) || s.files.length > 3 || !Array.isArray(s.websites) || s.websites.length > 2) return fail();
  const ids: string[] = [];
  for (const f of s.files) {
    if (!object(f) || !keys(f, ["id", "conversationId", "name", "mime", "bytes", "sha256", "originalSha256", "original", "analysis"]) ||
        typeof f.id !== "string" || !uuid.test(f.id) || f.conversationId !== s.conversationId || !text(f.name, 120) ||
        /[\\/\r\n]/.test(f.name) || !["application/pdf", "image/webp"].includes(String(f.mime)) ||
        !Number.isSafeInteger(f.bytes) || Number(f.bytes) < 1 || Number(f.bytes) > studioEnquiryMaxFileBytes ||
        typeof f.sha256 !== "string" || !hash.test(f.sha256) || typeof f.originalSha256 !== "string" || !hash.test(f.originalSha256) ||
        !analysis(f.analysis, 1600, 6000) || !object(f.original) || !keys(f.original, ["mime", "bytes", "sha256"]) ||
        !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(String(f.original.mime)) ||
        !Number.isSafeInteger(f.original.bytes) || Number(f.original.bytes) < 1 || Number(f.original.bytes) > studioEnquiryMaxFileBytes ||
        f.original.sha256 !== f.originalSha256) return fail();
    ids.push(f.id.toLowerCase());
  }
  for (const w of s.websites) {
    if (!object(w) || !keys(w, ["id", "conversationId", "domain", "url", "status", "sources", "summary", "extractedText", "limitations"]) ||
        typeof w.id !== "string" || !uuid.test(w.id) || w.conversationId !== s.conversationId || !text(w.domain, 253) ||
        !publicSource(w.url) || new URL(w.url).hostname !== w.domain || !Array.isArray(w.sources) ||
        w.sources.length < 1 || w.sources.length > 2 || w.sources.some(u => !publicSource(u) || new URL(String(u)).origin !== new URL(String(w.url)).origin) ||
        !["read", "partial"].includes(String(w.status)) || !text(w.summary, 1200) || !text(w.extractedText, 10_000) ||
        !strings(w.limitations, 30, 1200)) return fail();
    ids.push(w.id.toLowerCase());
  }
  if (new Set(ids).size !== ids.length || studioEnquiryHash(JSON.stringify(s)) !== v.payloadHash) return fail();
  if (b.values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(String(b.values.email))) return fail();
  if (b.values.phone && !/^\+?[0-9 ()\-./]{5,100}$/.test(String(b.values.phone))) return fail();
  const method = String(b.values.contactMethod || (b.values.email ? "email" : b.values.phone ? "phone" : ""));
  if (!method || !b.values[method]) throw new StudioEnquiryError("contact_required");
  return v as StudioEnquiryRequest;
}
export function buildStudioEnquirySignature(body: string, timestamp: string, secret: string) {
  return createHmac("sha256", secret).update(`${studioEnquiryVersion}.${timestamp}.${body}`, "utf8").digest("base64url");
}
export function verifyStudioEnquirySignature(body: string, timestamp: string | null, signature: string | null, secret: string | undefined) {
  if (!secret || Buffer.byteLength(secret) < 32 || !timestamp || !/^\d{10,11}$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !signature || signature.length > 128) return false;
  const expected = Buffer.from(buildStudioEnquirySignature(body, timestamp, secret));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function studioEnquiryRecipientsAllowed(snapshot: StudioEnquirySnapshot, env: NodeJS.ProcessEnv = process.env) {
  const parse = (key: string): string[] | null => {
    try { const v: unknown = JSON.parse(env[key] || ""); return Array.isArray(v) && v.length <= 20 &&
      v.every(x => typeof x === "string" && x.length > 0 && x.length <= 254) ? v : null; } catch { return null; }
  };
  const emails = parse("STUDIO_ENQUIRY_QA_EMAILS_JSON"), phones = parse("STUDIO_ENQUIRY_QA_PHONES_JSON");
  const values = snapshot.brief.values;
  return snapshot.syntheticTest === true && emails !== null && phones !== null && (!values.email || emails.includes(values.email.toLowerCase())) &&
    (!values.phone || phones.includes(values.phone));
}

/** Same existing Studio proof contract; a public snapshot flag is never test authority. */
export function verifyStudioSyntheticTestProof(request: StudioEnquiryRequest, proof: string | null,
  env: NodeJS.ProcessEnv = process.env) {
  const email = request.snapshot.brief.values.email?.trim().toLowerCase();
  const testEmail = env.NOVALURE_STUDIO_SYNTHETIC_TEST_EMAIL?.trim().toLowerCase();
  const secret = env.STUDIO_ENQUIRY_SIGNING_SECRET;
  if (!request.snapshot.syntheticTest || !email || email !== testEmail || !secret || Buffer.byteLength(secret) < 32 || !proof) return false;
  const match = /^([0-9]{10,11})\.([A-Za-z0-9_-]{43})$/.exec(proof);
  if (!match || Math.abs(Math.floor(Date.now() / 1000) - Number(match[1])) > 300) return false;
  const signature = createHmac("sha256", secret)
    .update(`novalure-studio-synthetic-test-v1.${match[1]}.${request.operationId}.${email.trim().toLowerCase()}`, "utf8")
    .digest("base64url");
  const expected = Buffer.from(`${match[1]}.${signature}`), actual = Buffer.from(proof);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
