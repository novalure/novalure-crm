import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  privateJson,
  rotateFunnelPublishTokenResponse,
} from "@/lib/funnel-publish-token-http";
import { evaluateLaunchScope } from "@/lib/launch-scope";

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

  const { funnelId } = await context.params;
  return rotateFunnelPublishTokenResponse({
    funnelId,
    request,
    session: auth.session,
  });
}
