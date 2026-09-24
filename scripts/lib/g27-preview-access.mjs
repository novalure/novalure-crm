// Only the two authorized G27 projects may receive a process-only access token.
export function previewAccessHeaders(token, now = Date.now(), projectId = "prj_R32Okl6AHijTohvuKmryuTLjWMsk") {
  if (!["prj_R32Okl6AHijTohvuKmryuTLjWMsk", "prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I"].includes(projectId)
    || typeof token !== "string") throw new Error("PREVIEW_ACCESS_REQUIRED");
  const claim = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  if (claim.project_id !== projectId || claim.owner_id !== "team_sjD78IkSicXJK6TAOR1JC7Wv"
    || claim.environment !== "development" || !Number.isFinite(claim.exp) || claim.exp * 1000 <= now) {
    throw new Error("PREVIEW_ACCESS_BINDING_FAILED");
  }
  return { "x-vercel-trusted-oidc-idp-token": token };
}

export const crmBrowserOrigin = "https://novalure-crm-git-codex-crm-production-readiness-g27-novalure.vercel.app";

// Authentication uses the configured branch origin. Independently resolve it
// before every browser write; never substitute an alias for the immutable pin.
export async function verifyCrmBrowserBinding(section) {
  const response = await fetch(`https://api.vercel.com/v13/deployments/${new URL(crmBrowserOrigin).hostname}?teamId=team_sjD78IkSicXJK6TAOR1JC7Wv`, {
    headers: { authorization: `Bearer ${process.env.G27_VERCEL_API_TOKEN}` },
    redirect: "error", signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("CRM_BROWSER_BINDING_LOOKUP_FAILED");
  const raw = await response.json();
  if (raw.id !== section.deploymentId || raw.url !== new URL(section.url).hostname
    || (raw.projectId ?? raw.project?.id) !== "prj_R32Okl6AHijTohvuKmryuTLjWMsk"
    || (raw.team?.id ?? raw.teamId) !== "team_sjD78IkSicXJK6TAOR1JC7Wv"
    || raw.meta?.githubCommitSha !== section.commitSha
    || raw.meta?.githubCommitRef !== "codex/crm-production-readiness-g27"
    || raw.readyState !== "READY" || raw.target === "production") {
    throw new Error("CRM_BROWSER_BINDING_MISMATCH");
  }
  return crmBrowserOrigin;
}
