import { NextResponse } from "next/server";
import { assertUuid, parseIdempotencyKey } from "@/lib/content-library";
import { decideRetentionReview } from "@/lib/db/privacy-lifecycle-repository";
import { parseRetentionReviewDecision } from "@/lib/privacy-lifecycle";
import { resolvePrivacyScopedSession } from "../../_shared";
import { contentRouteError, readObjectBody } from "../../../documents/_shared";

type RouteContext = { params: Promise<{ reviewId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await resolvePrivacyScopedSession(request);
  if (!auth.ok) return auth.response;
  try {
    const { reviewId } = await context.params;
    const body = await readObjectBody(request);
    const decision = parseRetentionReviewDecision(body.review ?? body);
    const result = await decideRetentionReview({
      session: auth.session,
      idempotencyKey: parseIdempotencyKey(request),
      reviewId: assertUuid(reviewId, "reviewId"),
      ...decision,
    });
    return NextResponse.json({ ...result, persisted: true });
  } catch (error) {
    return contentRouteError(error);
  }
}
