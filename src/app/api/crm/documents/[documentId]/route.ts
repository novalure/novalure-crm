import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  assertUuid,
  parseAddDocumentVersionInput,
  parseArchiveInput,
  parseDocumentUpdateInput,
  parseIdempotencyKey,
} from "@/lib/content-library";
import {
  addContentDocumentVersion,
  getContentDocument,
  requestContentDocumentDeletionReview,
  setContentDocumentArchived,
  updateContentDocument,
} from "@/lib/db/content-library-repositories";
import { contentRouteError, readObjectBody } from "../_shared";

type RouteContext = { params: Promise<{ documentId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const { documentId } = await context.params;
    const document = await getContentDocument({
      session: auth.session,
      documentId: assertUuid(documentId, "documentId"),
    });
    if (!document) return NextResponse.json({ error: "Document was not found" }, { status: 404 });
    return NextResponse.json({ document });
  } catch (error) {
    return contentRouteError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;
  try {
    const { documentId: rawId } = await context.params;
    const documentId = assertUuid(rawId, "documentId");
    const body = await readObjectBody(request);
    const action = typeof body.action === "string" ? body.action : "update";
    const idempotencyKey = parseIdempotencyKey(request);
    const payload = body.document ?? body.version ?? body;
    if (action === "add_version") {
      const result = await addContentDocumentVersion({
        session: auth.session,
        documentId,
        idempotencyKey,
        version: parseAddDocumentVersionInput(payload),
      });
      return NextResponse.json({ ...result, persisted: true });
    }
    if (action === "archive" || action === "restore") {
      const archive = parseArchiveInput(payload);
      const result = await setContentDocumentArchived({
        session: auth.session,
        documentId,
        idempotencyKey,
        expectedUpdatedAt: archive.expectedUpdatedAt,
        archived: action === "archive",
        reason: archive.reason,
      });
      return NextResponse.json({ ...result, persisted: true });
    }
    if (action !== "update") {
      return NextResponse.json({ error: "Unsupported document action" }, { status: 400 });
    }
    const result = await updateContentDocument({
      session: auth.session,
      documentId,
      idempotencyKey,
      update: parseDocumentUpdateInput(payload),
    });
    return NextResponse.json({ ...result, persisted: true });
  } catch (error) {
    return contentRouteError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;
  try {
    const { documentId: rawId } = await context.params;
    const body = await readObjectBody(request);
    const review = parseArchiveInput(body);
    const result = await requestContentDocumentDeletionReview({
      session: auth.session,
      documentId: assertUuid(rawId, "documentId"),
      idempotencyKey: parseIdempotencyKey(request),
      expectedUpdatedAt: review.expectedUpdatedAt,
      reason: review.reason,
    });
    const blocked = "blockedByLegalHold" in result && result.blockedByLegalHold === true;
    return NextResponse.json({ ...result, persisted: true }, { status: blocked ? 423 : 202 });
  } catch (error) {
    return contentRouteError(error);
  }
}
