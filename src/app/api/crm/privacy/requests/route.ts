import { NextResponse } from "next/server";
import { parseIdempotencyKey } from "@/lib/content-library";
import { createDataSubjectRequest } from "@/lib/db/privacy-lifecycle-repository";
import { parseDataSubjectRequestInput } from "@/lib/privacy-lifecycle";
import { resolvePrivacyScopedSession } from "../_shared";
import { contentRouteError, readObjectBody } from "../../documents/_shared";

export async function POST(request: Request) {
  const auth = await resolvePrivacyScopedSession(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await readObjectBody(request);
    const result = await createDataSubjectRequest({
      session: auth.session,
      idempotencyKey: parseIdempotencyKey(request),
      request: parseDataSubjectRequestInput(body.request ?? body),
    });
    return NextResponse.json({ ...result, persisted: true }, { status: 201 });
  } catch (error) {
    return contentRouteError(error);
  }
}
