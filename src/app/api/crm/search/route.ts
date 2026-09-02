import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  ContentValidationError,
  assertUuid,
  parseContentPage,
  parseIdempotencyKey,
  parseOptionalUuid,
} from "@/lib/content-library";
import {
  globalSearchEntityTypes,
  listGlobalSearchRecents,
  recordGlobalSearchRecent,
  searchWorkspaceRecords,
  type GlobalSearchEntityType,
} from "@/lib/db/global-search-repository";
import { contentRouteError, readObjectBody } from "../documents/_shared";

function parseEntityType(value: unknown): GlobalSearchEntityType {
  if (typeof value !== "string" || !globalSearchEntityTypes.includes(value as GlobalSearchEntityType)) {
    throw new ContentValidationError("entityType is invalid");
  }
  return value as GlobalSearchEntityType;
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url);
    const projectId = parseOptionalUuid(url.searchParams.get("projectId"), "projectId");
    if (url.searchParams.get("mode") === "recents") {
      const recents = await listGlobalSearchRecents({ session: auth.session, projectId, limit: 10 });
      return NextResponse.json({ items: recents, source: "server" });
    }
    const page = parseContentPage(url.searchParams);
    const ownerParam = url.searchParams.get("ownerUserId");
    const ownerUserId = ownerParam === "me"
      ? auth.session.userId
      : parseOptionalUuid(ownerParam, "ownerUserId");
    const result = await searchWorkspaceRecords({
      session: auth.session,
      query: url.searchParams.get("q") ?? "",
      projectId,
      ownerUserId,
      ...page,
    });
    return NextResponse.json(result);
  } catch (error) {
    return contentRouteError(error);
  }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const body = await readObjectBody(request);
    if (body.action !== "record_recent") {
      throw new ContentValidationError("Unsupported search mutation");
    }
    const result = await recordGlobalSearchRecent({
      session: auth.session,
      idempotencyKey: parseIdempotencyKey(request),
      entityType: parseEntityType(body.entityType),
      entityId: assertUuid(body.entityId, "entityId"),
      projectId: parseOptionalUuid(body.projectId, "projectId"),
    });
    return NextResponse.json({ ...result, persisted: true });
  } catch (error) {
    return contentRouteError(error);
  }
}
