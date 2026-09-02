import { NextResponse } from "next/server";
import { getPrivacyLifecycleOverview } from "@/lib/db/privacy-lifecycle-repository";
import { resolvePrivacyScopedSession } from "./_shared";
import { contentRouteError } from "../documents/_shared";

export async function GET(request: Request) {
  const auth = await resolvePrivacyScopedSession(request);
  if (!auth.ok) return auth.response;
  try {
    const overview = await getPrivacyLifecycleOverview({ session: auth.session });
    return NextResponse.json(overview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return contentRouteError(error);
  }
}
