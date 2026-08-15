import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { findWorkspaceMediaAsset, MediaStoreError, readMediaAssetContent } from "@/lib/media-store";
import { safeMediaContentDisposition } from "@/lib/media-security";

type RouteContext = {
  params: Promise<{ assetId: string }>;
};

const privateHeaders = {
  "cache-control": "private, no-store",
  "content-security-policy": "sandbox; default-src 'none'",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export async function GET(request: Request, context: RouteContext) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const { assetId } = await context.params;
  const asset = await findWorkspaceMediaAsset(assetId, auth.session.workspaceId);
  if (!asset) {
    return NextResponse.json({ error: "Media asset not found." }, { headers: privateHeaders, status: 404 });
  }

  try {
    const content = await readMediaAssetContent(asset);
    if (!content) {
      return NextResponse.json({ error: "Media asset not found." }, { headers: privateHeaders, status: 404 });
    }

    return new Response(content.body, {
      headers: {
        ...privateHeaders,
        "content-disposition": safeMediaContentDisposition(asset.originalName, content.contentType),
        "content-length": String(content.sizeBytes),
        "content-type": content.contentType,
      },
    });
  } catch (error) {
    const unavailable = error instanceof MediaStoreError && error.code.endsWith("STORAGE_UNAVAILABLE");
    return NextResponse.json(
      { error: unavailable ? "Media storage is unavailable." : "Media asset could not be read." },
      { headers: privateHeaders, status: unavailable ? 503 : 502 },
    );
  }
}
