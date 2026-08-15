import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { findWorkspaceMediaAsset, isBlobAsset, mediaAssetExists, mediaAssetPath } from "@/lib/media-store";

type RouteContext = {
  params: Promise<{ assetId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const { assetId } = await context.params;
  const asset = await findWorkspaceMediaAsset(assetId, auth.session.workspaceId);

  if (!asset || !(await mediaAssetExists(asset))) {
    return NextResponse.json({ error: "Media asset not found." }, { status: 404 });
  }

  if (isBlobAsset(asset)) {
    return NextResponse.redirect(asset.url);
  }

  const bytes = await readFile(mediaAssetPath(asset));
  return new Response(bytes, {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(asset.sizeBytes),
      "content-type": asset.mimeType,
    },
  });
}
