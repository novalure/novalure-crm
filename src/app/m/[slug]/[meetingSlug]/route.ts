import { NextResponse } from "next/server";
import { buildPublicMeetingPath } from "@/lib/public-routing";

type RouteContext = {
  params: Promise<{ meetingSlug: string; slug: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { meetingSlug, slug: workspacePublicKey } = await context.params;
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(
    buildPublicMeetingPath({ slug: meetingSlug, workspacePublicKey }),
    sourceUrl.origin,
  );

  sourceUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  return NextResponse.redirect(targetUrl, 302);
}
