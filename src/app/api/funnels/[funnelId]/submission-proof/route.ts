import { consumePublicSubmissionRateLimits } from "@/lib/db/public-submission-abuse-repository";
import { getStoredFunnelPublicationRevision, getStoredFunnelSubmissionScopeResourceId, isStoredFunnelPubliclyLive } from "@/lib/funnel-public-access";
import {
  funnelRuntimeRequestBodyLimits,
  parseFunnelProofRefreshRequest,
} from "@/lib/funnel-runtime-contract";
import { createPublicFunnelProofRefreshRateLimitPolicies } from "@/lib/funnel-runtime-security";
import { runFunnelLivePreflight } from "@/lib/funnel-live-preflight";
import { getStoredFunnel } from "@/lib/funnel-store";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import {
  buildPublicSubmissionScope,
  getTrustedPublicSubmissionClientIp,
  publicSubmissionActions,
  publicSubmissionProofRefreshGraceSeconds,
  publicSubmissionProofTtlSeconds,
  PublicSubmissionRequestError,
  readBoundedPublicSubmissionJson,
  refreshPublicSubmissionProof,
} from "@/lib/security/public-submission-abuse";

type RouteContext = {
  params: Promise<{ funnelId: string }>;
};

const responseHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200) {
  return Response.json(body, { headers: responseHeaders, status });
}

function stalePublicationResponse() {
  return json({ error: "funnel_publication_stale", reloadRequired: true }, 409);
}

export async function POST(request: Request, context: RouteContext) {
  const launchScope = evaluateLaunchScope("publicFunnelProofRefresh");
  if (!launchScope.allowed) {
    return json({ code: launchScope.code, error: "submission_proof_refresh_launch_off" }, 503);
  }

  const { funnelId } = await context.params;
  let parsedRequest: Awaited<ReturnType<typeof readBoundedPublicSubmissionJson>>;
  try {
    parsedRequest = await readBoundedPublicSubmissionJson(
      request,
      funnelRuntimeRequestBodyLimits,
    );
  } catch (error) {
    if (error instanceof PublicSubmissionRequestError) {
      return json({ error: error.code }, error.status);
    }
    return json({ error: "submission_proof_refresh_unavailable" }, 503);
  }

  const refreshRequest = parseFunnelProofRefreshRequest(parsedRequest.value);
  if (!refreshRequest) return json({ error: "invalid_submission_proof_refresh" }, 400);

  const clientIp = getTrustedPublicSubmissionClientIp(request.headers);
  if (!clientIp) return json({ error: "submission_proof_refresh_unavailable" }, 503);
  try {
    const rateLimit = await consumePublicSubmissionRateLimits({
      policies: createPublicFunnelProofRefreshRateLimitPolicies({
        clientIp,
        idempotencyKey: refreshRequest.proof.idempotencyKey,
      }),
    });
    if (!rateLimit.allowed) return json({ error: "rate_limited" }, 429);
  } catch {
    return json({ error: "submission_proof_refresh_unavailable" }, 503);
  }

  let stored: Awaited<ReturnType<typeof getStoredFunnel>>;
  try {
    stored = await getStoredFunnel(funnelId);
  } catch {
    return json({ error: "submission_proof_refresh_unavailable" }, 503);
  }
  if (!stored?.funnelId || !stored.workspaceId) {
    return json({ error: "funnel_not_found" }, 404);
  }
  if (!isStoredFunnelPubliclyLive({ blueprint: stored.blueprint, stored })) {
    return json({ error: "funnel_not_published" }, 403);
  }
  const preflight = runFunnelLivePreflight(stored.blueprint);
  if (!preflight.ok) return json({ error: "funnel_live_preflight_blocked" }, 403);

  const publicationRevision = getStoredFunnelPublicationRevision(stored.tracking);
  if (refreshRequest.publicationRevision !== publicationRevision) {
    return stalePublicationResponse();
  }

  try {
    const refreshed = refreshPublicSubmissionProof({
      action: publicSubmissionActions.funnel,
      proof: refreshRequest.proof,
      scope: buildPublicSubmissionScope({
        resourceId: getStoredFunnelSubmissionScopeResourceId({
          funnelId: stored.funnelId,
          storedTracking: stored.tracking,
        }),
        resourceType: "funnel",
        workspaceId: stored.workspaceId,
      }),
    });
    if (!refreshed.ok) return json({ error: refreshed.reason }, 400);

    return json({
      proof: refreshed.proof,
      publicationRevision,
      refreshGraceSeconds: publicSubmissionProofRefreshGraceSeconds,
      ttlSeconds: publicSubmissionProofTtlSeconds,
    });
  } catch {
    return json({ error: "submission_proof_refresh_unavailable" }, 503);
  }
}
