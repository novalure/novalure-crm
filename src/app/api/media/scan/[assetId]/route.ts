import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { queryOne } from "@/lib/db/client";

type RouteContext = { params: Promise<{ assetId: string }> };

function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export async function POST(request: Request, context: RouteContext) {
  const configuredSecret = process.env.MEDIA_SCAN_CALLBACK_SECRET?.trim() ?? "";
  const suppliedSecret = request.headers.get("x-media-scan-secret") ?? "";
  if (!configuredSecret || !safeEqual(configuredSecret, suppliedSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null) as { error?: unknown; sha256?: unknown; status?: unknown } | null;
  const status = body?.status === "clean" || body?.status === "infected" || body?.status === "failed" ? body.status : null;
  const sha256 = typeof body?.sha256 === "string" && /^[a-f0-9]{64}$/i.test(body.sha256) ? body.sha256.toLowerCase() : null;
  if (!status || !sha256) return NextResponse.json({ error: "Invalid scan result" }, { status: 400 });
  const { assetId } = await context.params;
  const row = await queryOne<{ id: string }>(
    `
      update media_assets set scan_status = $2, scan_error = $3, updated_at = now()
      where id = $1::uuid and sha256 = $4 and scan_status = 'pending'
      returning id
    `,
    [assetId, status, typeof body?.error === "string" ? body.error.slice(0, 500) : null, sha256],
  );
  if (!row) return NextResponse.json({ error: "Pending media asset not found" }, { status: 404 });
  const response = NextResponse.json({ accepted: true, assetId: row.id, status });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
