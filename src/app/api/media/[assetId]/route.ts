import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { deleteWorkspaceMedia } from "@/lib/media-store";

type RouteContext = {
  params: Promise<{ assetId: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  const { assetId } = await context.params;
  const deleted = await deleteWorkspaceMedia(assetId, auth.session.workspaceId);

  if (!deleted) {
    return NextResponse.json({ error: "Media asset not found." }, { status: 404 });
  }

  return NextResponse.json({ deleted });
}
