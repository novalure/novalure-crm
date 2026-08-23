import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  privateJson,
  rotateFunnelPublishTokenResponse,
} from "@/lib/funnel-publish-token-http";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import {
  qaBatchRuntimeErrorResponse,
  readQaBatchMutationHeader,
} from "@/lib/qa-batch-runtime";

type RouteContext = {
  params: Promise<{ funnelId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await requirePermissionAndProductCapability(
    request,
    "funnels:write",
    "funnels:publish",
  );
  if (!auth.ok) return auth.response;

  const launchScope = evaluateLaunchScope("funnelPublishTokenRotation", auth.session);
  if (!launchScope.allowed) {
    return privateJson({ error: launchScope.code }, 403);
  }

  let qaBatchId: string | null;
  try {
    qaBatchId = readQaBatchMutationHeader(request, auth.session);
  } catch (error) {
    return qaBatchRuntimeErrorResponse(error)
      ?? privateJson({ error: "FUNNEL_PUBLICATION_ROTATION_UNAVAILABLE" }, 503);
  }

  const { funnelId } = await context.params;
  return rotateFunnelPublishTokenResponse({
    funnelId,
    qaBatchId: qaBatchId ?? undefined,
    request,
    session: auth.session,
  });
}
