import { NextResponse } from "next/server";
import { getBuildMetadata } from "@/lib/build-metadata";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getBuildMetadata(), {
    headers: { "Cache-Control": "public, no-store, max-age=0" },
  });
}
