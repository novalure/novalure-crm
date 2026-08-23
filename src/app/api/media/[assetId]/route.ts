import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { deleteWorkspaceMedia, MediaStoreError } from "@/lib/media-store";

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
  let deleted;
  try {
    deleted = await deleteWorkspaceMedia(assetId, auth.session.workspaceId);
  } catch (error) {
    if (
      error instanceof MediaStoreError &&
      [
        "LAUNCH_SCOPE_INTERNAL_ONLY",
        "LAUNCH_SCOPE_OFF",
        "LAUNCH_SCOPE_RUNTIME_UNSAFE",
        "LAUNCH_SCOPE_UNKNOWN",
        "LAUNCH_SCOPE_UNSIGNED",
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
