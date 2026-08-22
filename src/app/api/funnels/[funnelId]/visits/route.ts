import { consumePublicSubmissionRateLimits } from "@/lib/db/public-submission-abuse-repository";
import { recordPublicFunnelVisit } from "@/lib/db/funnel-visit-repository";
import {
  getStoredFunnelPublicationRevision,
  getStoredFunnelSubmissionScopeResourceId,
  isStoredFunnelPubliclyLive,
} from "@/lib/funnel-public-access";
import {
  funnelRuntimeRequestBodyLimits,
  parseFunnelVisitRequest,
} from "@/lib/funnel-runtime-contract";
import {
  createPublicFunnelVisitIdHash,
  createPublicFunnelVisitRateLimitPolicies,
} from "@/lib/funnel-runtime-security";
import { runFunnelLivePreflight } from "@/lib/funnel-live-preflight";
import { getStoredFunnel } from "@/lib/funnel-store";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import {
  buildPublicSubmissionScope,
  getTrustedPublicSubmissionClientIp,
  publicSubmissionActions,
  PublicSubmissionRequestError,
  readBoundedPublicSubmissionJson,
  verifyPublicSubmissionProof,
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
  const launchScope = evaluateLaunchScope("publicFunnelVisit");
  if (!launchScope.allowed) {
    return json({ code: launchScope.code, error: "funnel_visit_launch_off" }, 503);
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
    return json({ error: "funnel_visit_unavailable" }, 503);
  }

  const visitRequest = parseFunnelVisitRequest(parsedRequest.value);
  if (!visitRequest) return json({ error: "invalid_funnel_visit" }, 400);

  let stored: Awaited<ReturnType<typeof getStoredFunnel>>;
  try {
    stored = await getStoredFunnel(funnelId);
  } catch {
    return json({ error: "funnel_visit_unavailable" }, 503);
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
  if (visitRequest.publicationRevision !== publicationRevision) {
    return stalePublicationResponse();
  }

  let scope: string;
  try {
    scope = buildPublicSubmissionScope({
      resourceId: getStoredFunnelSubmissionScopeResourceId({
        funnelId: stored.funnelId,
        storedTracking: stored.tracking,
      }),
      resourceType: "funnel",
      workspaceId: stored.workspaceId,
    });
    const proofValidation = verifyPublicSubmissionProof({
      action: publicSubmissionActions.funnel,
      proof: visitRequest.proof,
      scope,
    });
    if (!proofValidation.ok) return json({ error: proofValidation.reason }, 400);
  } catch {
    return json({ error: "funnel_visit_unavailable" }, 503);
  }

  const clientIp = getTrustedPublicSubmissionClientIp(request.headers);
  if (!clientIp) return json({ error: "funnel_visit_unavailable" }, 503);

  try {
    const rateLimit = await consumePublicSubmissionRateLimits({
      policies: createPublicFunnelVisitRateLimitPolicies({
        clientIp,
        scope,
        visitId: visitRequest.visitId,
      }),
    });
    if (!rateLimit.allowed) return json({ error: "rate_limited" }, 429);

    const result = await recordPublicFunnelVisit({
      funnelId: stored.funnelId,
      publicationRevision,
      visitIdHash: createPublicFunnelVisitIdHash({
        scope,
        visitId: visitRequest.visitId,
      }),
      workspaceId: stored.workspaceId,
    });
    if (!result.accepted) return stalePublicationResponse();

    return json({ counted: result.counted, ok: true });
  } catch {
    const response = json({ error: "funnel_visit_unavailable" }, 503);
    response.headers.set("Retry-After", "5");
    return response;
  }
}
