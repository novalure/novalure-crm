import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession, type AppSession } from "@/lib/auth/session";
import { deleteWorkspaceMedia, MediaStoreError } from "@/lib/media-store";
import { parsePropertyMediaDeletionTarget, type PropertyMediaDeletionTarget } from "@/lib/media-lifecycle";
import { hasProductCapability } from "@/lib/product-model";

const privateJsonHeaders = { "cache-control": "private, no-store" };
type RouteContext = { params: Promise<{ assetId: string }> };
const validUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function canDeletePropertyAttachment(session: AppSession) {
  return session.permissions.includes("crm:write") && (
    hasProductCapability(session.productRole, "workspace:operate") ||
    hasProductCapability(session.productRole, "pipeline:write") ||
    session.role === "owner" || session.role === "admin" ||
    hasProductCapability(session.productRole, "settings:manage") ||
    hasProductCapability(session.productRole, "workspace:admin")
  );
}

export async function DELETE(request: Request, context: RouteContext) {
  const url = new URL(request.url);
  if (url.hash || [...url.searchParams.keys()].some(key => key !== "workspaceId") ||
      url.searchParams.getAll("workspaceId").length !== 1 || !validUuid(url.searchParams.get("workspaceId") ?? "")) {
    return NextResponse.json({ error: "Invalid media workspace scope.", code: "MEDIA_DELETE_INVALID_TARGET", deletionComplete: false },
      { headers: privateJsonHeaders, status: 400 });
  }
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;

  const { assetId } = await context.params;
  let target: PropertyMediaDeletionTarget | undefined;
  try {
    const raw = await request.text();
    if (!validUuid(assetId) || raw.length > 4096 ||
        !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("Invalid target");
    const parsed = parsePropertyMediaDeletionTarget(JSON.parse(raw));
    if (!parsed) throw new Error("Invalid attachment target");
    target = parsed;
  } catch {
    return NextResponse.json({ error: "Invalid media deletion target.", code: "MEDIA_DELETE_INVALID_TARGET", deletionComplete: false },
      { headers: privateJsonHeaders, status: 400 });
  }
  if (!canDeletePropertyAttachment(auth.session)) {
    return NextResponse.json({ error: "CRM write and property operating rights are required.",
      code: "MEDIA_DELETE_FORBIDDEN", deletionComplete: false, fileDeletion: "not_attempted" },
    { headers: privateJsonHeaders, status: 403 });
  }

  try {
    const deleted = await deleteWorkspaceMedia(assetId, auth.session.workspaceId,
      { actorId: auth.session.userId, target });
    if (!deleted) return NextResponse.json({ error: "Media asset not found." }, { headers: privateJsonHeaders, status: 404 });
    return NextResponse.json({ deletionComplete: true,
      attachment: { id: target.attachmentId, kind: target.attachmentKind, propertyId: target.propertyId },
      deleted: { id: deleted.id, name: deleted.name } }, { headers: privateJsonHeaders });
  } catch (error) {
    if (error instanceof MediaStoreError && ["MEDIA_DELETE_INVALID_TARGET", "MEDIA_DELETE_IN_USE", "MEDIA_DELETE_TARGET_CHANGED", "MEDIA_DELETE_VISIBILITY_UNCONFIRMED"].includes(error.code)) {
      const status = error.code === "MEDIA_DELETE_INVALID_TARGET" ? 400 : error.code === "MEDIA_DELETE_VISIBILITY_UNCONFIRMED" ? 503 : 409;
      return NextResponse.json({ error: error.message, code: error.code, deletionComplete: false, fileDeletion: "not_attempted" },
        { headers: privateJsonHeaders, status });
    }
    if (error instanceof MediaStoreError && ["MEDIA_FILE_DELETE_UNCONFIRMED", "MEDIA_RECORD_DELETE_UNCONFIRMED"].includes(error.code)) {
      return NextResponse.json({ error: error.message, code: error.code, deletionComplete: false,
        fileDeletion: error.code === "MEDIA_FILE_DELETE_UNCONFIRMED" ? "unconfirmed" : "acknowledged" },
      { headers: privateJsonHeaders, status: 503 });
    }
    return NextResponse.json({ error: "Media deletion could not be confirmed.", code: "MEDIA_DELETE_UNCONFIRMED", deletionComplete: false },
      { headers: privateJsonHeaders, status: 503 });
  }
}
