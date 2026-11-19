import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, executeCrmCommand, withCrmRead, CrmCommandError } from "@/lib/crm-command";
import { buildWebExposeSnapshot, createWebExposeLink, listWebExposeState, parseWebExposePublishInput, publishWebExpose, recoverWebExposeLink } from "@/lib/db/web-expose-repository";
import { readBoundedJsonObject } from "@/lib/external-api-response";
import { canWritePropertyExpose } from "@/lib/db/property-expose-repositories";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    const propertyId = assertCrmUuid(new URL(request.url).searchParams.get("propertyId"), "propertyId");
    if(new URL(request.url).searchParams.get("operation")==="link"){
      const data=await withCrmRead(auth.session,(tx,s)=>recoverWebExposeLink(tx,s,propertyId,assertCrmUuid(new URL(request.url).searchParams.get("linkId"))));
      return Response.json({data},{headers});
    }
    const data = await withCrmRead(auth.session, (tx, s) => listWebExposeState(tx, s, propertyId));
    return Response.json({ data, persisted: true }, { headers });
  } catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;
  try {
    const b = await readBoundedJsonObject(request);
    const action = b.action;
    const propertyId = assertCrmUuid(b.propertyId, "propertyId");
    if (!canWritePropertyExpose(auth.session)) throw new CrmCommandError("FORBIDDEN", "Veröffentlichungsrecht fehlt", 403);
    if (action === "preview") {
      const built = await withCrmRead(auth.session, (tx, s) => buildWebExposeSnapshot(tx, s, parseWebExposePublishInput(b)));
      return Response.json({ data: built, preview: true, tracked: false }, { headers });
    }
    const metadata = crmRequestMetadata(request, b);
    const result = await executeCrmCommand(auth.session, { ...metadata, operation: "web_expose." + String(action), resourceId: propertyId, capability: "workspace:operate", payload: b }, async (tx, ctx) => {
      if (action === "publish") return publishWebExpose(tx, ctx.session, parseWebExposePublishInput(b));
      if (action === "save_draft") {
        const input = parseWebExposePublishInput(b);
        if ((input.description?.length ?? 0)>16000 || (input.title?.length ?? 0)>300 || input.controller.length>300 || input.privacyUrl.length>2000 || input.legalUrl.length>2000 || !Number.isSafeInteger(b.expectedDraftRevision) || Number(b.expectedDraftRevision)<0) throw new CrmCommandError("INVALID_DRAFT", "Entwurfsangaben ungültig");
        const draft = await tx.queryOne(`insert into web_expose_drafts(workspace_id,property_id,language,input) values($1::uuid,$2::uuid,$3,$4::jsonb) on conflict(workspace_id,property_id,language) do update set input=excluded.input,revision=web_expose_drafts.revision+1,updated_at=now() where web_expose_drafts.revision=$5 returning language,revision`, [ctx.workspaceId,propertyId,input.language,JSON.stringify({...input,reviewed:false,expectedSourceFingerprint:undefined}),b.expectedDraftRevision]);
        if (!draft) throw new CrmCommandError("DRAFT_CONFLICT", "Der Entwurf wurde geändert. Bitte neu laden.",409);
        return draft;
      }
      if (action === "prune_analytics") {
        const result = await tx.queryOne(`select crm_web_expose_prune($1::uuid) as data`, [ctx.workspaceId]);
        return result ?? {};
      }
      if (action === "erase_visit") {
        const result = await tx.queryOne<{ erased: boolean }>(`select crm_web_expose_erase_session($1::uuid,$2::uuid,$3::uuid) as erased`, [ctx.workspaceId,propertyId,assertCrmUuid(b.sessionId)]);
        if (!result?.erased) throw new CrmCommandError("NOT_FOUND", "Besuch nicht verfügbar",404);
        return { erased:true };
      }
      if (action === "link") {
        const versionId = assertCrmUuid(b.versionId);
        const owned = await tx.queryOne(`select id from web_expose_versions where id=$1::uuid and property_id=$2::uuid and workspace_id=$3::uuid and active`, [versionId, propertyId, ctx.workspaceId]);
        if (!owned) throw new CrmCommandError("NOT_FOUND", "Sprachversion nicht verfügbar", 404);
        return createWebExposeLink(tx, ctx.session, { versionId, label: typeof b.label === "string" ? b.label : "", leadId: b.leadId ? assertCrmUuid(b.leadId) : null, expiresAt: typeof b.expiresAt === "string" && b.expiresAt ? b.expiresAt : null });
      }
      if (action === "revoke") {
        await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, ["web-expose-link:"+assertCrmUuid(b.linkId)]);
        const changed = await tx.queryOne(`update web_expose_links l set revoked_at=coalesce(revoked_at,now()) from web_expose_versions v where l.id=$1::uuid and v.id=l.version_id and v.workspace_id=l.workspace_id and v.workspace_id=$2::uuid and v.property_id=$3::uuid returning l.id`, [assertCrmUuid(b.linkId), ctx.workspaceId, propertyId]);
        if (!changed) throw new CrmCommandError("NOT_FOUND", "Link nicht verfügbar", 404);
        return changed;
      }
      if (action === "deactivate") {
        await tx.query(`select id from web_expose_versions where id=$1::uuid and workspace_id=$2::uuid for update`,[assertCrmUuid(b.versionId),ctx.workspaceId]);
        const locks = await tx.query<{ id: string }>(`select id from web_expose_links where version_id=$1::uuid and workspace_id=$2::uuid order by id`, [assertCrmUuid(b.versionId),ctx.workspaceId]);
        for(const lock of locks) await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, ["web-expose-link:"+lock.id]);
        const changed = await tx.queryOne(`update web_expose_versions set active=false where id=$1::uuid and workspace_id=$2::uuid and property_id=$3::uuid returning id`, [assertCrmUuid(b.versionId), ctx.workspaceId, propertyId]);
        if (!changed) throw new CrmCommandError("NOT_FOUND", "Sprachversion nicht verfügbar", 404);
        return changed;
      }
      throw new CrmCommandError("INVALID_ACTION", "Aktion ungültig");
    });
    return Response.json({ data: result.data, persisted: true, replayed: result.replayed }, { headers });
  } catch (error) { return crmCommandErrorResponse(error); }
}
