import { NextResponse } from "next/server";
import { buildPublicMeetingPath } from "@/lib/public-routing";
import { getPublicMeetingPageSettings } from "@/lib/db/meeting-repositories";

type RouteContext = {
  params: Promise<{ meetingSlug: string; slug: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { meetingSlug, slug: workspacePublicKey } = await context.params;
  const meeting = await getPublicMeetingPageSettings({ slug: meetingSlug, workspacePublicKey });
  if (!meeting) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(
    buildPublicMeetingPath({ slug: meetingSlug, workspacePublicKey }),
    sourceUrl.origin,
  );

  sourceUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  return NextResponse.redirect(targetUrl, 308);
}
