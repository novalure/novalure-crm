import { NextResponse } from "next/server";
import { assertUuid, parseIdempotencyKey } from "@/lib/content-library";
import {
  getDataSubjectRequest,
  updateDataSubjectRequest,
} from "@/lib/db/privacy-lifecycle-repository";
import { parseDataSubjectRequestUpdate } from "@/lib/privacy-lifecycle";
import { resolvePrivacyScopedSession } from "../../_shared";
import { contentRouteError, readObjectBody } from "../../../documents/_shared";

type RouteContext = { params: Promise<{ requestId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await resolvePrivacyScopedSession(request);
  if (!auth.ok) return auth.response;
  try {
    const { requestId } = await context.params;
    const result = await getDataSubjectRequest({
      session: auth.session,
      requestId: assertUuid(requestId, "requestId"),
    });
    if (!result) return NextResponse.json({ error: "Data-subject request was not found" }, { status: 404 });
    return NextResponse.json({ request: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return contentRouteError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await resolvePrivacyScopedSession(request);
  if (!auth.ok) return auth.response;
  try {
    const { requestId } = await context.params;
    const body = await readObjectBody(request);
    const update = parseDataSubjectRequestUpdate(body.request ?? body);
    const result = await updateDataSubjectRequest({
      session: auth.session,
      idempotencyKey: parseIdempotencyKey(request),
      requestId: assertUuid(requestId, "requestId"),
      ...update,
    });
    return NextResponse.json({ ...result, persisted: true });
  } catch (error) {
    return contentRouteError(error);
  }
}
