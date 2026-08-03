import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { findWorkspaceMediaAsset, getMediaContentDisposition, MediaStoreError, readMediaAssetContent } from "@/lib/media-store";

type RouteContext = {
  params: Promise<{ assetId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const { assetId } = await context.params;
  const asset = await findWorkspaceMediaAsset(assetId, auth.session.workspaceId);

  if (!asset) {
    return NextResponse.json({ error: "Media asset not found." }, { status: 404 });
  }

  try {
    const content = await readMediaAssetContent(asset);
    if (!content?.stream) return NextResponse.json({ error: "Media asset not found." }, { status: 404 });
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
      return NextResponse.json({ error: error.message }, { status: 423 });
    }
    throw error;
  }
}
