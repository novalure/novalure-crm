import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vercelDeploymentEvidence } from "./qa-g27-live-preview.mjs";
import { previewAccessHeaders } from "./lib/g27-preview-access.mjs";
export { previewAccessHeaders } from "./lib/g27-preview-access.mjs";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export function exactProbeResults(results) {
  const expected = [["control", 400, "INVALID_INPUT"], ["foreign", 401, "SERVICE_AUTH_DENIED"]];
  return Array.isArray(results) && results.length === 2 && results.every((item, index) =>
    item.name === expected[index][0] && item.status === expected[index][1] && item.code === expected[index][2]
    && item.json === true && item.noStore === true && item.noCookie === true && item.pass === true);
}

// Metadata-only Vercel access must be supplied in the current process. The
// existing synthetic Preview signing material never leaves memory.
async function main() {
  const [origin, deploymentId, commitSha, consent] = process.argv.slice(2);
  if (consent !== "--run-authorized-preview-probe" || !/^https:\/\/novalure-[a-z0-9]+-novalure\.vercel\.app$/.test(origin ?? "")
    || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId ?? "") || !/^[a-f0-9]{40}$/.test(commitSha ?? "")) throw new Error();
  const evidence = await vercelDeploymentEvidence("CRM", { teamId: "team_sjD78IkSicXJK6TAOR1JC7Wv" }, origin,
    { crmDeploymentId: deploymentId, crmCommitSha: commitSha, crmVercelProjectId: "prj_R32Okl6AHijTohvuKmryuTLjWMsk" });
  const accessHeaders = previewAccessHeaders(process.env.VERCEL_OIDC_TOKEN);
  const secrets = JSON.parse(await readFile(path.join(projectRoot, ".npm-cache/g27/preview-secrets-private.json"), "utf8"));
  const secret = secrets.NOVALURE_SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) throw new Error();
  const timestamp = String(Date.now()), nonce = randomUUID();
  const context = "novalure:g27:preview-isolation-probe:v1";
  const key = Buffer.from(hkdfSync("sha256", secret, context, "request-authentication", 32));
  const signature = createHmac("sha256", key).update(`${context}\n${timestamp}\n${nonce}\n${commitSha}`).digest("hex");
  key.fill(0);
  const response = await fetch(`${origin}/api/qa/g27-isolation`, { method: "POST", redirect: "error",
    headers: { ...accessHeaders, "x-g27-time": timestamp, "x-g27-nonce": nonce, "x-g27-signature": signature },
    signal: AbortSignal.timeout(60_000) });
  const json = response.headers.get("content-type")?.includes("application/json") === true;
  const noStore = response.headers.get("cache-control")?.includes("no-store") === true;
  const noCookie = !response.headers.has("set-cookie");
  const raw = json ? await response.json() : {};
  const results = Array.isArray(raw.results) ? raw.results.map(item => ({
    name: ["control", "foreign"].includes(item.name) ? item.name : "UNEXPECTED",
    status: Number.isInteger(item.status) ? item.status : null,
    code: ["INVALID_INPUT", "SERVICE_AUTH_DENIED"].includes(item.code) ? item.code : "UNEXPECTED_CODE",
    json: item.json === true, noStore: item.noStore === true, noCookie: item.noCookie === true, pass: item.pass === true,
  })) : [];
  const pass = response.status === 200 && json && noStore && noCookie && raw.status === "PASS"
    && exactProbeResults(results);
  const report = { status: pass ? "PASS_PENDING_DATABASE_AFTER_SNAPSHOT" : "BLOCKED", crm: evidence,
    code: ["BODY_DENIED", "NOT_FOUND", "ISOLATION_PROBE_FAILED"].includes(raw.code) ? raw.code : null,
    requestId: /^[A-Za-z0-9:_-]{1,160}$/.test(response.headers.get("x-vercel-id") ?? "") ? response.headers.get("x-vercel-id") : null,
    endpointStatus: response.status, json, noStore, noCookie, results, productionImpact: "NONE",
    remoteDatabaseAfterSnapshot: "REQUIRED", at: new Date().toISOString() };
  await writeFile(path.join(projectRoot, ".npm-cache/g27/isolation-probe-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!pass) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => { console.error("G27_ISOLATION_PROBE_BLOCKED_NO_SECRET_OUTPUT"); process.exitCode = 1; });
}
