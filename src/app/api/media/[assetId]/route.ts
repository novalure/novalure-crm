import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { deleteWorkspaceMedia, MediaStoreError } from "@/lib/media-store";
import { canAccessContentMediaAsset, canManageContent } from "@/lib/db/content-library-repositories";

const privateJsonHeaders = { "cache-control": "private, no-store" };

type RouteContext = {
  params: Promise<{ assetId: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  const launchScope = evaluateLaunchScope("mediaBlobMutation");
  if (!launchScope.allowed) {
    return NextResponse.json(
      { code: launchScope.code, error: "media_blob_mutation_launch_scope_blocked" },
      { headers: privateJsonHeaders, status: 503 },
    );
  }

  const { assetId } = await context.params;
  if (!await canAccessContentMediaAsset({ assetId, mutation: true, session: auth.session })) {
    return NextResponse.json({ error: "Media asset not found." }, { headers: privateJsonHeaders, status: 404 });
  }
  let deleted;
  try {
    deleted = await deleteWorkspaceMedia(
      assetId,
      auth.session.workspaceId,
      auth.session.userId,
      { canManagePendingDeletion: canManageContent(auth.session) },
    );
  } catch (error) {
    if (error instanceof MediaStoreError && error.code === "METADATA_DELETE_PENDING") {
      return NextResponse.json(
        {
          code: error.code,
          error: "The stored file was removed, but metadata cleanup remains pending and must be retried.",
          pending: true,
        },
        { headers: privateJsonHeaders, status: 503 },
      );
    }
    if (
      error instanceof MediaStoreError &&
      [
        "LAUNCH_SCOPE_INTERNAL_ONLY",
        "LAUNCH_SCOPE_OFF",
        "LAUNCH_SCOPE_RUNTIME_UNSAFE",
        "LAUNCH_SCOPE_UNKNOWN",
        "LAUNCH_SCOPE_UNSIGNED",
        "MEDIA_ACCESS_REQUIRED",
        "PRIVATE_STORAGE_UNAVAILABLE",
        "PUBLIC_STORAGE_UNAVAILABLE",
        "STORAGE_DELETE_FAILED",
      ].includes(error.code)
    ) {
      return NextResponse.json(
        { error: "Media storage is temporarily unavailable. The asset was not removed." },
        { headers: privateJsonHeaders, status: 503 },
      );
    }
    if (error instanceof MediaStoreError && error.code === "MEDIA_IN_USE") {
      return NextResponse.json(
        { code: error.code, error: "Media is referenced by a versioned document and cannot be removed." },
        { headers: privateJsonHeaders, status: 409 },
      );
    }
    throw error;
  }

  if (!deleted) {
    return NextResponse.json({ error: "Media asset not found." }, { headers: privateJsonHeaders, status: 404 });
  }

  return NextResponse.json({
    deleted: {
      id: deleted.id,
      name: deleted.name,
    },
  }, { headers: privateJsonHeaders });
}
