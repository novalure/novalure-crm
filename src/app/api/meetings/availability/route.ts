import { NextResponse } from "next/server";
import { getPublicMeetingAvailability } from "@/lib/db/meeting-repositories";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug")?.trim() ?? "";
  const date = url.searchParams.get("date")?.trim() || undefined;

  if (!slug) {
    return NextResponse.json({ error: "Missing meeting slug" }, { status: 400 });
  }

  const availability = await getPublicMeetingAvailability({ date, slug });

  if (!availability) {
    return NextResponse.json({ error: "Meeting page not found" }, { status: 404 });
  }

  return NextResponse.json({ availability });
}
