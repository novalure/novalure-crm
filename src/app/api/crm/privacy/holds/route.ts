import { NextResponse } from "next/server";
import { parseIdempotencyKey } from "@/lib/content-library";
import { createLegalHold } from "@/lib/db/privacy-lifecycle-repository";
import { parseLegalHoldInput } from "@/lib/privacy-lifecycle";
import { resolvePrivacyScopedSession } from "../_shared";
import { contentRouteError, readObjectBody } from "../../documents/_shared";

export async function POST(request: Request) {
  const auth = await resolvePrivacyScopedSession(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await readObjectBody(request);
    const result = await createLegalHold({
      session: auth.session,
      idempotencyKey: parseIdempotencyKey(request),
      hold: parseLegalHoldInput(body.hold ?? body),
    });
    return NextResponse.json({ ...result, persisted: true }, { status: 201 });
  } catch (error) {
    return contentRouteError(error);
  }
}
