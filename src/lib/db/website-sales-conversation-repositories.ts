import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppSession } from "../auth/session";
import { CrmCommandError, crmPayloadDigest, executeCrmCommand, reconcileCrmCommand, withCrmCommandPreflight, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "../crm-command";
import { websiteSalesActorAuthority, withWebsiteSalesConversationStop } from "../website-sales-machine-authority";
import { withSalesAllocationFence } from "../website-sales-allocation";
import { websiteSalesAnswerFactSchema, websiteSalesConversationFactsDigest, websiteSalesConversationTopicSchema, prepareWebsiteSalesConversationDraft, type WebsiteSalesAnswerFact } from "../website-sales-conversation";
import { websiteSalesConversationContract, type SalesConversationCommand, type SalesConversationEffect, type SalesConversationRead, type SalesConversationScope, type SalesConversationStatus, type SalesConversationSummary, type SalesConversationTurn } from "../website-sales-conversation-types";
import { websiteSalesIrelandState, runWebsiteSalesIrelandCommand, websiteSalesIrelandContract } from "./website-sales-ireland-repositories";
import { readCurrentSalesPriceFact, readCurrentSalesQuoteBinding } from "./website-sales-operations-repositories";
import { readSalesConversationSources as sources, type SalesConversationCanonicalSource as Source } from "./website-sales-conversation-source";
import { websiteSalesConversationReadiness } from "../website-sales-conversation-readiness";

const uuid = z.uuid(), language = z.enum(["de", "en"]), sha = z.hash("sha256");
const payloads = {
  authorize_topic_extraction: z.strictObject({ canonicalMessageId: uuid, allow: z.boolean() }),
  record_answer_fact: z.strictObject({ topicCode: websiteSalesConversationTopicSchema, text: z.string().trim().min(1).max(1000), sourceReference: z.string().trim().min(1).max(500), validUntil: z.iso.datetime({ offset: true }), classification: z.enum(["PUBLIC_BUSINESS", "APPROVED_SALES"]) }),
  record_topic: z.strictObject({ canonicalMessageId: uuid.optional(), topicCode: websiteSalesConversationTopicSchema.optional(), language }),
  draft_answer: z.strictObject({ topicTurnId: uuid, expectedFactsDigest: sha }),
  advance_conversation: z.strictObject({ canonicalMessageId: uuid, language }),
  stop_conversation: z.strictObject({ reason: z.enum(["OPT_OUT", "NO_FIT", "UNKNOWN_DELIVERY", "OPERATOR_STOP"]) }),
};
const schema = z.strictObject({ contractVersion: z.literal(websiteSalesConversationContract), operation: z.enum(["authorize_topic_extraction", "record_answer_fact", "record_topic", "draft_answer", "advance_conversation", "stop_conversation"]),
  projectId: uuid, companyId: uuid, locationId: uuid, expectedConversationVersion: z.number().int().nonnegative(), expectedWorkflowVersion: z.number().int().positive(),
  idempotencyKey: z.uuidv4(), correlationId: uuid, payload: z.record(z.string(), z.unknown()),
  allocationProof: z.strictObject({ allocationId: uuid, version: z.number().int().positive(), leaseToken: uuid }).optional(),
});
function fail(code: string, status = 409): never { throw new CrmCommandError(code, code, status); }
export function parseWebsiteSalesConversationCommand(raw: unknown): SalesConversationCommand {
  const command = schema.safeParse(raw); if (!command.success) fail("INVALID_CONVERSATION_COMMAND", 400);
  const payload = payloads[command.data.operation].extend({ resourceGrants: z.array(z.strictObject({ companyId: uuid, locationId: uuid, grantId: uuid })).max(199).optional() }).safeParse(command.data.payload); if (!payload.success) fail("INVALID_CONVERSATION_PAYLOAD", 400);
  const normalizedPayload = payload.data as Record<string, unknown>;
  if (command.data.operation === "record_topic" && !normalizedPayload.canonicalMessageId && !normalizedPayload.topicCode) fail("TOPIC_REQUIRED", 400);
  return { ...command.data, payload: normalizedPayload };
}
export function websiteSalesConversationCommandInput(session: AppSession, raw: SalesConversationCommand) {
  const input = parseWebsiteSalesConversationCommand(raw), machine = websiteSalesActorAuthority(session, input, input.operation, "autonomy");
  if (session.serviceIdentity && (["authorize_topic_extraction", "record_answer_fact"].includes(input.operation) || input.operation === "record_topic" && !input.payload.canonicalMessageId)) fail("HUMAN_ATTESTATION_REQUIRED", 403);
  return { operation: `website_sales.conversation.${input.operation}`, projectId: input.projectId, resourceId: input.locationId, expectedVersion: input.expectedWorkflowVersion,
    capability: "pipeline:write" as const, idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, payload: { request: raw, machine } };
}
type State = Awaited<ReturnType<typeof websiteSalesIrelandState>>;
type Workflow = NonNullable<State["row"]>;
type Conversation = { id: string; version: number; status: SalesConversationStatus; stopReason: string | null };
type StoredTurn = Omit<SalesConversationTurn, "current">;
function currentWorkflow(state: State) { if (!state.row || !state.current.workflow) fail("WORKFLOW_NOT_FOUND", 404); return state.current.workflow; }
function hardStop(state: State) {
  if (state.contactStop === "OPT_OUT" || state.contactStop === "UNKNOWN_DELIVERY") return state.contactStop;
  if (state.row?.status === "STOPPED" && state.row.stopReason !== "REPLY_RECEIVED") return state.row.stopReason ?? "WORKFLOW_STOPPED";
  if (!state.row || !state.current.workflow || !websiteSalesConversationReadiness(state.row.prospect, state.row.locationVersion, state.location.version, new Date().toISOString()).eligible) return "STALE_EVIDENCE";
  return null;
}
function assertReady(state: State) { const reason = hardStop(state); if (reason) fail(reason); if (!state.row?.contactId || !state.row.leadId) fail("QUALIFIED_CONTACT_REQUIRED"); }
function owner(session: AppSession) { return !session.serviceIdentity && (session.role === "owner" || session.role === "admin"); }
async function conversation(tx: TenantTransaction, session: AppSession, scope: SalesConversationScope, lock = false) {
  return tx.queryOne<Conversation>(`select id,version,status,stop_reason as "stopReason" from crm_website_sales_conversations
    where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 ${lock ? "for update" : ""}`, [session.workspaceId, scope.projectId, scope.companyId, scope.locationId]);
}
async function facts(tx: TenantTransaction, session: AppSession, scope: SalesConversationScope, row: Workflow) {
  scope = { projectId: scope.projectId, companyId: scope.companyId, locationId: scope.locationId };
  const now = new Date().toISOString(), quoteBinding = await readCurrentSalesQuoteBinding(tx, session, scope), priceFact = await readCurrentSalesPriceFact(tx, session, scope);
  const stored = await tx.query<{ fact: unknown; evidenceDigest: string }>(`select distinct on(topic_code) fact,evidence_digest as "evidenceDigest" from crm_website_sales_answer_facts
    where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 order by topic_code,version desc limit 25`, [session.workspaceId, scope.projectId, scope.companyId, scope.locationId, row.id]);
  const identity = { workspaceId: session.workspaceId, ...scope }, empty = websiteSalesConversationFactsDigest([], null, now);
  const rows = stored.map(value => {
    const fact = websiteSalesAnswerFactSchema.parse(value.fact);
    if (crmPayloadDigest(fact.identity) !== crmPayloadDigest(identity)) fail("CONVERSATION_FACT_SCOPE_DENIED", 403);
    return { fact, current: value.evidenceDigest === row.evidenceDigest && websiteSalesConversationFactsDigest([fact], null, now) !== empty };
  });
  if (priceFact) rows.push({ fact: websiteSalesAnswerFactSchema.parse(priceFact), current: true });
  const active = rows.filter(value => value.current).map(value => value.fact);
  return { rows, active, quoteBinding, digest: websiteSalesConversationFactsDigest(active, quoteBinding, now) };
}
function summary(saved: Conversation, factsDigest: string, reason: string | null = null): SalesConversationSummary {
  return { ...saved, status: reason ? "STOPPED" : saved.status, stopReason: reason ?? saved.stopReason, factsDigest };
}
async function storedTurns(tx: TenantTransaction, session: AppSession, row: Workflow) {
  return tx.query<StoredTurn>(`select id,turn_index as index,kind,topic_turn_id as "topicTurnId",topic_code as "topicCode",language,source_kind as "sourceKind",message_id as "messageId",source_hash as "sourceHash",created_at::text as "createdAt",draft
    from crm_website_sales_conversation_turns where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 order by turn_index desc limit 25`, [session.workspaceId, row.projectId, row.companyId, row.locationId, row.id]);
}
async function read(tx: TenantTransaction, session: AppSession, scope: SalesConversationScope): Promise<SalesConversationRead> {
  scope = { projectId: scope.projectId, companyId: scope.companyId, locationId: scope.locationId };
  const state = await websiteSalesIrelandState(tx, session, scope), workflow = currentWorkflow(state), row = state.row!;
  const [saved, loaded, sourceRows, turns] = await Promise.all([conversation(tx, session, scope), facts(tx, session, scope, row), sources(tx, session, row), storedTurns(tx, session, row)]);
  const reason = hardStop(state), projectedSources = sourceRows.map(source => ({ messageId: source.messageId, receivedAt: source.receivedAt, sourceHash: source.sourceHash, topicCode: source.topicCode,
    language: source.language, basis: source.basis, blockedReason: source.blockedReason, authorized: source.authorized, canAuthorize: source.canAuthorize }));
  const latestDraftTopics = new Set<string>();
  const projectedTurns = turns.map(turn => {
    const permitted = turn.sourceKind === "HUMAN_RECORDED_TOPIC" || sourceRows.some(source => source.messageId === turn.messageId && source.sourceHash === turn.sourceHash && source.authorized && !["CONTACT_STOPPED", "SOURCE_CHANGED", "PURPOSE_PERMISSION_REQUIRED"].includes(source.blockedReason ?? ""));
    const latest = !turn.draft || !latestDraftTopics.has(turn.topicTurnId!);
    if (turn.draft) latestDraftTopics.add(turn.topicTurnId!);
    const current = !reason && permitted && latest && (!turn.draft || turn.draft.factsDigest === loaded.digest && turn.draft.evidenceDigest === row.evidenceDigest
      && turn.draft.workflowVersion === row.version);
    return { ...turn, topicCode: permitted ? turn.topicCode : "UNKNOWN" as const, current, draft: current ? turn.draft : null };
  });
  const grant = await tx.queryOne<{ allowed: boolean }>("select crm_project_access($1,$2,true) as allowed", [session.workspaceId, scope.projectId]);
  return { contractVersion: websiteSalesConversationContract, source: "database", workspaceId: session.workspaceId, ...scope, workflow,
    conversation: saved ? summary(saved, loaded.digest, reason) : null, factsDigest: loaded.digest, facts: loaded.rows, quoteBinding: loaded.quoteBinding,
    sources: projectedSources, turns: projectedTurns, canWrite: !!grant?.allowed && !!row.contactId && session.permissions.includes("crm:write") && session.productPermissions.includes("pipeline:write"),
    canApproveFacts: owner(session), canContact: false };
}
export async function readWebsiteSalesConversation(session: AppSession, scope: SalesConversationScope, options: TenantTransactionOptions = {}) {
  websiteSalesActorAuthority(session, scope, "read", "autonomy"); return withCrmRead(session, (tx, fresh) => read(tx, fresh, scope), options);
}
function childStopKey(key: string, reason: string) { const h = crmPayloadDigest({ kind: "conversation-stop", key, reason }); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; }
async function stopAcquisition(session: AppSession, input: SalesConversationCommand, row: Workflow, reason: "OPT_OUT" | "REPLY_RECEIVED", sourceReference: string, options: TenantTransactionOptions) {
  if (row.status !== "STOPPED") await withWebsiteSalesConversationStop(session, () => runWebsiteSalesIrelandCommand(session, { contractVersion: websiteSalesIrelandContract, operation: "stop", projectId: row.projectId,
    companyId: row.companyId, locationId: row.locationId, expectedVersion: row.version, idempotencyKey: childStopKey(input.idempotencyKey, reason), correlationId: input.correlationId,
    payload: { reason, sourceReference } }, options));
}
async function stopCanonical(tx: TenantTransaction, session: AppSession, input: SalesConversationCommand, row: Workflow, sourceReference: string, options: TenantTransactionOptions) {
  await tx.execute("update contacts set consent_label='Abgemeldet',version=version+1,updated_at=now() where workspace_id=$1 and project_id=$2 and organization_id=$3 and id=$4", [session.workspaceId, row.projectId, row.companyId, row.contactId]);
  await tx.execute("insert into consent_records(workspace_id,project_id,contact_id,channel,status,source,metadata) values($1,$2,$3,'E-Mail','Abgemeldet','website-sales-topic-optout',$4::jsonb)", [session.workspaceId, row.projectId, row.contactId, JSON.stringify({ sourceReference, conversationCommandId: input.idempotencyKey })]);
  await stopAcquisition(session, input, row, "OPT_OUT", sourceReference, options);
}
async function persistConversation(tx: TenantTransaction, session: AppSession, row: Workflow, previous: Conversation | null, next: Conversation, commandId: string) {
  if (previous) {
    const changed = await tx.queryOne("update crm_website_sales_conversations set version=$4,status=$5,stop_reason=$6,last_command_id=$7,updated_at=now() where workspace_id=$1 and id=$2 and version=$3 returning id", [session.workspaceId, previous.id, previous.version, next.version, next.status, next.stopReason, commandId]);
    if (!changed) fail("CONVERSATION_VERSION_CONFLICT");
  } else await tx.execute(`insert into crm_website_sales_conversations(id,workspace_id,project_id,company_id,location_id,workflow_id,contact_id,version,status,stop_reason,last_command_id,created_by)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [next.id, session.workspaceId, row.projectId, row.companyId, row.locationId, row.id, row.contactId, next.version, next.status, next.stopReason, commandId, session.userId]);
}
async function insertTurn(tx: TenantTransaction, session: AppSession, row: Workflow, saved: Conversation, turn: StoredTurn, commandId: string, sourceUserId: string | null = null) {
  await tx.execute(`insert into crm_website_sales_conversation_turns(id,workspace_id,project_id,company_id,location_id,workflow_id,conversation_id,turn_index,kind,topic_turn_id,topic_code,language,source_kind,source_user_id,message_id,source_hash,evidence_digest,facts_digest,draft,created_by,command_id,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22)`, [turn.id, session.workspaceId, row.projectId, row.companyId, row.locationId, row.id, saved.id, turn.index, turn.kind, turn.topicTurnId,
    turn.topicCode, turn.language, turn.sourceKind, sourceUserId, turn.messageId, turn.sourceHash, row.evidenceDigest, turn.draft?.factsDigest ?? null,
    turn.draft ? JSON.stringify(turn.draft) : null, session.userId, commandId, turn.createdAt]);
}

export async function executeWebsiteSalesConversationCommand(session: AppSession, raw: SalesConversationCommand, options: TenantTransactionOptions = {}) {
  const input = parseWebsiteSalesConversationCommand(raw), command = websiteSalesConversationCommandInput(session, raw);
  return withCrmCommandPreflight(session, command, async (outer, fresh) => {
    // Same order as portfolio planning/claiming: project operations lock before workflow/location locks.
    // The lock grants no resource authority; a derived opt-out still needs no allocation or live lease.
    await outer.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`website-sales-operations:${fresh.workspaceId}:${input.projectId}`]);
    const run = () => executeCrmCommand(fresh, command, async (tx, context): Promise<SalesConversationEffect> => {
      let state = await websiteSalesIrelandState(tx, context.session, input, true), row = state.row;
      if (!row?.contactId || !row.leadId) fail("QUALIFIED_CONTACT_REQUIRED");
      if (row.version !== input.expectedWorkflowVersion) fail("WORKFLOW_VERSION_CONFLICT");
      const previous = await conversation(tx, fresh, input, true);
      if ((previous?.version ?? 0) !== input.expectedConversationVersion) fail("CONVERSATION_VERSION_CONFLICT");
      const reason = hardStop(state), next: Conversation = { id: previous?.id ?? randomUUID(), version: (previous?.version ?? 0) + 1,
        status: reason ? "STOPPED" : previous?.status ?? "OPEN", stopReason: reason ?? previous?.stopReason ?? null };
      const p = input.payload, now = new Date().toISOString(), effect: Omit<SalesConversationEffect, "workflow" | "conversation"> = { canContact: false };
      let loaded = await facts(tx, fresh, input, row);
      if (input.operation === "authorize_topic_extraction") {
        if (fresh.serviceIdentity) fail("HUMAN_ATTESTATION_REQUIRED", 403);
        const source = (await sources(tx, fresh, row, String(p.canonicalMessageId)))[0];
        if (!source || !source.canAuthorize || source.sourceUserId !== fresh.userId) fail("PERSONAL_MESSAGE_OWNER_REQUIRED", 403);
        const prior = await tx.queryOne<{ id: string; version: number; sourceHash: string; active: boolean }>(`select p.id,p.version,p.source_hash as "sourceHash",p.expires_at>now() and not exists(select 1 from crm_website_sales_topic_revocations r where r.workspace_id=p.workspace_id and r.permission_id=p.id) as active
          from crm_website_sales_topic_permissions p where p.workspace_id=$1 and p.workflow_id=$2 and p.message_id=$3 order by p.version desc limit 1`, [fresh.workspaceId, row.id, source.messageId]);
        const id = p.allow === false || prior?.active && prior.sourceHash === source.sourceHash ? prior?.id : randomUUID();
        if (p.allow === false) {
          if (!prior) fail("TOPIC_PERMISSION_NOT_FOUND", 404);
          await tx.execute(`insert into crm_website_sales_topic_revocations(id,workspace_id,project_id,company_id,location_id,workflow_id,permission_id,revoked_by)
            values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(workspace_id,permission_id) do nothing`, [randomUUID(), fresh.workspaceId, row.projectId, row.companyId, row.locationId, row.id, prior.id, fresh.userId]);
        } else {
          assertReady(state);
          if (!prior?.active || prior.sourceHash !== source.sourceHash) await tx.execute(`insert into crm_website_sales_topic_permissions(id,workspace_id,project_id,company_id,location_id,workflow_id,source_user_id,message_id,source_hash,authorized_by,version,expires_at)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$10,now()+interval '24 hours')`, [id, fresh.workspaceId, row.projectId, row.companyId, row.locationId, row.id, fresh.userId, source.messageId, source.sourceHash, Number(prior?.version ?? 0) + 1]);
        }
        effect.topicPermissionId = id; effect.messageId = source.messageId;
      } else if (input.operation === "record_answer_fact") {
        assertReady(state); if (!owner(fresh)) fail("SALES_FACT_OWNER_REQUIRED", 403);
        const businessPayload = { ...p }; delete businessPayload.resourceGrants;
        const parsed = payloads.record_answer_fact.parse(businessPayload);
        if (["PRICE", "DISCOUNT", "OBJECTION_PRICE"].includes(parsed.topicCode) || parsed.sourceReference.startsWith("crm-quote:") || /crm[-:]mail|mailto:/i.test(parsed.sourceReference)) fail("CANONICAL_PRICE_OR_PUBLIC_FACT_REQUIRED", 400);
        const last = await tx.queryOne<{ version: number }>("select version from crm_website_sales_answer_facts where workspace_id=$1 and workflow_id=$2 and topic_code=$3 order by version desc limit 1", [fresh.workspaceId, row.id, parsed.topicCode]);
        const fact: WebsiteSalesAnswerFact = websiteSalesAnswerFactSchema.parse({ id: randomUUID(), identity: { workspaceId: fresh.workspaceId, projectId: row.projectId, companyId: row.companyId, locationId: row.locationId }, version: Number(last?.version ?? 0) + 1,
          topicCode: parsed.topicCode, kind: parsed.topicCode === "SCOPE" ? "SCOPE_FACT" : parsed.topicCode === "PROCESS" ? "PROCESS_FACT" : "SOURCE_FACT", text: parsed.text,
          sourceReference: parsed.sourceReference, sourceDigest: crmPayloadDigest({ topicCode: parsed.topicCode, text: parsed.text, sourceReference: parsed.sourceReference }),
          observedAt: now, validUntil: parsed.validUntil, approvedBy: fresh.userId, approvedAt: now, classification: parsed.classification });
        if (websiteSalesConversationFactsDigest([fact], null, now) === websiteSalesConversationFactsDigest([], null, now)) fail("CURRENT_PUBLIC_SALES_FACT_REQUIRED", 400);
        await tx.execute(`insert into crm_website_sales_answer_facts(id,workspace_id,project_id,company_id,location_id,workflow_id,version,topic_code,fact,source_digest,evidence_digest,approved_by,created_at,valid_until)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)`, [fact.id, fresh.workspaceId, row.projectId, row.companyId, row.locationId, row.id, fact.version, fact.topicCode, JSON.stringify(fact), fact.sourceDigest, row.evidenceDigest, fresh.userId, now, fact.validUntil]);
        effect.factId = fact.id; loaded = await facts(tx, fresh, input, row);
      } else if (input.operation === "stop_conversation") {
        if (p.reason === "OPT_OUT") await stopCanonical(tx, fresh, input, row, `operator-recorded-dialogue-stop:${next.id}`, options);
        next.status = "STOPPED"; next.stopReason = reason ?? String(p.reason);
      } else {
        // Removing contact authority takes precedence over missing evidence and any earlier dialogue stop.
        // This branch is fed only by the current owner-authorized SQL extractor, never a caller topic flag.
        if (p.canonicalMessageId) {
          const stopSource = (await sources(tx, fresh, row, String(p.canonicalMessageId), String(p.language)))[0];
          if (stopSource?.authorized && stopSource.topicCode === "OPT_OUT") {
            const existing = await tx.queryOne<StoredTurn>(`select id,turn_index as index,kind,topic_turn_id as "topicTurnId",topic_code as "topicCode",language,source_kind as "sourceKind",message_id as "messageId",source_hash as "sourceHash",created_at::text as "createdAt",draft
              from crm_website_sales_conversation_turns where workspace_id=$1 and workflow_id=$2 and message_id=$3 and source_hash=$4 and kind='TOPIC_RECORDED'`, [fresh.workspaceId, row.id, stopSource.messageId, stopSource.sourceHash]);
            const last = await tx.queryOne<{ index: number }>("select coalesce(max(turn_index),0)::int as index from crm_website_sales_conversation_turns where workspace_id=$1 and workflow_id=$2", [fresh.workspaceId, row.id]);
            const topic: StoredTurn = existing ?? { id: randomUUID(), index: (last?.index ?? 0) + 1, kind: "TOPIC_RECORDED", topicTurnId: null, topicCode: "OPT_OUT", language: stopSource.language,
              sourceKind: "CANONICAL_TOPIC_EXTRACTION", messageId: stopSource.messageId, sourceHash: stopSource.sourceHash, createdAt: now, draft: null };
            await stopCanonical(tx, fresh, input, row, `crm-topic:${stopSource.messageId}:${stopSource.sourceHash}`, options);
            next.status = "STOPPED"; next.stopReason = "OPT_OUT";
            await persistConversation(tx, fresh, row, previous, next, context.commandId);
            if (!existing) await insertTurn(tx, fresh, row, next, topic, context.commandId, stopSource.sourceUserId);
            return { canContact: false, workflow: currentWorkflow(await websiteSalesIrelandState(tx, fresh, input)), conversation: summary(next, loaded.digest), topicTurnId: topic.id, messageId: stopSource.messageId };
          }
        }
        assertReady(state); if (previous?.status === "STOPPED") fail("CONVERSATION_STOPPED");
        if (p.canonicalMessageId && row.status !== "STOPPED") {
          const reply = (await sources(tx, fresh, row, String(p.canonicalMessageId), String(p.language)))[0];
          if (!reply?.authorized || ["CONTACT_STOPPED", "SOURCE_CHANGED", "PURPOSE_PERMISSION_REQUIRED"].includes(reply.blockedReason ?? "")) fail("TOPIC_PERMISSION_REQUIRED", 403);
          // Only a confirmed canonical reply ends the original acquisition sequence. Manual topics do not.
          await stopAcquisition(fresh, input, row, "REPLY_RECEIVED", `crm-topic:${reply.messageId}:${reply.sourceHash}`, options);
          state = await websiteSalesIrelandState(tx, fresh, input); row = state.row!;
          loaded = await facts(tx, fresh, input, row);
        }
        const turns = await storedTurns(tx, fresh, row), additions: { turn: StoredTurn; sourceUserId: string | null }[] = [];
        let topic: StoredTurn, sourceUserId: string | null = null;
        if (input.operation === "draft_answer") {
          const existing = turns.find(turn => turn.id === p.topicTurnId && turn.kind === "TOPIC_RECORDED"); if (!existing) fail("CONVERSATION_TOPIC_NOT_FOUND", 404); topic = existing;
          if (topic.sourceKind === "CANONICAL_TOPIC_EXTRACTION") {
            const source = (await sources(tx, fresh, row, topic.messageId, topic.language))[0];
            if (!source?.authorized || source.sourceHash !== topic.sourceHash || source.blockedReason === "CONTACT_STOPPED") fail("TOPIC_PERMISSION_REQUIRED", 403); sourceUserId = source.sourceUserId;
          }
          if (p.expectedFactsDigest !== loaded.digest) fail("SALES_CONVERSATION_FACTS_CHANGED");
        } else {
          let source: Source | undefined;
          if (p.canonicalMessageId) {
            source = (await sources(tx, fresh, row, String(p.canonicalMessageId), String(p.language)))[0];
            if (!source?.authorized || source.blockedReason === "CONTACT_STOPPED") fail("TOPIC_PERMISSION_REQUIRED", 403);
            if (p.topicCode !== undefined && p.topicCode !== source.topicCode) fail("CANONICAL_TOPIC_MISMATCH", 400); sourceUserId = source.sourceUserId;
          } else if (fresh.serviceIdentity) fail("HUMAN_ATTESTATION_REQUIRED", 403);
          const duplicate = source ? turns.find(turn => turn.kind === "TOPIC_RECORDED" && turn.messageId === source.messageId && turn.sourceHash === source.sourceHash) : null;
          topic = duplicate ?? { id: randomUUID(), index: (turns[0]?.index ?? 0) + 1, kind: "TOPIC_RECORDED", topicTurnId: null,
            topicCode: source?.topicCode ?? websiteSalesConversationTopicSchema.parse(p.topicCode), language: language.parse(p.language), sourceKind: source ? "CANONICAL_TOPIC_EXTRACTION" : "HUMAN_RECORDED_TOPIC",
            messageId: source?.messageId ?? null, sourceHash: source?.sourceHash ?? crmPayloadDigest({ identity: { workspaceId: fresh.workspaceId, ...input }, topicCode: p.topicCode, correlationId: input.correlationId }), createdAt: now, draft: null };
          if (!duplicate) additions.push({ turn: topic, sourceUserId });
        }
        effect.topicTurnId = topic.id; if (topic.messageId) effect.messageId = topic.messageId;
        if (topic.topicCode === "OPT_OUT") {
          await stopCanonical(tx, fresh, input, row, `crm-topic:${topic.messageId ?? topic.id}:${topic.sourceHash}`, options); next.status = "STOPPED"; next.stopReason = "OPT_OUT";
        } else if (input.operation !== "record_topic") {
          const prior = turns.find(turn => turn.topicTurnId === topic.id && turn.draft?.factsDigest === loaded.digest && turn.draft.evidenceDigest === row.evidenceDigest && turn.draft.workflowVersion === row.version);
          if (prior && !additions.length) return { workflow: currentWorkflow(state), conversation: summary(previous!, loaded.digest), topicTurnId: topic.id, draftTurnId: prior.id, ...(topic.messageId ? { messageId: topic.messageId } : {}), canContact: false };
          const draft = prepareWebsiteSalesConversationDraft({ identity: { workspaceId: fresh.workspaceId, projectId: row.projectId, companyId: row.companyId, locationId: row.locationId }, workflowVersion: row.version,
            evidenceDigest: row.evidenceDigest, conversationVersion: next.version, expectedFactsDigest: loaded.digest,
            topic: { id: topic.id, code: websiteSalesConversationReadiness(row.prospect, row.locationVersion, state.location.version, now).clarificationOnly ? "UNKNOWN" : topic.topicCode,
              messageId: topic.messageId, sourceHash: topic.sourceHash, sourceKind: topic.sourceKind, language: topic.language },
            facts: loaded.active, hardStop: false, quoteBinding: loaded.quoteBinding,
            previousAnswers: turns.filter(turn => turn.draft?.status === "DRAFT_READY").map(turn => ({ topicTurnId: turn.topicTurnId!, messageId: turn.messageId, sourceHash: turn.sourceHash, factsDigest: turn.draft!.factsDigest, draftDigest: turn.draft!.draftDigest })) }, now);
          const drafted: StoredTurn = { ...topic, id: randomUUID(), index: (turns[0]?.index ?? 0) + additions.length + 1, kind: draft.status === "WAITING_FOR_FACTS" ? "CLARIFICATION_REQUIRED" : "ANSWER_DRAFTED", topicTurnId: topic.id, draft };
          additions.push({ turn: drafted, sourceUserId }); effect.draftTurnId = drafted.id; next.status = draft.status; next.stopReason = draft.status === "STOPPED" ? "OPT_OUT" : null;
        } else next.status = "OPEN";
        await persistConversation(tx, fresh, row, previous, next, context.commandId);
        for (const addition of additions) await insertTurn(tx, fresh, row, next, addition.turn, context.commandId, addition.sourceUserId);
        return { ...effect, workflow: currentWorkflow(await websiteSalesIrelandState(tx, fresh, input)), conversation: summary(next, loaded.digest) };
      }
      await persistConversation(tx, fresh, row, previous, next, context.commandId);
      return { ...effect, workflow: currentWorkflow(await websiteSalesIrelandState(tx, fresh, input)), conversation: summary(next, loaded.digest) };
    }, options);
    // A server-derived opt-out only stops contact. No draft, price or next-action effect escapes its fence.
    let safetyOptOut = false;
    if (["advance_conversation", "record_topic"].includes(input.operation) && input.payload.canonicalMessageId) {
      const state = await websiteSalesIrelandState(outer, fresh, input, true);
      if (state.row && state.row.version === input.expectedWorkflowVersion) {
        const source = (await sources(outer, fresh, state.row, String(input.payload.canonicalMessageId), String(input.payload.language)))[0];
        safetyOptOut = source?.authorized === true && source.topicCode === "OPT_OUT";
      }
    }
    const result = safetyOptOut ? await run() : await withSalesAllocationFence(outer, fresh, input, "autonomy", raw as unknown as Record<string, unknown>, run);
    const current = await read(outer, fresh, input);
    return { ...result, data: { ...result.data, workflow: current.workflow, conversation: current.conversation! } };
  }, options);
}
export async function reconcileWebsiteSalesConversationCommand(session: AppSession, raw: SalesConversationCommand, options: TenantTransactionOptions = {}) {
  const input = parseWebsiteSalesConversationCommand(raw), command = websiteSalesConversationCommandInput(session, raw);
  return withCrmCommandPreflight(session, command, async (tx, fresh) => {
    const currentData = await read(tx, fresh, input), receipt = await reconcileCrmCommand<SalesConversationEffect>(fresh, command, options);
    return receipt.status === "COMMITTED" ? { ...receipt, currentData } : receipt;
  }, options);
}
