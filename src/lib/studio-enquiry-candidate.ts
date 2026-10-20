const candidateOrigin = "http://127.0.0.1:3000";
const candidateRef = "refs/heads/codex/evelyn-crm-package4-integration";
const candidateWorkflow = `novalure/novalure-crm/.github/workflows/livegang-e2e.yml@${candidateRef}`;
const enquiryPath = "/api/public/website-sales/enquiry";

export type StudioEnquiryCandidateBinding = {
  host: string; name: string; role: string; project: string; branch: string;
};

function cleanUrl(value: string | undefined) {
  return value?.trim().replace(/^['"]|['"]$/g, "") || "";
}

function neonHost(value: string | undefined) {
  return value !== undefined && value === value.trim().toLowerCase() &&
    /^ep-[a-z0-9-]+\.(?:[a-z0-9-]+\.)+neon\.tech$/.test(value) ? value : null;
}

/** A local Actions-only test profile; these environment checks are not signed caller identity. */
export function studioEnquiryCandidateBinding(env: NodeJS.ProcessEnv = process.env): StudioEnquiryCandidateBinding | null {
  if (env.STUDIO_ENQUIRY_CANDIDATE_ENABLED !== "1" || env.NOVALURE_QA_PROFILE !== "isolated-candidate" ||
      env.CI !== "true" || env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== "novalure/novalure-crm" || env.GITHUB_WORKFLOW_REF !== candidateWorkflow ||
      env.GITHUB_REF !== candidateRef || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || "") ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || "") || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT || "") ||
      Object.keys(env).some(key => key === "VERCEL" || key.startsWith("VERCEL_")) ||
      env.NOVALURE_APP_ORIGIN !== candidateOrigin || env.NOVALURE_QA_BASE_URL !== candidateOrigin ||
      env.NOVALURE_QA_RUN_PREFIX !== `GOLIVETEST_${env.GITHUB_RUN_ID}_${env.GITHUB_RUN_ATTEMPT}`) return null;

  const host = neonHost(env.NOVALURE_QA_DATABASE_HOST);
  const productionHost = neonHost(env.NOVALURE_PRODUCTION_DATABASE_HOST);
  const productionDirect = neonHost(env.NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST);
  const name = env.NOVALURE_QA_DATABASE_NAME, role = env.NOVALURE_QA_DATABASE_ROLE;
  const project = env.NOVALURE_QA_PROJECT_ID, branch = env.NOVALURE_QA_BRANCH_ID;
  const secret = env.STUDIO_ENQUIRY_SIGNING_SECRET;
  if (!host?.includes("-pooler.") || !productionHost?.includes("-pooler.") || !productionDirect ||
      productionHost.replace("-pooler.", ".") !== productionDirect || host === productionHost ||
      host.replace("-pooler.", ".") === productionDirect || name !== "neondb" || role !== "novalure_app" ||
      !project || !/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(project) || project === "misty-cloud-70835427" ||
      !branch || !/^br-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(branch) || branch === "br-snowy-fog-aldx77v8" ||
      !secret || secret !== secret.trim() || Buffer.byteLength(secret) < 32) return null;
  const ownerHost = env.NOVALURE_QA_MIGRATION_DATABASE_HOST;
  if (ownerHost !== undefined && neonHost(ownerHost) !== host.replace("-pooler.", ".")) return null;

  const databaseUrl = cleanUrl(env.DATABASE_URL);
  if (!databaseUrl || databaseUrl !== cleanUrl(env.NOVALURE_QA_DATABASE_URL)) return null;
  try {
    const url = new URL(databaseUrl);
    if (!/^postgres(?:ql)?:$/.test(url.protocol) || url.hostname !== host || (url.port && url.port !== "5432") ||
        decodeURIComponent(url.username) !== role || !url.password || decodeURIComponent(url.pathname.slice(1)) !== name ||
        url.hash || [...url.searchParams.keys()].some(key => !["sslmode", "channel_binding"].includes(key)) ||
        url.searchParams.getAll("sslmode").length !== 1 || !["require", "verify-full"].includes(url.searchParams.get("sslmode") || "") ||
        url.searchParams.getAll("channel_binding").length > 1 ||
        (url.searchParams.has("channel_binding") && url.searchParams.get("channel_binding") !== "require")) return null;
    const emails: unknown = JSON.parse(env.STUDIO_ENQUIRY_QA_EMAILS_JSON || "");
    const phones: unknown = JSON.parse(env.STUDIO_ENQUIRY_QA_PHONES_JSON || "");
    const expectedEmail = `studio-candidate-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}@example.invalid`;
    if (expectedEmail.length > 254 || !Array.isArray(emails) || emails.length !== 1 || emails[0] !== expectedEmail ||
        !Array.isArray(phones) || phones.length !== 0) return null;
  } catch { return null; }
  return { host, name, role, project, branch };
}

export function studioEnquiryCandidateRequestAllowed(request: Pick<Request, "url" | "method">,
  env: NodeJS.ProcessEnv = process.env) {
  if (request.method !== "POST" || !studioEnquiryCandidateBinding(env)) return false;
  try {
    const url = new URL(request.url);
    return url.origin === candidateOrigin && url.pathname === enquiryPath &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
