import { NextResponse } from "next/server";
import { findPublicMediaAsset, getMediaContentDisposition, MediaStoreError, readMediaAssetContent } from "@/lib/media-store";

type RouteContext = {
  params: Promise<{ token: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { token } = await context.params;
  const asset = await findPublicMediaAsset(token);

  if (!asset) {
    return NextResponse.json({ error: "Public media asset not found." }, { status: 404 });
  }

  try {
    const content = await readMediaAssetContent(asset);
    if (!content?.stream) return NextResponse.json({ error: "Public media asset not found." }, { status: 404 });
    return new Response(content.stream, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": getMediaContentDisposition(asset),
        "content-length": String(asset.sizeBytes),
        "content-type": asset.mimeType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof MediaStoreError && error.code === "FILE_QUARANTINED") {
      return NextResponse.json({ error: "Public media asset is unavailable." }, { status: 423 });
    }
    throw error;
  }
}
