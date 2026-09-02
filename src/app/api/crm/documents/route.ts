import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  parseContentPage,
  parseCreateDocumentInput,
  parseIdempotencyKey,
  parseOptionalUuid,
} from "@/lib/content-library";
import {
  contentAccessSummary,
  createContentDocument,
  listContentDocuments,
} from "@/lib/db/content-library-repositories";
import { contentRouteError, readObjectBody } from "./_shared";

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url);
    const page = parseContentPage(url.searchParams);
    const result = await listContentDocuments({
      session: auth.session,
      ...page,
      projectId: parseOptionalUuid(url.searchParams.get("projectId"), "projectId"),
      includeArchived: url.searchParams.get("includeArchived") === "true",
      query: url.searchParams.get("q") ?? "",
    });
    return NextResponse.json({ ...result, access: contentAccessSummary(auth.session) });
  } catch (error) {
    return contentRouteError(error);
  }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;
  try {
    const body = await readObjectBody(request);
    const result = await createContentDocument({
      session: auth.session,
      idempotencyKey: parseIdempotencyKey(request),
      document: parseCreateDocumentInput(body.document ?? body),
    });
    return NextResponse.json({ ...result, persisted: true }, { status: 201 });
  } catch (error) {
    return contentRouteError(error);
  }
}
