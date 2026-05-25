import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { findPublicMediaAsset, isBlobAsset, mediaAssetExists, mediaAssetPath } from "@/lib/media-store";

type RouteContext = {
  params: Promise<{ token: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { token } = await context.params;
  const asset = await findPublicMediaAsset(token);

  if (!asset || !(await mediaAssetExists(asset))) {
    return NextResponse.json({ error: "Public media asset not found." }, { status: 404 });
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
