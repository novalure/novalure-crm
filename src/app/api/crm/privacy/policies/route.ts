import { NextResponse } from "next/server";
import { parseIdempotencyKey } from "@/lib/content-library";
import { saveRetentionPolicy } from "@/lib/db/privacy-lifecycle-repository";
import { parseRetentionPolicyInput } from "@/lib/privacy-lifecycle";
import { resolvePrivacyScopedSession } from "../_shared";
import { contentRouteError, readObjectBody } from "../../documents/_shared";

export async function POST(request: Request) {
  const auth = await resolvePrivacyScopedSession(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await readObjectBody(request);
    const result = await saveRetentionPolicy({
      session: auth.session,
      idempotencyKey: parseIdempotencyKey(request),
      policy: parseRetentionPolicyInput(body.policy ?? body),
    });
    return NextResponse.json({ ...result, persisted: true });
  } catch (error) {
    return contentRouteError(error);
  }
}
