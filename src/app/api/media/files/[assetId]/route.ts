import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { withCrmRead } from "@/lib/crm-command";
import { canAccessWorkspaceMedia, findWorkspaceMediaAsset, MediaStoreError, readMediaAssetContent } from "@/lib/media-store";
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
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;

  const { assetId } = await context.params;
  try {
    const result = await withCrmRead(auth.session, async (_tx, session) => {
      const asset = await findWorkspaceMediaAsset(assetId, session.workspaceId);
      if (!asset || !await canAccessWorkspaceMedia(session.workspaceId, asset.folder, asset.id)) return null;
      const content = await readMediaAssetContent(asset);
      return content ? { asset, content } : null;
    });
    if (!result) {
      return NextResponse.json({ error: "Media asset not found." }, { headers: privateHeaders, status: 404 });
    }

    const { asset, content } = result;

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
