import { NextResponse } from "next/server";
import { findPublicMediaAsset, MediaStoreError, readMediaAssetContent } from "@/lib/media-store";
import { safeMediaContentDisposition } from "@/lib/media-security";

type RouteContext = {
  params: Promise<{ token: string }>;
};

const publicShareHeaders = {
  "cache-control": "private, no-store",
  "content-security-policy": "sandbox; default-src 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export async function GET(_request: Request, context: RouteContext) {
  const { token } = await context.params;
  const asset = await findPublicMediaAsset(token);
  if (!asset) {
    return NextResponse.json({ error: "Public media asset not found." }, { headers: publicShareHeaders, status: 404 });
  }

  try {
    const content = await readMediaAssetContent(asset);
    if (!content) {
      return NextResponse.json({ error: "Public media asset not found." }, { headers: publicShareHeaders, status: 404 });
    }

    return new Response(content.body, {
      headers: {
        ...publicShareHeaders,
        "content-disposition": safeMediaContentDisposition(asset.originalName, content.contentType),
        "content-length": String(content.sizeBytes),
        "content-type": content.contentType,
      },
    });
  } catch (error) {
    const unavailable = error instanceof MediaStoreError && error.code.endsWith("STORAGE_UNAVAILABLE");
    return NextResponse.json(
      { error: unavailable ? "Media storage is unavailable." : "Public media asset could not be read." },
      { headers: publicShareHeaders, status: unavailable ? 503 : 502 },
    );
  }
}
