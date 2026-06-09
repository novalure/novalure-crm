import { NextResponse } from "next/server";
import {
  getLegacyPublicMeetingPageRoute,
  getPublicMeetingAvailability,
} from "@/lib/db/meeting-repositories";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug")?.trim() ?? "";
  const workspacePublicKey =
    url.searchParams.get("workspace_public_key")?.trim() ||
    url.searchParams.get("workspace")?.trim() ||
    url.searchParams.get("key")?.trim() ||
    "";
  const date = url.searchParams.get("date")?.trim() || undefined;

  if (!slug) {
    return NextResponse.json({ error: "Missing meeting slug" }, { status: 400 });
  }

  const route = workspacePublicKey
    ? { slug, status: "unique" as const, workspacePublicKey }
    : await getLegacyPublicMeetingPageRoute(slug);

  if (route.status === "ambiguous") {
    return NextResponse.json({ error: "Meeting slug is ambiguous" }, { status: 409 });
  }

  if (route.status === "not_found") {
    return NextResponse.json({ error: "Meeting page not found" }, { status: 404 });
  }

  const availability = await getPublicMeetingAvailability({
    date,
    slug: route.slug,
    workspacePublicKey: route.workspacePublicKey,
  });

  if (!availability) {
    return NextResponse.json({ error: "Meeting page not found" }, { status: 404 });
  }

  return NextResponse.json({ availability });
}
