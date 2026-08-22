import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  getFunnelPublishTokenStatusResponse,
  privateJson,
  rotateFunnelPublishTokenResponse,
} from "@/lib/funnel-publish-token-http";
import { evaluateLaunchScope } from "@/lib/launch-scope";

type RouteContext = {
  params: Promise<{ funnelId: string }>;
};

async function authorize(request: Request) {
  const auth = await requirePermissionAndProductCapability(
    request,
    "funnels:write",
    "funnels:publish",
  );
  if (!auth.ok) return auth;

  const launchScope = evaluateLaunchScope(
    "funnelPublishTokenInternalCutover",
    auth.session,
  );
  if (!launchScope.allowed) {
    return {
      ok: false as const,
      response: privateJson({ error: launchScope.code }, 403),
    };
  }
  return auth;
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const { funnelId } = await context.params;
  return getFunnelPublishTokenStatusResponse({ funnelId, session: auth.session });
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const { funnelId } = await context.params;
  return rotateFunnelPublishTokenResponse({
    funnelId,
    request,
    session: auth.session,
  });
}
