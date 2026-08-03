import { NextResponse } from "next/server";
import { getLegacyPublicMeetingPageRoute } from "@/lib/db/meeting-repositories";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { slug } = await context.params;
  const legacy = await getLegacyPublicMeetingPageRoute(slug);
  if (legacy.status !== "unique") {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(legacy.canonicalPath, sourceUrl.origin);

  sourceUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  return NextResponse.redirect(targetUrl, 308);
}
