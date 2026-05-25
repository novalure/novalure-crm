import type { AppSession } from "@/lib/auth/session";
import type { BotEvaluationCaseResult, BotEvaluationRun } from "@/lib/crm-types";
import { writeCrmAnalyticsEvent } from "@/lib/db/analytics-event-repositories";
import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { recordSpeedToLeadEvent } from "@/lib/db/speed-to-lead-repositories";
import type { FunnelBlueprint, FunnelSubmissionPayload } from "@/lib/funnel-schema";
import { decryptSecret, encryptSecret } from "@/lib/integrations/secret-box";
import { hasProductCapability } from "@/lib/product-model";

type IdRow = { id: string };

type FunnelRow = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  ownerUserId: string | null;
  name: string;
};

type BotCrmContactInput = {
  consent?: string | null;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  preferredChannel?: string | null;
};

export type BotChannelAccountCredentials = {
  accessToken?: string | null;
  graphVersion?: string | null;
  instagramAccountId?: string | null;
  pageId?: string | null;
  phoneNumberId?: string | null;
  whatsappBusinessAccountId?: string | null;
};

export type BotCrmSyncResult = {
  contactCreated: boolean;
  contactId: string | null;
  leadCreated: boolean;
  leadId: string | null;
  timelineItemId: string | null;
};
const legacyProjectNames: Record<string, string> = {
  project_wohnpark_graz: "Wohnpark Graz",
  project_investment_wien: "Investment Wien",
  project_seller_linz: "Seller Leads Linz",
  project_novalure_eu: "Novalure.eu",
};

export type PersistenceResult =
  | { persisted: true; ids: Record<string, string | null> }
  | { persisted: false; reason: string };

export function canPersist() {
  return hasDatabaseUrl();
}

export function isUuid(value: string | undefined | null): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  );
}

function addParam(params: unknown[], value: unknown) {
  params.push(value);
  return `$${params.length}`;
}

function addUuidParam(params: unknown[], value: string | undefined | null) {
  return isUuid(value) ? addParam(params, value) : "null";
}

function cleanString(value: string | undefined | null) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toIso(value: string | Date | null | undefined) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

function toBotEvaluationRun(row: {
  botId: string | null;
  createdAt: string | Date;
  hallucinationFailures: number;
  handoffFailures: number;
  id: string;
  projectId: string | null;
  redTeamFailures: number;
  result: unknown;
  score: number;
  sourceCoverage: number | string;
  workspaceId: string;
}): BotEvaluationRun {
  const result = asPlainObject(row.result);
  const cases = Array.isArray(result.cases) ? result.cases as BotEvaluationCaseResult[] : [];

  return {
    botId: row.botId ?? undefined,
    cases,
    createdAt: toIso(row.createdAt),
    hallucinationFailures: Number(row.hallucinationFailures ?? 0),
    handoffFailures: Number(row.handoffFailures ?? 0),
    id: row.id,
    projectId: row.projectId ?? undefined,
    redTeamFailures: Number(row.redTeamFailures ?? 0),
    score: Number(row.score ?? 0),
    sourceCoverage: Number(row.sourceCoverage ?? 0),
    testSetVersion: typeof result.testSetVersion === "string" ? result.testSetVersion : "unknown",
    workspaceId: row.workspaceId,
  };
}

function normalizeEmailForStorage(value: string | undefined | null) {
  const email = cleanString(value).toLowerCase();

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function extractEmail(value: string) {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
}

function extractName(value: string) {
  const match = value.match(
    /(?:mein name ist|ich bin|name ist|i am|my name is)\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß .'-]{1,70})/iu,
  );

  return match?.[1]?.replace(/\s+(?:und|and)\s+.*$/i, "").trim() ?? "";
}

function extractPhone(value: string) {
  const match = value.match(/(?:\+|00)?\d[\d\s()./-]{7,}\d/);
  return match?.[0] ?? "";
}

function normalizePhoneForMatch(value: string | undefined | null) {
  const phone = cleanString(value);
  if (!phone) return "";

  return phone.replace(/^00/, "").replace(/[^0-9]/g, "");
}

function formatPhoneForCrm(value: string | undefined | null) {
  const normalized = normalizePhoneForMatch(value);
  if (!normalized) return "";

  return "+" + normalized;
}

function normalizeLeadType(value: string | undefined | null) {
  const prompt = cleanString(value).toLowerCase();

  if (/(verkauf|verkaufen|verk(?:ae|ä)ufer|eigent|bewertung|makler)/i.test(prompt)) return "Verkäufer";
  if (/(invest|anlage|rendite|kapital)/i.test(prompt)) return "Investor";
  if (/(bautraeger|bauträger|projektentwicklung)/i.test(prompt)) return "Bauträger";

  return "Käufer";
}

function normalizeConsentLabel(value: string | undefined | null) {
  const consent = cleanString(value).toLowerCase();

  if (/(opt.??in|ja|yes|true|einwilligung|zugestimmt)/i.test(consent)) return "Opt-in";

  return "Nur CRM";
}

function statusFromScore(score: number | null | undefined) {
  return typeof score === "number" && score >= 70 ? "Termin offen" : "Qualifizieren";
}
export async function writeAuditLog(input: {
  session: AppSession;
  action: string;
  entityType: string;
  entityId?: string | null;
  projectId?: string | null;
  dealId?: string | null;
  before?: unknown;
  after?: unknown;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return;

  const params: unknown[] = [input.session.workspaceId];
  const projectSql = addUuidParam(params, input.projectId);
  const dealSql = addUuidParam(params, input.dealId);
  const actorSql = addUuidParam(params, input.session.userId);
  const actionSql = addParam(params, input.action);
  const entityTypeSql = addParam(params, input.entityType);
  const entityIdSql = addUuidParam(params, input.entityId);
  const beforeSql = addParam(params, JSON.stringify(input.before ?? null));
  const afterSql = addParam(params, JSON.stringify(withManagedServiceAuditContext(input)));

  await queryOne(
    `
      insert into audit_logs (
        workspace_id,
        project_id,
        deal_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        before,
        after
      )
      values (
        $1,
        ${projectSql},
        ${dealSql},
        ${actorSql},
        ${actionSql},
        ${entityTypeSql},
        ${entityIdSql},
        ${beforeSql}::jsonb,
        ${afterSql}::jsonb
      )
      returning id
    `,
    params,
  );
}

function withManagedServiceAuditContext(input: {
  after?: unknown;
  projectId?: string | null;
  session: AppSession;
}) {
  const includeContext =
    input.session.workspaceOperatingModel === "managed_by_novalure" ||
    hasProductCapability(input.session.productRole, "managed-service:operate");

  if (!includeContext) return input.after ?? null;

  const context = {
    actingOnBehalfOfCustomerName: input.session.workspaceName,
    actorProductRole: input.session.productRole,
    selectedCustomerWorkspaceId: input.session.workspaceId,
    selectedProjectId: input.projectId ?? null,
  };

  if (input.after && typeof input.after === "object" && !Array.isArray(input.after)) {
    return {
      ...input.after,
      managedServiceContext: context,
    };
  }

  return {
    managedServiceContext: context,
    value: input.after ?? null,
  };
}

export async function createApprovalRequest(input: {
  session: AppSession;
  projectId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  summary: string;
  payload: unknown;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return null;
  }

  const params: unknown[] = [input.session.workspaceId];
  const projectSql = addUuidParam(params, input.projectId);
  const requestedBySql = addUuidParam(params, input.session.userId);
  const entityTypeSql = addParam(params, input.entityType);
  const entityIdSql = addUuidParam(params, input.entityId);
  const actionSql = addParam(params, input.action);
  const summarySql = addParam(params, input.summary);
  const payloadSql = addParam(params, JSON.stringify(input.payload ?? {}));

  const row = await queryOne<IdRow>(
    `
      insert into approval_requests (
        workspace_id,
        project_id,
        requested_by_user_id,
        entity_type,
        entity_id,
        action,
        summary,
        payload
      )
      values (
        $1,
        ${projectSql},
        ${requestedBySql},
        ${entityTypeSql},
        ${entityIdSql},
        ${actionSql},
        ${summarySql},
        ${payloadSql}::jsonb
      )
      returning id
    `,
    params,
  );

  return row?.id ?? null;
}

export async function persistFunnelSubmission(input: {
  session: AppSession;
  blueprint: FunnelBlueprint;
  payload: FunnelSubmissionPayload;
  score: number;
}): Promise<PersistenceResult> {
  if (!canPersist()) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const funnel = await getOrCreateSubmissionFunnel(input.session, input.blueprint);

  if (!funnel) {
    return { persisted: false, reason: "Funnel not found in database" };
  }

  const contactName = getAnswerString(input.payload.answers, ["name", "full_name", "fullname", "contact_name"]) || "Funnel Lead";
  const email = getAnswerString(input.payload.answers, ["email", "e_mail", "mail"]);
  const phone = getAnswerString(input.payload.answers, ["phone", "telefon", "telephone"]);
  const intent = getAnswerString(input.payload.answers, ["intent", "bedarf", "interest", "interesse"]) || input.blueprint.goal;
  const budget = getAnswerString(input.payload.answers, ["budget", "price", "preis"]);
  const leadType = input.blueprint.audience;
  const now = new Date().toISOString();
  const slaDueAt = new Date(Date.now() + 1000 * 60 * 60 * 4).toISOString();
  const hotStatus = input.score >= 70;

  const contact = email
    ? await queryOne<IdRow>(
        `
          insert into contacts (
            workspace_id, project_id, name, role, source, intent, consent_label, email, phone, metadata
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          on conflict do nothing
          returning id
        `,
        [
          input.session.workspaceId,
          funnel.projectId,
          contactName,
          leadType,
          input.blueprint.entryChannel,
          intent,
          input.payload.consent.marketing ? "Opt-in" : "Nur CRM",
          email,
          phone,
          JSON.stringify({ visitor: input.payload.visitor, utm: input.payload.utm ?? {} }),
        ],
      )
    : null;

  const contactId =
    contact?.id ??
    (
      await queryOne<IdRow>(
        `
          insert into contacts (
            workspace_id, project_id, name, role, source, intent, consent_label, email, phone, metadata
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          funnel.projectId,
          contactName,
          leadType,
          input.blueprint.entryChannel,
          intent,
          input.payload.consent.marketing ? "Opt-in" : "Nur CRM",
          email,
          phone,
          JSON.stringify({ visitor: input.payload.visitor, utm: input.payload.utm ?? {} }),
        ],
      )
    )?.id;

  const lead = input.blueprint.crmHandover.createLeadInboxEntry
    ? await queryOne<IdRow>(
        `
          insert into leads (
            workspace_id,
            project_id,
            contact_id,
            assigned_to_user_id,
            source,
            type,
            status,
            score,
            budget,
            intent,
            next_action,
            received_at,
            sla_due_at,
            hot_status,
            metadata
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz,
            $13::timestamptz, $14, $15::jsonb
          )
          returning id
        `,
        [
          input.session.workspaceId,
          funnel.projectId,
          contactId,
          funnel.ownerUserId,
          input.blueprint.entryChannel,
          leadType,
          hotStatus ? "Termin offen" : "Qualifizieren",
          input.score,
          budget,
          intent,
          input.blueprint.crmHandover.followUp,
          now,
          slaDueAt,
          hotStatus,
          JSON.stringify({ answers: input.payload.answers, consent: input.payload.consent }),
        ],
      )
    : null;

  const submission = await queryOne<IdRow>(
    `
      insert into funnel_submissions (
        workspace_id, project_id, funnel_id, contact_id, lead_id, mode, score, answers, consent, tracking, raw_payload
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
      returning id
    `,
    [
      input.session.workspaceId,
      funnel.projectId,
      funnel.id,
      contactId,
      lead?.id ?? null,
      input.payload.mode,
      input.score,
      JSON.stringify(input.payload.answers),
      JSON.stringify(input.payload.consent),
      JSON.stringify({ utm: input.payload.utm ?? {}, visitor: input.payload.visitor }),
      JSON.stringify(input.payload),
    ],
  );

  const deal =
    input.blueprint.crmHandover.destination === "pipeline"
      ? await queryOne<IdRow>(
          `
            insert into deals (
              workspace_id, project_id, contact_id, owner_user_id, lead_id, name, stage, probability, source, next_action, metadata
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
            returning id
          `,
          [
            input.session.workspaceId,
            funnel.projectId,
            contactId,
            funnel.ownerUserId,
            lead?.id ?? null,
            `${contactName} - ${funnel.name}`,
            input.blueprint.crmHandover.pipelineStage || "Neuer Lead",
            Math.min(95, Math.max(10, input.score)),
            input.blueprint.entryChannel,
            input.blueprint.crmHandover.followUp,
            JSON.stringify({ submissionId: submission?.id }),
          ],
    )
    : null;

  if (contactId && input.payload.consent.privacy) {
    await queryOne(
      `
        insert into consent_records (workspace_id, contact_id, project_id, channel, status, source, metadata)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        returning id
      `,
      [
        input.session.workspaceId,
        contactId,
        funnel.projectId,
        "Funnel",
        "Opt-in",
        funnel.name,
        JSON.stringify({ funnelId: funnel.id, submissionMode: input.payload.mode, consent: input.payload.consent }),
      ],
    );
  }

  if (contactId && input.payload.consent.marketing) {
    await queryOne(
      `
        insert into consent_records (workspace_id, contact_id, project_id, channel, status, source, metadata)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        returning id
      `,
      [
        input.session.workspaceId,
        contactId,
        funnel.projectId,
        "Newsletter",
        "Opt-in",
        funnel.name,
        JSON.stringify({ funnelId: funnel.id, submissionMode: input.payload.mode, consent: input.payload.consent }),
      ],
    );
  }

  const task = input.blueprint.crmHandover.createTask
    ? await queryOne<IdRow>(
        `
          insert into tasks (workspace_id, project_id, contact_id, lead_id, owner_user_id, title, due_at, priority, status, metadata)
          values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, 'open', $9::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          funnel.projectId,
          contactId,
          lead?.id ?? null,
          funnel.ownerUserId,
          input.blueprint.crmHandover.followUp || "Review funnel lead",
          new Date(Date.now() + 1000 * 60 * 60 * 2).toISOString(),
          hotStatus ? "Hoch" : "Mittel",
          JSON.stringify({ submissionId: submission?.id }),
        ],
      )
    : null;

  const timelineItem = contactId
    ? await queryOne<IdRow>(
        `
          insert into contact_timeline_items (
            workspace_id, contact_id, project_id, channel, title, detail, outcome, metadata
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          contactId,
          funnel.projectId,
          input.blueprint.entryChannel,
          "Funnel submission",
          `${intent} · Score ${input.score}`,
          hotStatus ? "offen" : "info",
          JSON.stringify({ submissionId: submission?.id, leadId: lead?.id ?? null }),
        ],
      )
    : null;

  await queryOne(
    `
      update funnels
      set leads_count = leads_count + 1,
          conversion_rate = case when visits > 0 then round(((leads_count + 1)::numeric / visits::numeric) * 100, 2) else conversion_rate end,
          updated_at = now()
      where id = $1
      returning id
    `,
    [funnel.id],
  );

  await Promise.all([
    writeAuditLog({
      session: input.session,
      action: "funnel.submission.persisted",
      entityType: "funnel_submission",
      entityId: submission?.id,
      after: { contactId, leadId: lead?.id ?? null, dealId: deal?.id ?? null, taskId: task?.id ?? null },
    }),
    writeCrmAnalyticsEvent({
      channel: input.blueprint.entryChannel,
      contactId,
      dealId: deal?.id ?? null,
      entityId: submission?.id ?? null,
      entityType: "funnel_submission",
      eventType: "funnel_submit",
      funnelId: funnel.id,
      leadId: lead?.id ?? null,
      metadata: {
        answers: input.payload.answers,
        consent: input.payload.consent,
        destination: input.blueprint.crmHandover.destination,
        mode: input.payload.mode,
        score: input.score,
        taskId: task?.id ?? null,
        utm: input.payload.utm ?? {},
        visitor: input.payload.visitor,
      },
      module: "funnel",
      projectId: funnel.projectId,
      source: input.blueprint.entryChannel,
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
    lead?.id
      ? writeCrmAnalyticsEvent({
          channel: input.blueprint.entryChannel,
          contactId,
          dealId: deal?.id ?? null,
          entityId: lead.id,
          entityType: "lead",
          eventType: "lead_created",
          funnelId: funnel.id,
          leadId: lead.id,
          metadata: {
            score: input.score,
            slaHours: 4,
            status: hotStatus ? "Termin offen" : "Qualifizieren",
            trigger: "funnel_submit",
          },
          module: "lead_inbox",
          projectId: funnel.projectId,
          source: input.blueprint.entryChannel,
          userId: input.session.userId,
          workspaceId: input.session.workspaceId,
        })
      : null,
    lead?.id
      ? recordSpeedToLeadEvent({
          channel: input.blueprint.entryChannel,
          contactId,
          dueAt: slaDueAt,
          leadId: lead.id,
          metadata: {
            score: input.score,
            sourcePayload: "funnel_submission",
            submissionId: submission?.id ?? null,
            trigger: "funnel_submit",
          },
          ownerUserId: funnel.ownerUserId,
          projectId: funnel.projectId,
          source: input.blueprint.entryChannel,
          state: "covered",
          userId: input.session.userId,
          workspaceId: input.session.workspaceId,
        })
      : null,
  ]);

  return {
    persisted: true,
    ids: {
      submissionId: submission?.id ?? null,
      contactId: contactId ?? null,
      leadId: lead?.id ?? null,
      dealId: deal?.id ?? null,
      taskId: task?.id ?? null,
      timelineItemId: timelineItem?.id ?? null,
    },
  };
}

export async function persistFunnelTestSubmission(input: {
  session: AppSession;
  blueprint: FunnelBlueprint;
  payload: FunnelSubmissionPayload;
  score: number;
}): Promise<PersistenceResult> {
  if (!canPersist()) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const funnel = await getOrCreateSubmissionFunnel(input.session, input.blueprint);
  if (!funnel) {
    return { persisted: false, reason: "Funnel not found in database" };
  }

  const submission = await queryOne<IdRow>(
    `
      insert into funnel_submissions (
        workspace_id, project_id, funnel_id, mode, score, answers, consent, tracking, raw_payload
      )
      values ($1, $2, $3, 'test', $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
      returning id
    `,
    [
      input.session.workspaceId,
      funnel.projectId,
      funnel.id,
      input.score,
      JSON.stringify(input.payload.answers),
      JSON.stringify(input.payload.consent),
      JSON.stringify({ utm: input.payload.utm ?? {}, visitor: input.payload.visitor, test: true }),
      JSON.stringify({ ...input.payload, mode: "test" }),
    ],
  );

  await Promise.all([
    writeAuditLog({
      session: input.session,
      action: "funnel.submission.test_persisted",
      entityType: "funnel_submission",
      entityId: submission?.id,
      after: { funnelId: funnel.id, mode: "test", score: input.score },
    }),
    writeCrmAnalyticsEvent({
      channel: input.blueprint.entryChannel,
      entityId: submission?.id ?? null,
      entityType: "funnel_submission",
      eventType: "funnel_submit",
      funnelId: funnel.id,
      metadata: {
        consent: input.payload.consent,
        mode: "test",
        score: input.score,
        testSubmission: true,
        utm: input.payload.utm ?? {},
        visitor: input.payload.visitor,
      },
      module: "funnel",
      projectId: funnel.projectId,
      source: input.blueprint.entryChannel,
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return {
    persisted: true,
    ids: {
      submissionId: submission?.id ?? null,
      contactId: null,
      leadId: null,
      dealId: null,
      taskId: null,
      timelineItemId: null,
    },
  };
}

async function getOrCreateSubmissionFunnel(session: AppSession, blueprint: FunnelBlueprint) {
  const existing = await queryOne<FunnelRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        owner_user_id as "ownerUserId",
        name
      from funnels
      where workspace_id = $1
        and (
          ($2::uuid is not null and id = $2::uuid)
          or tracking->>'legacyId' = $3
          or name = $4
        )
      order by updated_at desc
      limit 1
    `,
    [session.workspaceId, isUuid(blueprint.id) ? blueprint.id : null, blueprint.id, blueprint.name],
  );

  if (existing) return existing;

  const projectId = await resolveSubmissionProjectId(session.workspaceId, blueprint.projectId);
  const ownerUserId = isUuid(session.userId) ? session.userId : null;
  const status = blueprint.status === "aktiv" ? "aktiv" : blueprint.status === "optimieren" ? "optimieren" : "entwurf";

  return queryOne<FunnelRow>(
    `
      insert into funnels (
        workspace_id,
        project_id,
        owner_user_id,
        name,
        goal,
        audience,
        entry_channel,
        status,
        blueprint,
        tracking
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
      returning
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        owner_user_id as "ownerUserId",
        name
    `,
    [
      session.workspaceId,
      projectId,
      ownerUserId,
      blueprint.name,
      blueprint.goal,
      blueprint.audience,
      blueprint.entryChannel,
      status,
      JSON.stringify(blueprint),
      JSON.stringify({
        legacyId: blueprint.id,
        legacyProjectId: blueprint.projectId,
        consentMode: blueprint.tracking.consentMode,
        createdFromSubmission: true,
      }),
    ],
  );
}

async function resolveSubmissionProjectId(workspaceId: string, projectId: string) {
  if (isUuid(projectId)) {
    const existing = await queryOne<IdRow>(
      `
        select id
        from projects
        where id = $1 and workspace_id = $2
        limit 1
      `,
      [projectId, workspaceId],
    );

    if (existing) return existing.id;
  }

  const legacyName = legacyProjectNames[projectId];
  const project = legacyName
    ? await queryOne<IdRow>(
        `
          select id
          from projects
          where workspace_id = $1 and name = $2
          limit 1
        `,
        [workspaceId, legacyName],
      )
    : null;

  if (project) return project.id;

  const fallback = await queryOne<IdRow>(
    `
      select id
      from projects
      where workspace_id = $1
      order by created_at asc
      limit 1
    `,
    [workspaceId],
  );

  return fallback?.id ?? null;
}

export async function insertKnowledgeSourceWithChunks(input: {
  session: AppSession;
  projectId?: string | null;
  title: string;
  sourceType: string;
  location?: string;
  status: string;
  chunks: Array<{
    chunkIndex: number;
    content: string;
    tokenCount: number;
    citationTitle: string;
    citationUrl?: string;
    embedding?: number[];
    embeddingModel?: string;
  }>;
  metadata?: unknown;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return null;
  }

  const params: unknown[] = [input.session.workspaceId];
  const projectSql = addUuidParam(params, input.projectId);
  const titleSql = addParam(params, input.title);
  const sourceTypeSql = addParam(params, input.sourceType);
  const statusSql = addParam(params, input.status);
  const countSql = addParam(params, input.chunks.length);
  const locationSql = addParam(params, input.location ?? null);
  const metadataSql = addParam(params, JSON.stringify(input.metadata ?? {}));

  const source = await queryOne<IdRow>(
    `
      insert into knowledge_sources (
        workspace_id, project_id, name, source_type, status, item_count, location, metadata
      )
      values ($1, ${projectSql}, ${titleSql}, ${sourceTypeSql}, ${statusSql}, ${countSql}, ${locationSql}, ${metadataSql}::jsonb)
      returning id
    `,
    params,
  );

  if (!source) return null;

  for (const chunk of input.chunks) {
    const chunkParams: unknown[] = [source.id];
    const indexSql = addParam(chunkParams, chunk.chunkIndex);
    const contentSql = addParam(chunkParams, chunk.content);
    const titleSql = addParam(chunkParams, chunk.citationTitle);
    const urlSql = addParam(chunkParams, chunk.citationUrl ?? null);
    const embeddingSql = chunk.embedding?.length ? `${addParam(chunkParams, `[${chunk.embedding.join(",")}]`)}::vector` : "null";
    const tokenSql = addParam(chunkParams, chunk.tokenCount);
    const modelSql = addParam(chunkParams, chunk.embeddingModel ?? null);
    const metadataSql = addParam(
      chunkParams,
      JSON.stringify({ embeddingReady: Boolean(chunk.embedding), embedding: chunk.embedding ? "stored" : null }),
    );

    await queryOne(
      `
        insert into knowledge_chunks (
          source_id, chunk_index, content, citation_title, citation_url, embedding, token_count, embedding_model, metadata
        )
        values ($1, ${indexSql}, ${contentSql}, ${titleSql}, ${urlSql}, ${embeddingSql}, ${tokenSql}, ${modelSql}, ${metadataSql}::jsonb)
        returning id
      `,
      chunkParams,
    );
  }

  await writeAuditLog({
    session: input.session,
    action: "knowledge.source.imported",
    entityType: "knowledge_source",
    entityId: source.id,
    after: { chunks: input.chunks.length, status: input.status },
  });

  return source.id;
}

export async function listKnowledgeSources(input: {
  session: AppSession;
  limit?: number;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return [];
  }

  return queryRows<{
    id: string;
    projectId: string | null;
    title: string;
    sourceType: string;
    status: string;
    location: string | null;
    itemCount: number;
    chunkCount: number;
    embeddedChunkCount: number;
    createdAt: string | Date;
    updatedAt: string | Date;
  }>(
    `
      select
        ks.id,
        ks.project_id as "projectId",
        ks.name as title,
        ks.source_type as "sourceType",
        ks.status,
        ks.location,
        ks.item_count as "itemCount",
        count(kc.id)::int as "chunkCount",
        count(kc.embedding)::int as "embeddedChunkCount",
        ks.created_at as "createdAt",
        ks.updated_at as "updatedAt"
      from knowledge_sources ks
      left join knowledge_chunks kc on kc.source_id = ks.id
      where ks.workspace_id = $1
      group by ks.id
      order by ks.updated_at desc, ks.created_at desc
      limit $2
    `,
    [input.session.workspaceId, input.limit ?? 50],
  );
}

export async function searchPersistedKnowledge(input: {
  session: AppSession;
  query: string;
  embedding?: number[];
  limit?: number;
  projectId?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return [];
  }

  const projectId = isUuid(input.projectId) ? input.projectId : null;

  if (input.embedding?.length) {
    const vectorResults = await queryRows<{
      chunkId: string;
      sourceId: string;
      title: string;
      excerpt: string;
      content: string;
      citationUrl: string | null;
      embeddingModel: string | null;
      score: number;
    }>(
      `
        select
          kc.id as "chunkId",
          ks.id as "sourceId",
          kc.citation_title as title,
          left(kc.content, 280) as excerpt,
          kc.content,
          kc.citation_url as "citationUrl",
          kc.embedding_model as "embeddingModel",
          greatest(0, 1 - (kc.embedding <=> $2::vector)) as score
        from knowledge_chunks kc
        join knowledge_sources ks on ks.id = kc.source_id
        where ks.workspace_id = $1
          and kc.embedding is not null
          and ($4::uuid is null or ks.project_id is null or ks.project_id = $4::uuid)
          and (
            ks.status in ('Vector bereit', 'vector_ready', 'approved', 'synced')
            or lower(coalesce(ks.metadata->>'approval', '')) in ('approved', 'freigegeben')
          )
        order by kc.embedding <=> $2::vector
        limit $3
      `,
      [input.session.workspaceId, `[${input.embedding.join(",")}]`, input.limit ?? 5, projectId],
    );

    if (vectorResults.length) {
      return vectorResults;
    }
  }

  return queryRows<{
    chunkId: string;
    sourceId: string;
    title: string;
    excerpt: string;
    content: string;
    citationUrl: string | null;
    embeddingModel: string | null;
    score: number;
  }>(
    `
      select
        kc.id as "chunkId",
        ks.id as "sourceId",
        kc.citation_title as title,
        left(kc.content, 280) as excerpt,
        kc.content,
        kc.citation_url as "citationUrl",
        kc.embedding_model as "embeddingModel",
        ts_rank_cd(to_tsvector('simple', kc.content || ' ' || kc.citation_title), plainto_tsquery('simple', $2)) as score
      from knowledge_chunks kc
      join knowledge_sources ks on ks.id = kc.source_id
      where ks.workspace_id = $1
        and ($4::uuid is null or ks.project_id is null or ks.project_id = $4::uuid)
        and (
          ks.status in ('Vector bereit', 'vector_ready', 'approved', 'synced')
          or lower(coalesce(ks.metadata->>'approval', '')) in ('approved', 'freigegeben')
        )
        and to_tsvector('simple', kc.content || ' ' || kc.citation_title) @@ plainto_tsquery('simple', $2)
      order by score desc
      limit $3
    `,
    [input.session.workspaceId, input.query, input.limit ?? 5, projectId],
  );
}

export async function insertBotEvaluationRun(input: {
  botId?: string | null;
  cases: BotEvaluationCaseResult[];
  hallucinationFailures: number;
  handoffFailures: number;
  projectId?: string | null;
  redTeamFailures: number;
  result: unknown;
  score: number;
  session: AppSession;
  sourceCoverage: number;
  testSetVersion: string;
}): Promise<BotEvaluationRun | null> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  const params: unknown[] = [input.session.workspaceId];
  const projectSql = addUuidParam(params, input.projectId);
  const botSql = addUuidParam(params, input.botId);
  const scoreSql = addParam(params, Math.max(0, Math.min(100, Math.round(input.score))));
  const sourceCoverageSql = addParam(params, input.sourceCoverage);
  const hallucinationSql = addParam(params, input.hallucinationFailures);
  const handoffSql = addParam(params, input.handoffFailures);
  const redTeamSql = addParam(params, input.redTeamFailures);
  const resultSql = addParam(
    params,
    JSON.stringify({
      ...asPlainObject(input.result),
      cases: input.cases,
      testSetVersion: input.testSetVersion,
    }),
  );

  const row = await queryOne<{
    botId: string | null;
    createdAt: string | Date;
    hallucinationFailures: number;
    handoffFailures: number;
    id: string;
    projectId: string | null;
    redTeamFailures: number;
    result: unknown;
    score: number;
    sourceCoverage: number | string;
    workspaceId: string;
  }>(
    `
      insert into bot_evaluation_runs (
        workspace_id,
        project_id,
        bot_id,
        score,
        source_coverage,
        hallucination_failures,
        handoff_failures,
        red_team_failures,
        result
      )
      values (
        $1,
        ${projectSql},
        ${botSql},
        ${scoreSql},
        ${sourceCoverageSql},
        ${hallucinationSql},
        ${handoffSql},
        ${redTeamSql},
        ${resultSql}::jsonb
      )
      returning
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        bot_id as "botId",
        score,
        source_coverage as "sourceCoverage",
        hallucination_failures as "hallucinationFailures",
        handoff_failures as "handoffFailures",
        red_team_failures as "redTeamFailures",
        result,
        created_at as "createdAt"
    `,
    params,
  );

  if (!row) return null;

  await writeAuditLog({
    session: input.session,
    action: "bot.evaluation.run_created",
    entityType: "bot_evaluation_run",
    entityId: row.id,
    projectId: row.projectId,
    after: {
      botId: row.botId,
      score: row.score,
      sourceCoverage: row.sourceCoverage,
      testSetVersion: input.testSetVersion,
    },
  });

  return toBotEvaluationRun(row);
}

export async function listBotEvaluationRuns(input: {
  botId?: string | null;
  projectId?: string | null;
  session: AppSession;
  limit?: number;
}): Promise<BotEvaluationRun[]> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return [];

  const botId = isUuid(input.botId) ? input.botId : null;
  const projectId = isUuid(input.projectId) ? input.projectId : null;

  const rows = await queryRows<{
    botId: string | null;
    createdAt: string | Date;
    hallucinationFailures: number;
    handoffFailures: number;
    id: string;
    projectId: string | null;
    redTeamFailures: number;
    result: unknown;
    score: number;
    sourceCoverage: number | string;
    workspaceId: string;
  }>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        bot_id as "botId",
        score,
        source_coverage as "sourceCoverage",
        hallucination_failures as "hallucinationFailures",
        handoff_failures as "handoffFailures",
        red_team_failures as "redTeamFailures",
        result,
        created_at as "createdAt"
      from bot_evaluation_runs
      where workspace_id = $1
        and ($2::uuid is null or bot_id = $2::uuid)
        and ($3::uuid is null or project_id = $3::uuid)
      order by created_at desc
      limit $4
    `,
    [input.session.workspaceId, botId, projectId, input.limit ?? 20],
  );

  return rows.map(toBotEvaluationRun);
}

export async function getOrCreateBotConversation(input: {
  session: AppSession;
  conversationId?: string | null;
  projectId?: string | null;
  botId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  title: string;
  language: string;
  model: string;
  metadata?: unknown;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  if (isUuid(input.conversationId)) {
    const existing = await queryOne<IdRow>(
      `
        select id
        from bot_conversations
        where id = $1 and workspace_id = $2
        limit 1
      `,
      [input.conversationId, input.session.workspaceId],
    );

    if (existing) return existing.id;
  }

  const params: unknown[] = [input.session.workspaceId];
  const projectSql = addUuidParam(params, input.projectId);
  const botSql = addUuidParam(params, input.botId);
  const contactSql = addUuidParam(params, input.contactId);
  const leadSql = addUuidParam(params, input.leadId);
  const titleSql = addParam(params, input.title);
  const languageSql = addParam(params, input.language);
  const modelSql = addParam(params, input.model);
  const metadataSql = addParam(params, JSON.stringify(input.metadata ?? {}));

  const row = await queryOne<IdRow>(
    `
      insert into bot_conversations (
        workspace_id, project_id, bot_id, contact_id, lead_id, title, language, model, metadata
      )
      values ($1, ${projectSql}, ${botSql}, ${contactSql}, ${leadSql}, ${titleSql}, ${languageSql}, ${modelSql}, ${metadataSql}::jsonb)
      returning id
    `,
    params,
  );

  return row?.id ?? null;
}

export async function listBotConversations(input: {
  session: AppSession;
  limit?: number;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return [];

  return queryRows<{
    id: string;
    title: string;
    status: string;
    language: string;
    model: string;
    projectId: string | null;
    botId: string | null;
    contactId: string | null;
    leadId: string | null;
    latestMessageRole: "system" | "user" | "assistant" | "tool" | null;
    latestMessageContent: string | null;
    latestMessageCreatedAt: string | Date | null;
    latestMessageMetadata: unknown;
    createdAt: string;
    updatedAt: string;
  }>(
    `
      select
        c.id,
        c.title,
        c.status,
        c.language,
        c.model,
        c.project_id as "projectId",
        c.bot_id as "botId",
        c.contact_id as "contactId",
        c.lead_id as "leadId",
        lm.role as "latestMessageRole",
        lm.content as "latestMessageContent",
        lm.created_at as "latestMessageCreatedAt",
        lm.metadata as "latestMessageMetadata",
        c.created_at as "createdAt",
        c.updated_at as "updatedAt"
      from bot_conversations c
      left join lateral (
        select role, content, created_at, metadata
        from bot_messages
        where workspace_id = c.workspace_id
          and conversation_id = c.id
        order by created_at desc
        limit 1
      ) lm on true
      where c.workspace_id = $1
      order by c.updated_at desc
      limit $2
    `,
    [input.session.workspaceId, input.limit ?? 25],
  );
}

export async function getDefaultWorkspaceForWebhook() {
  if (!canPersist()) return null;

  const configuredWorkspaceId = process.env.NOVALURE_WORKSPACE_ID;

  if (isUuid(configuredWorkspaceId)) {
    const configured = await queryOne<{ id: string; name: string }>(
      `
        select id, name
        from workspaces
        where id = $1
        limit 1
      `,
      [configuredWorkspaceId],
    );

    if (configured) return configured;
  }

  return queryOne<{ id: string; name: string }>(
    `
      select id, name
      from workspaces
      order by created_at asc
      limit 1
    `,
  );
}

export async function upsertBotCrmEntities(input: {
  session: AppSession;
  projectId?: string | null;
  channel: string;
  contactRef?: string | null;
  customerData?: BotCrmContactInput | null;
  externalMessageId?: string | null;
  nextAction?: string | null;
  prompt: string;
  score?: number | null;
  webhookEventId?: string | null;
}): Promise<BotCrmSyncResult | null> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  const now = new Date().toISOString();
  const slaDueAt = new Date(Date.now() + 1000 * 60 * 60 * 4).toISOString();
  const email = cleanString(input.customerData?.email) || extractEmail(input.prompt);
  const phone = formatPhoneForCrm(input.customerData?.phone || input.contactRef || extractPhone(input.prompt));
  const phoneMatch = normalizePhoneForMatch(phone);
  const extractedName = cleanString(input.customerData?.name) || extractName(input.prompt);
  const name = extractedName || (phone ? "WhatsApp " + phone : "WhatsApp Kontakt");
  const leadType = normalizeLeadType(input.prompt);
  const source = cleanString(input.channel) || "Bot";
  const consentLabel = normalizeConsentLabel(input.customerData?.consent);
  const score = Math.min(100, Math.max(0, Math.round(typeof input.score === "number" ? input.score : 50)));
  const hotStatus = score >= 70;
  const intent = input.prompt.slice(0, 260);
  const nextAction = cleanString(input.nextAction) || (hotStatus ? "Lead prüfen und Termin vorbereiten" : "Antwort prüfen und Lead qualifizieren");
  const metadata = {
    bot: {
      channel: source,
      contactRef: input.contactRef ?? null,
      externalMessageId: input.externalMessageId ?? null,
      lastMessageAt: now,
      webhookEventId: input.webhookEventId ?? null,
    },
    preferredChannel: input.customerData?.preferredChannel ?? source,
  };

  const existingContact = await queryOne<IdRow>(
    `
      select id
      from contacts
      where workspace_id = $1
        and (
          ($2::text <> '' and lower(email) = lower($2))
          or ($3::text <> '' and regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = $3)
          or ($4::text <> '' and metadata->'bot'->>'contactRef' = $4)
        )
      order by updated_at desc
      limit 1
    `,
    [input.session.workspaceId, email, phoneMatch, input.contactRef ?? ""],
  );

  const contact = existingContact
    ? await queryOne<IdRow>(
        `
          update contacts
          set project_id = coalesce($3::uuid, project_id),
              name = coalesce(nullif($4, ''), name),
              role = $5,
              source = $6,
              intent = $7,
              consent_label = $8,
              email = coalesce(nullif($9, ''), email),
              phone = coalesce(nullif($10, ''), phone),
              metadata = metadata || $11::jsonb,
              updated_at = now()
          where workspace_id = $1 and id = $2
          returning id
        `,
        [
          input.session.workspaceId,
          existingContact.id,
          isUuid(input.projectId) ? input.projectId : null,
          name,
          leadType,
          source,
          intent,
          consentLabel,
          email,
          phone,
          JSON.stringify(metadata),
        ],
      )
    : await queryOne<IdRow>(
        `
          insert into contacts (
            workspace_id, project_id, name, role, source, intent, consent_label, email, phone, metadata
          )
          values ($1, $2::uuid, $3, $4, $5, $6, $7, nullif($8, ''), nullif($9, ''), $10::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          isUuid(input.projectId) ? input.projectId : null,
          name,
          leadType,
          source,
          intent,
          consentLabel,
          email,
          phone,
          JSON.stringify(metadata),
        ],
      );
  const contactId = contact?.id ?? existingContact?.id ?? null;

  if (!contactId) return null;

  const existingLead = await queryOne<IdRow>(
    `
      select id
      from leads
      where workspace_id = $1
        and contact_id = $2
        and source = $3
      order by updated_at desc
      limit 1
    `,
    [input.session.workspaceId, contactId, source],
  );
  const leadMetadata = {
    bot: metadata.bot,
    lastCustomerMessage: input.prompt,
  };
  const lead = existingLead
    ? await queryOne<IdRow>(
        `
          update leads
          set project_id = coalesce($3::uuid, project_id),
              type = $4,
              status = case when status in ('Neu', 'Qualifizieren', 'Termin offen') then $5 else status end,
              score = greatest(score, $6),
              intent = $7,
              next_action = $8,
              last_contact_at = now(),
              next_contact_at = coalesce(next_contact_at, now() + interval '4 hours'),
              hot_status = hot_status or $9,
              metadata = metadata || $10::jsonb,
              updated_at = now()
          where workspace_id = $1 and id = $2
          returning id
        `,
        [
          input.session.workspaceId,
          existingLead.id,
          isUuid(input.projectId) ? input.projectId : null,
          leadType,
          statusFromScore(score),
          score,
          intent,
          nextAction,
          hotStatus,
          JSON.stringify(leadMetadata),
        ],
      )
    : await queryOne<IdRow>(
        `
          insert into leads (
            workspace_id, project_id, contact_id, source, type, status, score, intent, next_action,
            received_at, sla_due_at, last_contact_at, next_contact_at, hot_status, metadata
          )
          values (
            $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
            $10::timestamptz, $11::timestamptz, $10::timestamptz, $11::timestamptz, $12, $13::jsonb
          )
          returning id
        `,
        [
          input.session.workspaceId,
          isUuid(input.projectId) ? input.projectId : null,
          contactId,
          source,
          leadType,
          statusFromScore(score),
          score,
          intent,
          nextAction,
          now,
          slaDueAt,
          hotStatus,
          JSON.stringify(leadMetadata),
        ],
      );
  const timeline = await queryOne<IdRow>(
    `
      insert into contact_timeline_items (
        workspace_id, contact_id, project_id, channel, title, detail, outcome, metadata
      )
      values ($1, $2, $3::uuid, $4, $5, $6, 'info', $7::jsonb)
      returning id
    `,
    [
      input.session.workspaceId,
      contactId,
      isUuid(input.projectId) ? input.projectId : null,
      source,
      source + " Bot-Nachricht",
      input.prompt.slice(0, 600),
      JSON.stringify({ bot: metadata.bot, leadId: lead?.id ?? existingLead?.id ?? null }),
    ],
  );
  const leadId = lead?.id ?? existingLead?.id ?? null;

  if (!existingLead && leadId) {
    await Promise.all([
      writeCrmAnalyticsEvent({
        channel: source,
        contactId,
        entityId: leadId,
        entityType: "lead",
        eventType: "lead_created",
        leadId,
        metadata: {
          contactCreated: !existingContact,
          externalMessageId: input.externalMessageId ?? null,
          score,
          status: statusFromScore(score),
          trigger: "bot_message",
          webhookEventId: input.webhookEventId ?? null,
        },
        module: "lead_inbox",
        projectId: isUuid(input.projectId) ? input.projectId : null,
        source,
        userId: input.session.userId,
        workspaceId: input.session.workspaceId,
      }),
      recordSpeedToLeadEvent({
        channel: source,
        contactId,
        dueAt: slaDueAt,
        leadId,
        metadata: {
          externalMessageId: input.externalMessageId ?? null,
          score,
          sourcePayload: "bot_message",
          trigger: "bot_message",
          webhookEventId: input.webhookEventId ?? null,
        },
        projectId: isUuid(input.projectId) ? input.projectId : null,
        source,
        state: "covered",
        userId: input.session.userId,
        workspaceId: input.session.workspaceId,
      }),
    ]);
  }

  return {
    contactCreated: !existingContact,
    contactId,
    leadCreated: !existingLead,
    leadId,
    timelineItemId: timeline?.id ?? null,
  };
}

export async function linkBotConversationToCrmEntities(input: {
  session: AppSession;
  conversationId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  sync?: unknown;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.conversationId)) return null;

  const row = await queryOne<IdRow>(
    `
      update bot_conversations
      set contact_id = coalesce($3::uuid, contact_id),
          lead_id = coalesce($4::uuid, lead_id),
          metadata = metadata || $5::jsonb,
          updated_at = now()
      where id = $1 and workspace_id = $2
      returning id
    `,
    [
      input.conversationId,
      input.session.workspaceId,
      isUuid(input.contactId) ? input.contactId : null,
      isUuid(input.leadId) ? input.leadId : null,
      JSON.stringify({ crmSync: input.sync ?? null }),
    ],
  );

  return row?.id ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function decryptBotChannelCredentials(metadata: unknown): BotChannelAccountCredentials {
  const record = asRecord(metadata);
  const credentials = asRecord(record.credentials);

  return {
    accessToken: decryptSecret(credentials.accessToken),
    graphVersion: cleanString(credentials.graphVersion as string | null),
    instagramAccountId: cleanString(credentials.instagramAccountId as string | null),
    pageId: cleanString(credentials.pageId as string | null),
    phoneNumberId: cleanString(credentials.phoneNumberId as string | null),
    whatsappBusinessAccountId: cleanString(credentials.whatsappBusinessAccountId as string | null),
  };
}

function buildBotChannelMetadata(input: {
  credentials?: BotChannelAccountCredentials;
  metadata?: unknown;
}) {
  const metadata = asRecord(input.metadata);
  const credentials = input.credentials ?? {};

  return {
    ...metadata,
    credentials: {
      accessToken: credentials.accessToken ? encryptSecret(credentials.accessToken) : null,
      graphVersion: cleanString(credentials.graphVersion),
      instagramAccountId: cleanString(credentials.instagramAccountId),
      pageId: cleanString(credentials.pageId),
      phoneNumberId: cleanString(credentials.phoneNumberId),
      whatsappBusinessAccountId: cleanString(credentials.whatsappBusinessAccountId),
    },
  };
}

export async function upsertBotChannelAccount(input: {
  active?: boolean;
  accountLabel?: string | null;
  botId?: string | null;
  channel: string;
  complianceNote?: string | null;
  credentials?: BotChannelAccountCredentials;
  externalAccountId?: string | null;
  inboundMode?: string | null;
  metadata?: unknown;
  outboundMode?: string | null;
  provider: string;
  session: AppSession;
  setupStatus?: "not_connected" | "ready" | "connected" | "needs_review" | "error";
  webhookPath?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  const externalAccountId = cleanString(input.externalAccountId) || null;
  const existing = externalAccountId
    ? await queryOne<{ id: string }>(
        `
          select id
          from bot_channel_accounts
          where workspace_id = $1
            and channel = $2
            and external_account_id = $3
          limit 1
        `,
        [input.session.workspaceId, input.channel, externalAccountId],
      )
    : null;
  const metadata = buildBotChannelMetadata({
    credentials: input.credentials,
    metadata: input.metadata,
  });

  if (existing?.id) {
    const row = await queryOne<{ id: string }>(
      `
        update bot_channel_accounts
        set bot_id = coalesce($3::uuid, bot_id),
            provider = $4,
            account_label = $5,
            setup_status = $6,
            active = $7,
            inbound_mode = $8,
            outbound_mode = $9,
            webhook_path = $10,
            compliance_note = $11,
            credentials_ref = $12,
            metadata = $13::jsonb,
            updated_at = now()
        where id = $1 and workspace_id = $2
        returning id
      `,
      [
        existing.id,
        input.session.workspaceId,
        isUuid(input.botId) ? input.botId : null,
        input.provider,
        input.accountLabel ?? null,
        input.setupStatus ?? "connected",
        input.active ?? true,
        input.inboundMode ?? null,
        input.outboundMode ?? null,
        input.webhookPath ?? null,
        input.complianceNote ?? null,
        input.credentials?.accessToken ? "metadata.credentials.accessToken" : null,
        JSON.stringify(metadata),
      ],
    );

    return row?.id ?? null;
  }

  const row = await queryOne<{ id: string }>(
    `
      insert into bot_channel_accounts (
        workspace_id, bot_id, channel, provider, account_label, external_account_id,
        setup_status, active, inbound_mode, outbound_mode, webhook_path,
        compliance_note, credentials_ref, metadata
      )
      values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14::jsonb
      )
      returning id
    `,
    [
      input.session.workspaceId,
      isUuid(input.botId) ? input.botId : null,
      input.channel,
      input.provider,
      input.accountLabel ?? null,
      externalAccountId,
      input.setupStatus ?? "connected",
      input.active ?? true,
      input.inboundMode ?? null,
      input.outboundMode ?? null,
      input.webhookPath ?? null,
      input.complianceNote ?? null,
      input.credentials?.accessToken ? "metadata.credentials.accessToken" : null,
      JSON.stringify(metadata),
    ],
  );

  return row?.id ?? null;
}

export async function listBotChannelAccounts(input: { session: AppSession }) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return [];

  return queryRows<{
    id: string;
    active: boolean;
    accountLabel: string | null;
    channel: string;
    externalAccountId: string | null;
    provider: string;
    setupStatus: string;
    updatedAt: string | Date;
  }>(
    `
      select
        id,
        active,
        account_label as "accountLabel",
        channel,
        external_account_id as "externalAccountId",
        provider,
        setup_status as "setupStatus",
        updated_at as "updatedAt"
      from bot_channel_accounts
      where workspace_id = $1
      order by updated_at desc
    `,
    [input.session.workspaceId],
  );
}

export async function findBotChannelAccountForWebhook(input: {
  accountRef?: string | null;
  channel: string;
}) {
  const accountRef = cleanString(input.accountRef);
  if (!canPersist() || !accountRef) return null;

  const row = await queryOne<{
    id: string;
    workspaceId: string;
    workspaceName: string | null;
    channel: string;
    provider: string;
    metadata: unknown;
  }>(
    `
      select
        bca.id,
        bca.workspace_id as "workspaceId",
        w.name as "workspaceName",
        bca.channel,
        bca.provider,
        bca.metadata
      from bot_channel_accounts bca
      left join workspaces w on w.id = bca.workspace_id
      where bca.active = true
        and bca.channel = $1
        and bca.external_account_id = $2
      order by bca.updated_at desc
      limit 1
    `,
    [input.channel, accountRef],
  );

  if (!row) return null;

  return {
    ...row,
    credentials: decryptBotChannelCredentials(row.metadata),
  };
}

export async function insertBotChannelWebhook(input: {
  workspaceId?: string | null;
  channelAccountId?: string | null;
  channel: string;
  externalMessageId?: string | null;
  contactRef?: string | null;
  eventType: string;
  payload: unknown;
  normalizedMessage: unknown;
  status?: string;
}) {
  if (!canPersist() || !isUuid(input.workspaceId)) return null;

  if (input.externalMessageId) {
    const existing = await queryOne<{ id: string; status: string }>(
      `
        select id, status
        from bot_channel_webhooks
        where workspace_id = $1
          and channel = $2
          and external_message_id = $3
        order by received_at asc
        limit 1
      `,
      [input.workspaceId, input.channel, input.externalMessageId],
    );

    if (existing) {
      return { duplicate: true, id: existing.id, status: existing.status };
    }
  }

  const params: unknown[] = [input.workspaceId];
  const accountSql = addUuidParam(params, input.channelAccountId);
  const channelSql = addParam(params, input.channel);
  const externalSql = addParam(params, input.externalMessageId ?? null);
  const contactSql = addParam(params, input.contactRef ?? null);
  const eventSql = addParam(params, input.eventType);
  const payloadSql = addParam(params, JSON.stringify(input.payload ?? {}));
  const normalizedSql = addParam(params, JSON.stringify(input.normalizedMessage ?? {}));
  const statusSql = addParam(params, input.status ?? "received");

  const row = await queryOne<IdRow & { status: string }>(
    `
      insert into bot_channel_webhooks (
        workspace_id, channel_account_id, channel, external_message_id, contact_ref,
        event_type, payload, normalized_message, status
      )
      values (
        $1, ${accountSql}, ${channelSql}, ${externalSql}, ${contactSql},
        ${eventSql}, ${payloadSql}::jsonb, ${normalizedSql}::jsonb, ${statusSql}
      )
      returning id, status
    `,
    params,
  );

  return row ? { duplicate: false, id: row.id, status: row.status } : null;
}

export async function listBotChannelWebhookEvents(input: {
  session: AppSession;
  limit?: number;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return [];

  return queryRows<{
    id: string;
    channel: string;
    externalMessageId: string | null;
    contactRef: string | null;
    eventType: string;
    normalizedMessage: unknown;
    status: string;
    receivedAt: string | Date;
  }>(
    `
      select
        id,
        channel,
        external_message_id as "externalMessageId",
        contact_ref as "contactRef",
        event_type as "eventType",
        normalized_message as "normalizedMessage",
        status,
        received_at as "receivedAt"
      from bot_channel_webhooks
      where workspace_id = $1
      order by received_at desc
      limit $2
    `,
    [input.session.workspaceId, input.limit ?? 25],
  );
}

export async function listBotMessages(input: {
  session: AppSession;
  conversationId: string;
  limit?: number;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.conversationId)) return [];

  return queryRows<{
    id: string;
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolName: string | null;
    toolCallId: string | null;
    model: string | null;
    metadata: unknown;
    createdAt: string;
  }>(
    `
      select
        m.id,
        m.role,
        m.content,
        m.tool_name as "toolName",
        m.tool_call_id as "toolCallId",
        m.model,
        m.metadata,
        m.created_at as "createdAt"
      from bot_messages m
      join bot_conversations c on c.id = m.conversation_id
      where m.workspace_id = $1
        and m.conversation_id = $2
        and c.workspace_id = $1
      order by m.created_at desc
      limit $3
    `,
    [input.session.workspaceId, input.conversationId, input.limit ?? 50],
  ).then((rows) => rows.reverse());
}

export async function insertBotMessage(input: {
  session: AppSession;
  conversationId?: string | null;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolName?: string | null;
  toolCallId?: string | null;
  model?: string | null;
  metadata?: unknown;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.conversationId)) return null;

  const row = await queryOne<IdRow>(
    `
      insert into bot_messages (
        workspace_id, conversation_id, role, content, tool_name, tool_call_id, model, metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      returning id
    `,
    [
      input.session.workspaceId,
      input.conversationId,
      input.role,
      input.content,
      input.toolName ?? null,
      input.toolCallId ?? null,
      input.model ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  await queryOne(
    `
      update bot_conversations
      set updated_at = now()
      where id = $1 and workspace_id = $2
      returning id
    `,
    [input.conversationId, input.session.workspaceId],
  );

  if (row?.id && input.role === "assistant") {
    await recordFirstResponseAnalyticsEvent({
      conversationId: input.conversationId,
      messageId: row.id,
      metadata: input.metadata,
      model: input.model,
      session: input.session,
    });
  }

  return row?.id ?? null;
}

async function recordFirstResponseAnalyticsEvent(input: {
  conversationId: string;
  messageId: string;
  metadata?: unknown;
  model?: string | null;
  session: AppSession;
}) {
  const conversation = await queryOne<{
    botId: string | null;
    contactId: string | null;
    leadId: string | null;
    metadata: unknown;
    projectId: string | null;
  }>(
    `
      select
        bot_id as "botId",
        contact_id as "contactId",
        lead_id as "leadId",
        metadata,
        project_id as "projectId"
      from bot_conversations
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [input.conversationId, input.session.workspaceId],
  );

  if (!conversation) return null;

  const existing = await queryOne<IdRow>(
    `
      select id
      from analytics_events
      where workspace_id = $1
        and event_type = 'first_response'
        and (
          ($2::uuid is not null and lead_id = $2::uuid)
          or ($3::uuid is not null and contact_id = $3::uuid)
          or metadata->>'conversationId' = $4
        )
      limit 1
    `,
    [input.session.workspaceId, conversation.leadId, conversation.contactId, input.conversationId],
  );

  if (existing) return existing.id;

  const conversationMetadata = asPlainObject(conversation.metadata);
  const messageMetadata = asPlainObject(input.metadata);
  const channel = cleanString(messageMetadata.channel as string)
    || cleanString(conversationMetadata.channel as string)
    || cleanString(conversationMetadata.source as string)
    || "bot";
  const entityId = conversation.leadId ?? conversation.contactId ?? input.messageId;
  const entityType = conversation.leadId ? "lead" : conversation.contactId ? "contact" : "bot_message";
  const firstResponseAt = new Date().toISOString();

  const analyticsEventId = await writeCrmAnalyticsEvent({
    channel,
    contactId: conversation.contactId,
    entityId,
    entityType,
    eventType: "first_response",
    leadId: conversation.leadId,
    metadata: {
      botId: conversation.botId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      model: input.model ?? null,
    },
    module: "lead_inbox",
    projectId: conversation.projectId,
    source: channel,
    userId: input.session.userId,
    workspaceId: input.session.workspaceId,
  });

  await recordSpeedToLeadEvent({
    channel,
    contactId: conversation.contactId,
    firstResponseAt,
    leadId: conversation.leadId,
    metadata: {
      analyticsEventId,
      botId: conversation.botId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      model: input.model ?? null,
      sourcePayload: "bot_first_response",
    },
    projectId: conversation.projectId,
    source: channel,
    state: "covered",
    userId: input.session.userId,
    workspaceId: input.session.workspaceId,
  });

  return analyticsEventId;
}

export async function insertBotToolCall(input: {
  session: AppSession;
  conversationId?: string | null;
  botId?: string | null;
  toolName: string;
  riskLevel?: string;
  input: unknown;
  output?: unknown;
  status?: "pending_approval" | "approved" | "denied" | "completed" | "failed";
  requiresApproval?: boolean;
  error?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  const params: unknown[] = [input.session.workspaceId];
  const conversationSql = addUuidParam(params, input.conversationId);
  const botSql = addUuidParam(params, input.botId);
  const toolSql = addParam(params, input.toolName);
  const riskSql = addParam(params, input.riskLevel ?? "low");
  const inputSql = addParam(params, JSON.stringify(input.input ?? {}));
  const outputSql = addParam(params, JSON.stringify(input.output ?? null));
  const statusSql = addParam(params, input.status ?? "completed");
  const approvalSql = addParam(params, Boolean(input.requiresApproval));
  const errorSql = addParam(params, input.error ?? null);

  const row = await queryOne<IdRow>(
    `
      insert into bot_tool_calls (
        workspace_id, conversation_id, bot_id, tool_name, risk_level, input, output, status, requires_approval, error
      )
      values (
        $1, ${conversationSql}, ${botSql}, ${toolSql}, ${riskSql}, ${inputSql}::jsonb,
        ${outputSql}::jsonb, ${statusSql}, ${approvalSql}, ${errorSql}
      )
      returning id
    `,
    params,
  );

  return row?.id ?? null;
}

export async function insertBotDocumentSend(input: {
  session: AppSession;
  botId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  mediaAssetId?: string | null;
  channel: string;
  documentName: string;
  status: string;
  approvalRequestId?: string | null;
  metadata?: unknown;
  sentAt?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  const params: unknown[] = [input.session.workspaceId];
  const botSql = addUuidParam(params, input.botId);
  const conversationSql = addUuidParam(params, input.conversationId);
  const contactSql = addUuidParam(params, input.contactId);
  const mediaSql = addUuidParam(params, input.mediaAssetId);
  const channelSql = addParam(params, input.channel);
  const nameSql = addParam(params, input.documentName);
  const statusSql = addParam(params, input.status);
  const approvalSql = addUuidParam(params, input.approvalRequestId);
  const metadataSql = addParam(params, JSON.stringify(input.metadata ?? {}));
  const sentAtSql = addParam(params, input.sentAt ?? null);

  const row = await queryOne<IdRow>(
    `
      insert into bot_document_sends (
        workspace_id,
        bot_id,
        conversation_id,
        contact_id,
        media_asset_id,
        channel,
        document_name,
        status,
        approval_request_id,
        metadata,
        sent_at
      )
      values (
        $1,
        ${botSql},
        ${conversationSql},
        ${contactSql},
        ${mediaSql},
        ${channelSql},
        ${nameSql},
        ${statusSql},
        ${approvalSql},
        ${metadataSql}::jsonb,
        ${sentAtSql}::timestamptz
      )
      returning id
    `,
    params,
  );

  return row?.id ?? null;
}

export async function updateBotDocumentSendDelivery(input: {
  session: AppSession;
  documentSendId?: string | null;
  status: string;
  metadata?: unknown;
  sentAt?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.documentSendId)) return null;

  const row = await queryOne<IdRow>(
    `
      update bot_document_sends
      set status = $3,
          sent_at = coalesce($4::timestamptz, sent_at),
          metadata = metadata || $5::jsonb
      where id = $1
        and workspace_id = $2
      returning id
    `,
    [
      input.documentSendId,
      input.session.workspaceId,
      input.status,
      input.sentAt ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  return row?.id ?? null;
}

export async function insertLeadWorkflowRun(input: {
  session: AppSession;
  projectId?: string | null;
  workflowId?: string | null;
  leadId?: string | null;
  status: "running" | "approval_required" | "completed" | "failed";
  workflowName?: string;
  workflowSteps?: unknown;
  workflowTrigger?: string;
  input: unknown;
  result: unknown;
  auditEvents: string[];
  humanApprovalRequired?: boolean;
  error?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  let workflowId = isUuid(input.workflowId) ? input.workflowId : null;

  if (!workflowId) {
    const workflowName = input.workflowName ?? "Lead automation";
    const workflowTrigger = input.workflowTrigger ?? "manual";
    const existingWorkflow = await queryOne<IdRow>(
      `
        select id
        from lead_workflows
        where workspace_id = $1
          and name = $2
          and trigger = $3
          and active = true
          and project_id is not distinct from $4::uuid
        order by created_at asc
        limit 1
      `,
      [input.session.workspaceId, workflowName, workflowTrigger, isUuid(input.projectId) ? input.projectId : null],
    );

    workflowId = existingWorkflow?.id ?? null;
  }

  if (!workflowId) {
    const workflowParams: unknown[] = [input.session.workspaceId];
    const projectSql = addUuidParam(workflowParams, input.projectId);
    const nameSql = addParam(workflowParams, input.workflowName ?? "Lead automation");
    const triggerSql = addParam(workflowParams, input.workflowTrigger ?? "manual");
    const stepsSql = addParam(workflowParams, JSON.stringify(input.workflowSteps ?? []));
    const approvalSql = addParam(workflowParams, Boolean(input.humanApprovalRequired));

    const workflow = await queryOne<IdRow>(
      `
        insert into lead_workflows (workspace_id, project_id, name, trigger, steps, human_approval_required)
        values ($1, ${projectSql}, ${nameSql}, ${triggerSql}, ${stepsSql}::jsonb, ${approvalSql})
        returning id
      `,
      workflowParams,
    );

    workflowId = workflow?.id ?? null;
  }

  const params: unknown[] = [input.session.workspaceId];
  const projectSql = addUuidParam(params, input.projectId);
  const workflowSql = addUuidParam(params, workflowId);
  const leadSql = addUuidParam(params, input.leadId);
  const statusSql = addParam(params, input.status);
  const inputSql = addParam(params, JSON.stringify(input.input ?? {}));
  const resultSql = addParam(params, JSON.stringify(input.result ?? {}));
  const auditSql = addParam(params, JSON.stringify(input.auditEvents ?? []));
  const errorSql = addParam(params, input.error ?? null);

  const row = await queryOne<IdRow>(
    `
      insert into lead_workflow_runs (
        workspace_id, project_id, workflow_id, lead_id, status, input, result, audit_events, error
      )
      values ($1, ${projectSql}, ${workflowSql}, ${leadSql}, ${statusSql}, ${inputSql}::jsonb, ${resultSql}::jsonb, ${auditSql}::jsonb, ${errorSql})
      returning id
    `,
    params,
  );

  return row?.id ?? null;
}

export async function listLeadWorkflowRuns(input: {
  session: AppSession;
  limit?: number;
  status?: "running" | "approval_required" | "completed" | "failed" | "all";
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return [];

  const status = input.status && input.status !== "all" ? input.status : null;

  return queryRows<{
    id: string;
    projectId: string | null;
    workflowId: string | null;
    workflowName: string | null;
    workflowTrigger: string | null;
    leadId: string | null;
    status: string;
    input: unknown;
    result: unknown;
    auditEvents: unknown;
    error: string | null;
    approvalId: string | null;
    approvalStatus: string | null;
    createdAt: string | Date;
    updatedAt: string | Date;
  }>(
    `
      select
        lwr.id,
        lwr.project_id as "projectId",
        lwr.workflow_id as "workflowId",
        lw.name as "workflowName",
        lw.trigger as "workflowTrigger",
        lwr.lead_id as "leadId",
        lwr.status,
        lwr.input,
        lwr.result,
        lwr.audit_events as "auditEvents",
        lwr.error,
        ar.id as "approvalId",
        ar.status as "approvalStatus",
        lwr.created_at as "createdAt",
        lwr.updated_at as "updatedAt"
      from lead_workflow_runs lwr
      left join lead_workflows lw on lw.id = lwr.workflow_id
      left join lateral (
        select id, status
        from approval_requests
        where workspace_id = lwr.workspace_id
          and entity_type = 'lead_workflow_run'
          and entity_id = lwr.id
        order by created_at desc
        limit 1
      ) ar on true
      where lwr.workspace_id = $1
        and ($2::text is null or lwr.status = $2)
      order by lwr.created_at desc
      limit $3
    `,
    [input.session.workspaceId, status, input.limit ?? 25],
  );
}

export async function decideLeadWorkflowRun(input: {
  session: AppSession;
  workflowRunId: string | null;
  approvalId: string;
  decision: "approved" | "denied";
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.workflowRunId)) {
    return null;
  }

  const status = input.decision === "approved" ? "completed" : "failed";
  const error = input.decision === "approved" ? null : "Approval denied";
  const approvalPatch = {
    approval: {
      id: input.approvalId,
      decision: input.decision,
      decidedAt: new Date().toISOString(),
    },
  };

  return queryOne<{
    id: string;
    status: string;
    result: unknown;
    error: string | null;
    updatedAt: string | Date;
  }>(
    `
      update lead_workflow_runs
      set status = $3,
          error = $4,
          result = result || $5::jsonb,
          audit_events = audit_events || $6::jsonb,
          updated_at = now()
      where id = $1 and workspace_id = $2
      returning
        id,
        status,
        result,
        error,
        updated_at as "updatedAt"
    `,
    [
      input.workflowRunId,
      input.session.workspaceId,
      status,
      error,
      JSON.stringify(approvalPatch),
      JSON.stringify([`approval.${input.decision}`]),
    ],
  );
}

export async function upsertProviderConnection(input: {
  session: AppSession;
  provider: string;
  status: "connected" | "not_configured" | "pending" | "failed";
  accountLabel?: string | null;
  scopes?: string[];
  config?: unknown;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  const row = await queryOne<{
    id: string;
    provider: string;
    status: string;
    accountLabel: string | null;
    lastSyncAt: string | Date | null;
    updatedAt: string | Date;
  }>(
    `
      insert into provider_connections (
        workspace_id, provider, status, account_label, scopes, config, last_sync_at
      )
      values ($1, $2, $3, $4, $5::text[], $6::jsonb, now())
      on conflict (workspace_id, provider)
      do update set
        status = excluded.status,
        account_label = excluded.account_label,
        scopes = excluded.scopes,
        config = excluded.config,
        last_sync_at = excluded.last_sync_at,
        updated_at = now()
      returning
        id,
        provider,
        status,
        account_label as "accountLabel",
        last_sync_at as "lastSyncAt",
        updated_at as "updatedAt"
    `,
    [
      input.session.workspaceId,
      input.provider,
      input.status,
      input.accountLabel ?? null,
      input.scopes ?? [],
      JSON.stringify(input.config ?? {}),
    ],
  );

  return row;
}

export async function insertNewsletterSend(input: {
  session: AppSession;
  campaignId?: string | null;
  contactId?: string | null;
  provider: string;
  providerMessageId?: string | null;
  toEmail: string;
  subject: string;
  status: "queued" | "sent" | "delivered" | "bounced" | "complained" | "suppressed" | "failed";
  error?: string | null;
  metadata?: unknown;
  sentAt?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  const params: unknown[] = [input.session.workspaceId];
  const campaignSql = addUuidParam(params, input.campaignId);
  const contactSql = addUuidParam(params, input.contactId);
  const providerSql = addParam(params, input.provider);
  const providerIdSql = addParam(params, input.providerMessageId ?? null);
  const toSql = addParam(params, input.toEmail);
  const subjectSql = addParam(params, input.subject);
  const statusSql = addParam(params, input.status);
  const errorSql = addParam(params, input.error ?? null);
  const metadataSql = addParam(params, JSON.stringify(input.metadata ?? {}));
  const sentAtSql = addParam(params, input.sentAt ?? null);

  const row = await queryOne<IdRow>(
    `
      insert into newsletter_sends (
        workspace_id, campaign_id, contact_id, provider, provider_message_id, to_email, subject, status, error, metadata, sent_at
      )
      values (
        $1, ${campaignSql}, ${contactSql}, ${providerSql}, ${providerIdSql}, ${toSql}, ${subjectSql},
        ${statusSql}, ${errorSql}, ${metadataSql}::jsonb, ${sentAtSql}::timestamptz
      )
      returning id
    `,
    params,
  );

  const sendId = row?.id ?? null;

  if (sendId) {
    await recordNewsletterSendAnalyticsEvent({
      campaignId: input.campaignId,
      contactId: input.contactId,
      error: input.error,
      metadata: input.metadata,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      sendId,
      sentAt: input.sentAt,
      session: input.session,
      status: input.status,
      subject: input.subject,
      toEmail: input.toEmail,
    });
  }

  return sendId;
}

async function recordNewsletterSendAnalyticsEvent(input: {
  campaignId?: string | null;
  contactId?: string | null;
  error?: string | null;
  metadata?: unknown;
  provider: string;
  providerMessageId?: string | null;
  sendId: string;
  sentAt?: string | null;
  session: AppSession;
  status: string;
  subject: string;
  toEmail: string;
}) {
  const row = await queryOne<{ projectId: string | null }>(
    `
      select coalesce(nc.project_id, c.project_id) as "projectId"
      from newsletter_sends ns
      left join newsletter_campaigns nc on nc.id = ns.campaign_id and nc.workspace_id = ns.workspace_id
      left join contacts c on c.id = ns.contact_id and c.workspace_id = ns.workspace_id
      where ns.id = $1 and ns.workspace_id = $2
      limit 1
    `,
    [input.sendId, input.session.workspaceId],
  );
  const metadata = asPlainObject(input.metadata);
  const source = cleanString(metadata.source as string) || "crm_newsletter";

  return writeCrmAnalyticsEvent({
    channel: "email",
    contactId: input.contactId,
    entityId: input.sendId,
    entityType: "newsletter_send",
    eventType: "newsletter_event",
    metadata: {
      campaignId: isUuid(input.campaignId) ? input.campaignId : null,
      error: input.error ?? null,
      provider: input.provider,
      providerMessageId: input.providerMessageId ?? null,
      recipientDomain: input.toEmail.split("@")[1]?.toLowerCase() ?? "",
      sendStatus: input.status,
      source,
      subject: input.subject,
      ...metadata,
    },
    module: "newsletter",
    occurredAt: input.sentAt ?? new Date().toISOString(),
    projectId: row?.projectId ?? null,
    source,
    userId: input.session.userId,
    workspaceId: input.session.workspaceId,
  });
}

export async function listNewsletterSends(input: {
  session: AppSession;
  limit?: number;
  status?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return [];

  const status = input.status && input.status !== "all" ? input.status : null;

  return queryRows<{
    id: string;
    campaignId: string | null;
    campaignName: string | null;
    contactId: string | null;
    contactName: string | null;
    provider: string;
    providerMessageId: string | null;
    toEmail: string;
    subject: string;
    status: string;
    error: string | null;
    metadata: unknown;
    sentAt: string | Date | null;
    createdAt: string | Date;
    updatedAt: string | Date;
  }>(
    `
      select
        ns.id,
        ns.campaign_id as "campaignId",
        nc.name as "campaignName",
        ns.contact_id as "contactId",
        c.name as "contactName",
        ns.provider,
        ns.provider_message_id as "providerMessageId",
        ns.to_email as "toEmail",
        ns.subject,
        ns.status,
        ns.error,
        ns.metadata,
        ns.sent_at as "sentAt",
        ns.created_at as "createdAt",
        ns.updated_at as "updatedAt"
      from newsletter_sends ns
      left join newsletter_campaigns nc on nc.id = ns.campaign_id
      left join contacts c on c.id = ns.contact_id
      where ns.workspace_id = $1
        and ($2::text is null or ns.status = $2)
      order by ns.created_at desc
      limit $3
    `,
    [input.session.workspaceId, status, input.limit ?? 25],
  );
}

export async function recordNewsletterUnsubscribe(input: {
  campaignId?: string | null;
  email?: string | null;
  metadata?: unknown;
  source?: string | null;
  workspaceId?: string | null;
}) {
  const email = normalizeEmailForStorage(input.email);

  if (!canPersist() || !isUuid(input.workspaceId) || !email) {
    return {
      contactIds: [] as string[],
      persisted: false,
      reason: !email ? "invalid_email" : "database_unavailable",
      suppressionId: null as string | null,
    };
  }

  const campaignId = isUuid(input.campaignId) ? input.campaignId : null;
  const source = cleanString(input.source) || "Newsletter-Abmeldelink";
  const metadata = JSON.stringify(input.metadata ?? {});
  let suppressionId: string | null = null;

  try {
    const existing = await queryOne<IdRow>(
      `
        select id
        from newsletter_suppressions
        where workspace_id = $1 and lower(email) = lower($2)
        limit 1
      `,
      [input.workspaceId, email],
    );

    const row = existing
      ? await queryOne<IdRow>(
          `
            update newsletter_suppressions
            set
              campaign_id = coalesce($3::uuid, campaign_id),
              reason = 'unsubscribe',
              source = $4,
              metadata = metadata || $5::jsonb,
              captured_at = now()
            where id = $1 and workspace_id = $2
            returning id
          `,
          [existing.id, input.workspaceId, campaignId, source, metadata],
        )
      : await queryOne<IdRow>(
          `
            insert into newsletter_suppressions (
              workspace_id, campaign_id, email, reason, source, metadata
            )
            values ($1, $2::uuid, $3, 'unsubscribe', $4, $5::jsonb)
            returning id
          `,
          [input.workspaceId, campaignId, email, source, metadata],
        );

    suppressionId = row?.id ?? null;
  } catch {
    suppressionId = null;
  }

  const contacts = await queryRows<{ id: string; projectId: string | null }>(
    `
      select id, project_id as "projectId"
      from contacts
      where workspace_id = $1 and lower(email) = lower($2)
      limit 50
    `,
    [input.workspaceId, email],
  );

  if (contacts.length) {
    await queryOne(
      `
        update contacts
        set consent_label = 'Abgemeldet', updated_at = now()
        where workspace_id = $1 and lower(email) = lower($2)
        returning id
      `,
      [input.workspaceId, email],
    );

    await Promise.all(
      contacts.map((contact) =>
        queryOne(
          `
            insert into consent_records (
              workspace_id, contact_id, project_id, channel, status, source, metadata
            )
            values ($1, $2, $3, 'Newsletter', 'Abgemeldet', $4, $5::jsonb)
            returning id
          `,
          [
            input.workspaceId,
            contact.id,
            contact.projectId,
            source,
            JSON.stringify({
              campaignId,
              email,
              trigger: "one_click_unsubscribe",
            }),
          ],
        ),
      ),
    );
  }

  return {
    contactIds: contacts.map((contact) => contact.id),
    persisted: Boolean(suppressionId || contacts.length),
    reason: null,
    suppressionId,
  };
}

export async function listNewsletterSuppressedEmails(input: {
  emails: string[];
  workspaceId?: string | null;
}) {
  const emails = Array.from(new Set(input.emails.map((email) => normalizeEmailForStorage(email)).filter(Boolean)));
  const suppressedEmails = new Set<string>();

  if (!canPersist() || !isUuid(input.workspaceId) || !emails.length) {
    return suppressedEmails;
  }

  try {
    const rows = await queryRows<{ email: string }>(
      `
        select lower(email) as email
        from newsletter_suppressions
        where workspace_id = $1 and lower(email) = any($2::text[])
      `,
      [input.workspaceId, emails],
    );

    rows.forEach((row) => suppressedEmails.add(row.email));
  } catch {
    // Older databases may not have newsletter_suppressions yet. Consent records still protect known contacts.
  }

  const consentRows = await queryRows<{ email: string; status: string }>(
    `
      select distinct on (lower(c.email))
        lower(c.email) as email,
        cr.status
      from contacts c
      join consent_records cr on cr.contact_id = c.id and cr.workspace_id = c.workspace_id
      where c.workspace_id = $1
        and lower(c.email) = any($2::text[])
        and cr.channel = 'Newsletter'
      order by lower(c.email), cr.captured_at desc
    `,
    [input.workspaceId, emails],
  );

  consentRows
    .filter((row) => /(abgemeldet|opt.?out|unsubscribe|unsubscribed)/i.test(row.status))
    .forEach((row) => suppressedEmails.add(row.email));

  return suppressedEmails;
}

export async function insertCalendarSyncEvent(input: {
  session: AppSession;
  calendarEventId?: string | null;
  provider: string;
  providerEventId?: string | null;
  operation: string;
  status: "pending" | "synced" | "failed";
  payload: unknown;
  error?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  const params: unknown[] = [input.session.workspaceId];
  const eventSql = addUuidParam(params, input.calendarEventId);
  const providerSql = addParam(params, input.provider);
  const providerEventSql = addParam(params, input.providerEventId ?? null);
  const operationSql = addParam(params, input.operation);
  const statusSql = addParam(params, input.status);
  const payloadSql = addParam(params, JSON.stringify(input.payload ?? {}));
  const errorSql = addParam(params, input.error ?? null);

  const row = await queryOne<IdRow>(
    `
      insert into calendar_sync_events (
        workspace_id, calendar_event_id, provider, provider_event_id, operation, status, payload, error
      )
      values ($1, ${eventSql}, ${providerSql}, ${providerEventSql}, ${operationSql}, ${statusSql}, ${payloadSql}::jsonb, ${errorSql})
      returning id
    `,
    params,
  );

  return row?.id ?? null;
}

export async function listCalendarSyncEvents(input: {
  session: AppSession;
  limit?: number;
  status?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return [];

  const status = input.status && input.status !== "all" ? input.status : null;

  return queryRows<{
    id: string;
    calendarEventId: string | null;
    calendarTitle: string | null;
    provider: string;
    providerEventId: string | null;
    operation: string;
    status: string;
    payload: unknown;
    error: string | null;
    createdAt: string | Date;
    updatedAt: string | Date;
  }>(
    `
      select
        cse.id,
        cse.calendar_event_id as "calendarEventId",
        ce.title as "calendarTitle",
        cse.provider,
        cse.provider_event_id as "providerEventId",
        cse.operation,
        cse.status,
        cse.payload,
        cse.error,
        cse.created_at as "createdAt",
        cse.updated_at as "updatedAt"
      from calendar_sync_events cse
      left join calendar_events ce on ce.id = cse.calendar_event_id
      where cse.workspace_id = $1
        and ($2::text is null or cse.status = $2)
      order by cse.created_at desc
      limit $3
    `,
    [input.session.workspaceId, status, input.limit ?? 25],
  );
}

export async function insertCallInsight(input: {
  session: AppSession;
  projectId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  source: string;
  transcript: string;
  summary: string;
  sentiment: string;
  objections: unknown;
  actionItems: unknown;
  dealSignals: unknown;
  crmUpdates: unknown;
  knowledgeGaps: unknown;
  metadata?: unknown;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  const params: unknown[] = [input.session.workspaceId];
  const projectSql = addUuidParam(params, input.projectId);
  const contactSql = addUuidParam(params, input.contactId);
  const leadSql = addUuidParam(params, input.leadId);
  const sourceSql = addParam(params, input.source);
  const transcriptSql = addParam(params, input.transcript);
  const summarySql = addParam(params, input.summary);
  const sentimentSql = addParam(params, input.sentiment);
  const objectionsSql = addParam(params, JSON.stringify(input.objections ?? []));
  const actionsSql = addParam(params, JSON.stringify(input.actionItems ?? []));
  const signalsSql = addParam(params, JSON.stringify(input.dealSignals ?? []));
  const updatesSql = addParam(params, JSON.stringify(input.crmUpdates ?? []));
  const gapsSql = addParam(params, JSON.stringify(input.knowledgeGaps ?? []));
  const metadataSql = addParam(params, JSON.stringify(input.metadata ?? {}));

  const row = await queryOne<IdRow>(
    `
      insert into call_insights (
        workspace_id, project_id, contact_id, lead_id, source, transcript, summary, sentiment,
        objections, action_items, deal_signals, crm_updates, knowledge_gaps, metadata
      )
      values (
        $1, ${projectSql}, ${contactSql}, ${leadSql}, ${sourceSql}, ${transcriptSql},
        ${summarySql}, ${sentimentSql}, ${objectionsSql}::jsonb, ${actionsSql}::jsonb,
        ${signalsSql}::jsonb, ${updatesSql}::jsonb, ${gapsSql}::jsonb, ${metadataSql}::jsonb
      )
      returning id
    `,
    params,
  );

  return row?.id ?? null;
}

function getAnswerString(answers: FunnelSubmissionPayload["answers"], keys: string[]) {
  const normalized = new Map(Object.entries(answers).map(([key, value]) => [key.toLowerCase(), value]));

  for (const key of keys) {
    const value = normalized.get(key.toLowerCase());
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }

  return "";
}
