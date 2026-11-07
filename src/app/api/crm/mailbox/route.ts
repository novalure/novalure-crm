import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, crmCommandErrorResponse, crmRequestMetadata, CrmCommandError, withCrmRead } from "@/lib/crm-command";
import { associateCrmMailboxMessage, disconnectCrmMailbox, eraseCrmMailboxCopy, loadCrmMailbox, syncCrmMailbox } from "@/lib/db/crm-mailbox-repository";
import { readBoundedJsonObject } from "@/lib/external-api-response";
import { actOnMailboxPrivateDecision, runPersonalMailboxSync, saveMailboxAutoSettings } from "@/lib/db/crm-mailbox-sync-repository";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try { const params=new URL(request.url).searchParams,id = params.get("messageId"), data = await withCrmRead(auth.session, (tx, session) => loadCrmMailbox(tx, session, id ? assertCrmUuid(id) : null,{before:params.get('before'),decisionsBefore:params.get('decisionsBefore')})); return Response.json({ data, persisted: true }, { headers }); }
  catch (error) { return crmCommandErrorResponse(error); }
}
export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" }); if (!auth.ok) return auth.response;
  try {
    const body = await readBoundedJsonObject(request);
    if (Object.keys(body).some((key) => !["action", "connectionId", "mode", "messageId", "projectId", "leadId", "reviewed", "confirmedReply", "reason", "enabled", "autoFile", "expectedRevision", "decisionId"].includes(key))) throw new CrmCommandError("UNKNOWN_FIELD", "Postfachfelder prüfen");
    let data;
    if (body.action === "sync") { if (body.mode !== "latest" && body.mode !== "older") throw new CrmCommandError("INVALID_MODE", "Abrufmodus prüfen"); data = await syncCrmMailbox(auth.session, { connectionId: assertCrmUuid(body.connectionId), requestId: assertCrmUuid(request.headers.get("idempotency-key")), mode: body.mode }); }
    else if (body.action === "disconnect") data = await withCrmRead(auth.session, (tx, session) => disconnectCrmMailbox(tx, session, assertCrmUuid(body.connectionId)));
    else if (body.action === "erase") data = await withCrmRead(auth.session, (tx, session) => eraseCrmMailboxCopy(tx, session, assertCrmUuid(body.messageId)));
    else if (body.action === "associate") data = (await associateCrmMailboxMessage(auth.session, body, crmRequestMetadata(request, body))).data;
    else if(body.action==='auto_settings')data=await withCrmRead(auth.session,(tx,session)=>saveMailboxAutoSettings(tx,session,{connectionId:assertCrmUuid(body.connectionId),enabled:body.enabled as boolean,autoFile:body.autoFile as boolean,expectedRevision:body.expectedRevision as number}));
    else if(body.action==='auto_sync')data=await runPersonalMailboxSync(auth.session,assertCrmUuid(body.connectionId),{ignoreDue:true});
    else if(body.action==='file_private'||body.action==='retry_private')data=await withCrmRead(auth.session,(tx,session)=>actOnMailboxPrivateDecision(tx,session,{decisionId:assertCrmUuid(body.decisionId),action:body.action as 'file_private'|'retry_private'}));
    else throw new CrmCommandError("INVALID_ACTION", "Postfachaktion prüfen");
    return Response.json({ data, persisted: true, sent: false }, { headers });
  } catch (error) { return crmCommandErrorResponse(error); }
}
