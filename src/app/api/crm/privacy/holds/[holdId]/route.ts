import { NextResponse } from "next/server";
import { assertUuid, parseIdempotencyKey } from "@/lib/content-library";
import { releaseLegalHold } from "@/lib/db/privacy-lifecycle-repository";
import { parseLegalHoldRelease } from "@/lib/privacy-lifecycle";
import { resolvePrivacyScopedSession } from "../../_shared";
import { contentRouteError, readObjectBody } from "../../../documents/_shared";

type RouteContext = { params: Promise<{ holdId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await resolvePrivacyScopedSession(request);
  if (!auth.ok) return auth.response;
  try {
    const { holdId } = await context.params;
    const body = await readObjectBody(request);
    const release = parseLegalHoldRelease(body.hold ?? body);
    const result = await releaseLegalHold({
      session: auth.session,
      idempotencyKey: parseIdempotencyKey(request),
      holdId: assertUuid(holdId, "holdId"),
      ...release,
    });
    return NextResponse.json({ ...result, persisted: true });
  } catch (error) {
    return contentRouteError(error);
  }
}
