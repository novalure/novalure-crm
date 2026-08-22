import { randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { canViewAllWorkspaceContacts } from "@/lib/contact-access";
import {
  botWebhookActorProductRoles,
  isEligibleBotWebhookActor,
} from "@/lib/bots/webhook-actor";
import {
  botWebhookLeaseSeconds,
  botWebhookRateWindowMinutes,
  evaluateBotWebhookBudget,
} from "@/lib/bots/webhook-processing";
import type { BotEvaluationCaseResult, BotEvaluationRun } from "@/lib/crm-types";
import { writeCrmAnalyticsEvent } from "@/lib/db/analytics-event-repositories";
import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { recordSpeedToLeadEvent } from "@/lib/db/speed-to-lead-repositories";
import { withTenantTransaction, type TenantTransaction } from "@/lib/db/tenant-client";
import type { FunnelBlueprint, FunnelSubmissionPayload } from "@/lib/funnel-schema";
import { resolveCanonicalFunnelSubmissionSemantics } from "@/lib/funnel-submission-validation";
import { decryptSecret, encryptSecret } from "@/lib/integrations/secret-box";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { hasProductCapability } from "@/lib/product-model";
import {
  buildPublicContactIdentityLocks,
  normalizePublicContactEmail,
  normalizePublicContactPhone,
  publicContactIdentityLockNamespace,
} from "@/lib/security/public-contact-identity";

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
export type PersistenceResult =
  | { persisted: true; ids: Record<string, string | null> }
  | { persisted: false; reason: string };

export const funnelPublicationRevisionConflictReason =
  "Funnel publication revision changed";

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
  transaction?: TenantTransaction;
  webhookEventId?: string | null;
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
  const webhookEventSql = addUuidParam(params, input.webhookEventId);

  const query = `
      insert into audit_logs (
        workspace_id,
        project_id,
        deal_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        before,
        after,
        webhook_event_id
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
        ${afterSql}::jsonb,
        ${webhookEventSql}
      )
      on conflict (workspace_id, webhook_event_id, action)
        where webhook_event_id is not null
        do nothing
      returning id
    `;

  await (input.transaction
    ? input.transaction.queryOne(query, params)
    : queryOne(
        query,
        params,
      ));
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
  webhookEventId?: string | null;
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
  const webhookEventSql = addUuidParam(params, input.webhookEventId);

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
        payload,
        webhook_event_id
      )
      values (
        $1,
        ${projectSql},
        ${requestedBySql},
        ${entityTypeSql},
        ${entityIdSql},
        ${actionSql},
        ${summarySql},
        ${payloadSql}::jsonb,
        ${webhookEventSql}
      )
      on conflict (workspace_id, webhook_event_id, action)
        where webhook_event_id is not null
        do nothing
      returning id
    `,
    params,
  );

  if (row?.id) return row.id;
  if (!isUuid(input.webhookEventId)) return null;

  const existing = await queryOne<IdRow>(
    `
      select id
      from approval_requests
      where workspace_id = $1::uuid
        and webhook_event_id = $2::uuid
        and action = $3
      limit 1
    `,
    [input.session.workspaceId, input.webhookEventId, input.action],
  );

  return existing?.id ?? null;
}
type FunnelSubmissionPersistenceRow = {
  contactId: string | null;
  dealId: string | null;
  leadId: string | null;
  publicationRevisionMatched?: boolean;
  submissionId: string;
  taskId: string | null;
  timelineItemId: string | null;
};

type FunnelContactIdentityRow = {
  conflict: boolean;
};

export async function findPersistedFunnelSubmissionByIdempotency(input: {
  databaseFunnelId: string;
  submissionIdempotencyHash: string;
  workspaceId: string;
}): Promise<PersistenceResult> {
  if (
    !canPersist() ||
    !isUuid(input.workspaceId) ||
    !isUuid(input.databaseFunnelId) ||
    !/^[a-f0-9]{64}$/u.test(input.submissionIdempotencyHash)
  ) {
    return { persisted: false, reason: "Invalid live funnel submission replay scope" };
  }

  const idempotencyKey = `funnel:${input.submissionIdempotencyHash}`;
  const row = await queryOne<FunnelSubmissionPersistenceRow>(
    `
      select
        submission.id as "submissionId",
        submission.contact_id as "contactId",
        submission.lead_id as "leadId",
        (
          select deal.id
          from deals deal
          where deal.workspace_id = submission.workspace_id
            and deal.idempotency_key = $4
          limit 1
        ) as "dealId",
        (
          select task.id
          from tasks task
          where task.workspace_id = submission.workspace_id
            and task.metadata->>'submissionIdempotencyHash' = $3
          order by task.created_at asc
          limit 1
        ) as "taskId",
        (
          select timeline.id
          from contact_timeline_items timeline
          where timeline.workspace_id = submission.workspace_id
            and timeline.metadata->>'submissionIdempotencyHash' = $3
          order by timeline.occurred_at asc
          limit 1
        ) as "timelineItemId"
      from funnel_submissions submission
      where submission.workspace_id = $1::uuid
        and submission.funnel_id = $2::uuid
        and submission.idempotency_key = $4
      limit 1
    `,
    [input.workspaceId, input.databaseFunnelId, input.submissionIdempotencyHash, idempotencyKey],
  );

  if (!row?.submissionId || !row.contactId) {
    return { persisted: false, reason: "Live submission replay not found" };
  }
  return {
    ids: {
      contactId: row.contactId,
      dealId: row.dealId,
      leadId: row.leadId,
      submissionId: row.submissionId,
      taskId: row.taskId,
      timelineItemId: row.timelineItemId,
    },
    persisted: true,
  };
}

export async function persistFunnelSubmission(input: {
  databaseFunnelId: string;
  expectedPublicationRevision: number;
  session: AppSession;
  blueprint: FunnelBlueprint;
  payload: FunnelSubmissionPayload;
  score: number;
  submissionIdempotencyHash: string;
}): Promise<PersistenceResult> {
  if (!evaluateLaunchScope("publicFunnelSubmission").allowed) {
    return { persisted: false, reason: "Public funnel submission is launch-off" };
  }
  if (!canPersist()) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }
  if (
    !isUuid(input.session.workspaceId) ||
    !isUuid(input.session.userId) ||
    !isUuid(input.databaseFunnelId) ||
    !Number.isSafeInteger(input.expectedPublicationRevision) ||
    input.expectedPublicationRevision < 0 ||
    !/^[a-f0-9]{64}$/u.test(input.submissionIdempotencyHash)
  ) {
    return { persisted: false, reason: "Invalid live funnel submission scope" };
  }

  const semantics = resolveCanonicalFunnelSubmissionSemantics(input.blueprint, input.payload.answers);
  const contactName = semantics.contactName || "Funnel Lead";
  const email = semantics.email;
  const phone = semantics.phone;
  const intent = semantics.intent || input.blueprint.goal;
  const budget = semantics.budget;
  const leadType = input.blueprint.audience;
  const hotStatus = input.score >= 70;
  const consentLabel = input.payload.consent.marketing ? "Opt-in" : "Nur CRM";
  const followUp = input.blueprint.crmHandover.followUp || "Review funnel lead";
  const submissionIdempotencyKey = `funnel:${input.submissionIdempotencyHash}`;
  const tracking = {
    submissionIdempotencyHash: input.submissionIdempotencyHash,
    utm: input.payload.utm ?? {},
    visitor: input.payload.visitor,
  };
  const rawPayload = {
    ...input.payload,
    publicSubmission: undefined,
    submissionIdempotencyHash: input.submissionIdempotencyHash,
  };

  const normalizedEmail = normalizePublicContactEmail(email);
  const normalizedPhone = normalizePublicContactPhone(phone);
  const contactIdentityLocks = buildPublicContactIdentityLocks({
    email,
    fallback: input.submissionIdempotencyHash,
    phone,
  });
  const row = await withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      // Keep contact lookup and insert safe across Form and Funnel channels.
      // Locks are acquired in separate READ COMMITTED statements so each
      // following lookup sees records committed by the previous lock holder.
      for (const contactIdentityLock of contactIdentityLocks) {
        await transaction.execute(
          `select pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text || ':' || $3::text, 0))`,
          [input.session.workspaceId, publicContactIdentityLockNamespace, contactIdentityLock],
        );
      }

      const [contactIdentity] = await transaction.query<FunnelContactIdentityRow>(
        `
          with selected_funnel as (
            select workspace_id, project_id
            from funnels
            where workspace_id = $1::uuid and id = $2::uuid
          ),
          matched_contacts as (
            select
              contact.id,
              lower(btrim(contact.email)) as normalized_email,
              regexp_replace(coalesce(contact.phone, ''), '[^0-9+]', '', 'g') as normalized_phone
            from contacts contact
            join selected_funnel funnel on funnel.workspace_id = contact.workspace_id
            where contact.archived_at is null
              and (contact.project_id = funnel.project_id or contact.project_id is null)
              and (
                ($3::text is not null and lower(btrim(contact.email)) = $3::text)
                or ($4::text is not null and regexp_replace(coalesce(contact.phone, ''), '[^0-9+]', '', 'g') = $4::text)
              )
            for update of contact
          )
          select
            count(distinct id) > 1
            or coalesce(bool_or(
              (
                $3::text is not null
                and normalized_email = $3::text
                and $4::text is not null
                and nullif(normalized_phone, '') is not null
                and normalized_phone <> $4::text
              )
              or (
                $4::text is not null
                and normalized_phone = $4::text
                and $3::text is not null
                and nullif(normalized_email, '') is not null
                and normalized_email <> $3::text
              )
            ), false) as conflict
          from matched_contacts
        `,
        [
          input.session.workspaceId,
          input.databaseFunnelId,
          normalizedEmail || null,
          normalizedPhone || null,
        ],
      );
      if (contactIdentity?.conflict) return { identityConflict: true } as const;
      return transaction.queryOne<FunnelSubmissionPersistenceRow>(
    `
      with locked_funnel as (
        select
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          owner_user_id as "ownerUserId",
          name,
          coalesce(
            case
              when jsonb_typeof(tracking->'publicationRevision') = 'number'
                then (tracking->>'publicationRevision')::numeric
              else null
            end,
            0
          ) = $29::numeric as "publicationRevisionMatched"
        from funnels
        where workspace_id = $1::uuid
          and id = $2::uuid
          and project_id is not null
          and status = 'aktiv'
          and (
            (
              blueprint->>'schemaVersion' = '1'
              and blueprint->>'status' = 'aktiv'
              and jsonb_typeof(blueprint->'pages') = 'array'
            )
            or (
              blueprint->'blueprint'->>'schemaVersion' = '1'
              and blueprint->'blueprint'->>'status' = 'aktiv'
              and jsonb_typeof(blueprint->'blueprint'->'pages') = 'array'
            )
        )
        for update
      ),
      selected_funnel as (
        select id, "workspaceId", "projectId", "ownerUserId", name
        from locked_funnel
        where "publicationRevisionMatched"
      ),
      existing_submission as (
        select
          s.id as "submissionId",
          s.contact_id as "contactId",
          s.lead_id as "leadId"
        from funnel_submissions s
        join selected_funnel f
          on f."workspaceId" = s.workspace_id
         and f.id = s.funnel_id
        where s.idempotency_key = $26
        limit 1
      ),
      existing_contact as (
        select c.id
        from contacts c
        join selected_funnel f on f."workspaceId" = c.workspace_id
        where not exists (select 1 from existing_submission)
          and (
            ($27::text is not null and lower(btrim(c.email)) = $27::text)
            or ($28::text is not null and regexp_replace(coalesce(c.phone, ''), '[^0-9+]', '', 'g') = $28::text)
          )
          and (c.project_id = f."projectId" or c.project_id is null)
          and c.archived_at is null
        order by (c.project_id = f."projectId") desc, c.created_at asc
        limit 1
        for update of c
      ),
      updated_contact as (
        update contacts c
        set
          email = coalesce(nullif(btrim(c.email), ''), $8::text),
          phone = coalesce(nullif(btrim(c.phone), ''), $9::text),
          updated_at = now()
        from existing_contact existing
        where c.id = existing.id
        returning c.id
      ),
      inserted_contact as (
        insert into contacts (
          workspace_id,
          project_id,
          owner_user_id,
          name,
          role,
          source,
          intent,
          consent_label,
          email,
          phone,
          metadata
        )
        select
          f."workspaceId",
          f."projectId",
          f."ownerUserId",
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::jsonb
        from selected_funnel f
        where not exists (select 1 from existing_submission)
          and not exists (select 1 from existing_contact)
        returning id
      ),
      chosen_contact as (
        select "contactId" as id from existing_submission where "contactId" is not null
        union all
        select id from updated_contact
        union all
        select id from inserted_contact
        limit 1
      ),
      inserted_lead as (
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
          metadata,
          idempotency_key
        )
        select
          f."workspaceId",
          f."projectId",
          c.id,
          f."ownerUserId",
          $5,
          $4,
          case when $12::boolean then 'Termin offen' else 'Qualifizieren' end,
          $13::integer,
          $14,
          $6,
          $15,
          now(),
          now() + interval '4 hours',
          $12::boolean,
          jsonb_build_object(
            'answers', $16::jsonb,
            'consent', $17::jsonb,
            'submissionIdempotencyHash', $24
          ),
          $26
        from selected_funnel f
        cross join chosen_contact c
        where $11::boolean
          and not exists (select 1 from existing_submission)
        returning id
      ),
      inserted_submission as (
        insert into funnel_submissions (
          workspace_id,
          project_id,
          funnel_id,
          contact_id,
          lead_id,
          mode,
          score,
          answers,
          consent,
          tracking,
          raw_payload,
          idempotency_key
        )
        select
          f."workspaceId",
          f."projectId",
          f.id,
          c.id,
          (select id from inserted_lead limit 1),
          'live',
          $13::integer,
          $16::jsonb,
          $17::jsonb,
          $18::jsonb,
          $19::jsonb,
          $26
        from selected_funnel f
        cross join chosen_contact c
        where not exists (select 1 from existing_submission)
        returning id
      ),
      inserted_deal as (
        insert into deals (
          workspace_id,
          project_id,
          contact_id,
          owner_user_id,
          lead_id,
          name,
          stage,
          probability,
          source,
          next_action,
          metadata,
          idempotency_key
        )
        select
          f."workspaceId",
          f."projectId",
          c.id,
          f."ownerUserId",
          (select id from inserted_lead limit 1),
          $3 || ' - ' || f.name,
          $21,
          least(95, greatest(10, $13::integer)),
          $5,
          $15,
          jsonb_build_object(
            'submissionId', s.id,
            'submissionIdempotencyHash', $24
          ),
          $26
        from selected_funnel f
        cross join chosen_contact c
        cross join inserted_submission s
        where $20 = 'pipeline'
        returning id
      ),
      inserted_privacy_consent as (
        insert into consent_records (
          workspace_id,
          contact_id,
          project_id,
          channel,
          status,
          source,
          metadata
        )
        select
          f."workspaceId",
          c.id,
          f."projectId",
          'Funnel',
          'Opt-in',
          f.name,
          jsonb_build_object(
            'consent', $17::jsonb,
            'funnelId', f.id,
            'submissionId', s.id,
            'submissionIdempotencyHash', $24,
            'submissionMode', 'live'
          )
        from selected_funnel f
        cross join chosen_contact c
        cross join inserted_submission s
        where $25::boolean
        returning id
      ),
      inserted_marketing_consent as (
        insert into consent_records (
          workspace_id,
          contact_id,
          project_id,
          channel,
          status,
          source,
          metadata
        )
        select
          f."workspaceId",
          c.id,
          f."projectId",
          'Newsletter',
          'Opt-in',
          f.name,
          jsonb_build_object(
            'consent', $17::jsonb,
            'funnelId', f.id,
            'submissionId', s.id,
            'submissionIdempotencyHash', $24,
            'submissionMode', 'live'
          )
        from selected_funnel f
        cross join chosen_contact c
        cross join inserted_submission s
        where $23::boolean
        returning id
      ),
      inserted_task as (
        insert into tasks (
          workspace_id,
          project_id,
          contact_id,
          lead_id,
          owner_user_id,
          title,
          due_at,
          priority,
          status,
          metadata
        )
        select
          f."workspaceId",
          f."projectId",
          c.id,
          (select id from inserted_lead limit 1),
          f."ownerUserId",
          $15,
          now() + interval '2 hours',
          case when $12::boolean then 'Hoch' else 'Mittel' end,
          'open',
          jsonb_build_object(
            'submissionId', s.id,
            'submissionIdempotencyHash', $24
          )
        from selected_funnel f
        cross join chosen_contact c
        cross join inserted_submission s
        where $22::boolean
        returning id
      ),
      inserted_timeline as (
        insert into contact_timeline_items (
          workspace_id,
          contact_id,
          project_id,
          channel,
          title,
          detail,
          outcome,
          metadata
        )
        select
          f."workspaceId",
          c.id,
          f."projectId",
          $5,
          'Funnel submission',
          $6 || ' · Score ' || $13::text,
          case when $12::boolean then 'offen' else 'info' end,
          jsonb_build_object(
            'leadId', (select id from inserted_lead limit 1),
            'submissionId', s.id,
            'submissionIdempotencyHash', $24
          )
        from selected_funnel f
        cross join chosen_contact c
        cross join inserted_submission s
        returning id
      ),
      updated_funnel as (
        update funnels f
        set
          leads_count = f.leads_count + 1,
          conversion_rate = case
            when f.visits > 0
              then round(((f.leads_count + 1)::numeric / f.visits::numeric) * 100, 2)
            else f.conversion_rate
          end,
          updated_at = now()
        from inserted_submission s
        where f.id = $2::uuid
          and f.workspace_id = $1::uuid
        returning f.id
      ),
      inserted_audit as (
        insert into audit_logs (
          workspace_id,
          project_id,
          actor_user_id,
          action,
          entity_type,
          entity_id,
          before,
          after
        )
        select
          f."workspaceId",
          f."projectId",
          null,
          'funnel.submission.persisted',
          'funnel_submission',
          s.id,
          null,
          jsonb_build_object(
            'contactId', c.id,
            'dealId', (select id from inserted_deal limit 1),
            'leadId', (select id from inserted_lead limit 1),
            'submissionIdempotencyHash', $24,
            'taskId', (select id from inserted_task limit 1)
          )
        from selected_funnel f
        cross join chosen_contact c
        cross join inserted_submission s
        returning id
      ),
      inserted_funnel_analytics as (
        insert into analytics_events (
          workspace_id,
          project_id,
          entity_id,
          entity_type,
          user_id,
          contact_id,
          lead_id,
          deal_id,
          funnel_id,
          event_type,
          module,
          source,
          channel,
          value_cents,
          occurred_at,
          metadata
        )
        select
          f."workspaceId",
          f."projectId",
          s.id,
          'funnel_submission',
          null,
          c.id,
          (select id from inserted_lead limit 1),
          (select id from inserted_deal limit 1),
          f.id,
          'funnel_submit',
          'funnel',
          $5,
          $5,
          0,
          now(),
          jsonb_build_object(
            'analyticsVersion', 1,
            'answers', $16::jsonb,
            'consent', $17::jsonb,
            'destination', $20,
            'entityId', s.id,
            'entityType', 'funnel_submission',
            'mode', 'live',
            'score', $13::integer,
            'submissionIdempotencyHash', $24,
            'tracking', $18::jsonb
          )
        from selected_funnel f
        cross join chosen_contact c
        cross join inserted_submission s
        returning id
      ),
      inserted_lead_analytics as (
        insert into analytics_events (
          workspace_id,
          project_id,
          entity_id,
          entity_type,
          user_id,
          contact_id,
          lead_id,
          deal_id,
          funnel_id,
          event_type,
          module,
          source,
          channel,
          value_cents,
          occurred_at,
          metadata
        )
        select
          f."workspaceId",
          f."projectId",
          l.id,
          'lead',
          null,
          c.id,
          l.id,
          (select id from inserted_deal limit 1),
          f.id,
          'lead_created',
          'lead_inbox',
          $5,
          $5,
          0,
          now(),
          jsonb_build_object(
            'analyticsVersion', 1,
            'entityId', l.id,
            'entityType', 'lead',
            'score', $13::integer,
            'slaHours', 4,
            'status', case when $12::boolean then 'Termin offen' else 'Qualifizieren' end,
            'submissionIdempotencyHash', $24,
            'trigger', 'funnel_submit'
          )
        from selected_funnel f
        cross join chosen_contact c
        cross join inserted_lead l
        returning id
      ),
      inserted_speed_to_lead as (
        insert into speed_to_lead_events (
          workspace_id,
          project_id,
          lead_id,
          contact_id,
          owner_user_id,
          state,
          due_at,
          first_response_at,
          minutes_until_due,
          notification_channel,
          metadata
        )
        select
          f."workspaceId",
          f."projectId",
          l.id,
          c.id,
          f."ownerUserId",
          'covered',
          now() + interval '4 hours',
          null,
          240,
          'teams',
          jsonb_build_object(
            'score', $13::integer,
            'source', $5,
            'sourcePayload', 'funnel_submission',
            'submissionId', s.id,
            'submissionIdempotencyHash', $24,
            'trigger', 'funnel_submit'
          )
        from selected_funnel f
        cross join chosen_contact c
        cross join inserted_lead l
        cross join inserted_submission s
        returning id
      ),
      existing_deal as (
        select d.id
        from deals d
        join selected_funnel f on f."workspaceId" = d.workspace_id
        where d.idempotency_key = $26
        limit 1
      ),
      existing_task as (
        select t.id
        from tasks t
        join selected_funnel f on f."workspaceId" = t.workspace_id
        where t.metadata->>'submissionIdempotencyHash' = $24
        order by t.created_at asc
        limit 1
      ),
      existing_timeline as (
        select timeline.id
        from contact_timeline_items timeline
        join selected_funnel f on f."workspaceId" = timeline.workspace_id
        where timeline.metadata->>'submissionIdempotencyHash' = $24
        order by timeline.occurred_at asc
        limit 1
      )
      select
        s.id as "submissionId",
        c.id as "contactId",
        (select id from inserted_lead limit 1) as "leadId",
        (select id from inserted_deal limit 1) as "dealId",
        (select id from inserted_task limit 1) as "taskId",
        (select id from inserted_timeline limit 1) as "timelineItemId",
        true as "publicationRevisionMatched"
      from inserted_submission s
      cross join chosen_contact c
      cross join updated_funnel f
      where (select count(*) from inserted_audit) = 1
        and (select count(*) from inserted_funnel_analytics) = 1
        and (
          (select count(*) from inserted_lead) = 0
          or (
            (select count(*) from inserted_lead_analytics) = 1
            and (select count(*) from inserted_speed_to_lead) = 1
          )
        )
        and (
          not $25::boolean
          or (select count(*) from inserted_privacy_consent) = 1
        )
        and (
          not $23::boolean
          or (select count(*) from inserted_marketing_consent) = 1
        )
      union all
      select
        existing."submissionId",
        existing."contactId",
        existing."leadId",
        (select id from existing_deal limit 1),
        (select id from existing_task limit 1),
        (select id from existing_timeline limit 1),
        true
      from existing_submission existing
      where existing."contactId" is not null
      union all
      select
        null::uuid,
        null::uuid,
        null::uuid,
        null::uuid,
        null::uuid,
        null::uuid,
        false
      from locked_funnel
      where not "publicationRevisionMatched"
    `,
    [
      input.session.workspaceId,
      input.databaseFunnelId,
      contactName,
      leadType,
      input.blueprint.entryChannel,
      intent,
      consentLabel,
      email || null,
      phone || null,
      JSON.stringify({
        submissionIdempotencyHash: input.submissionIdempotencyHash,
        utm: input.payload.utm ?? {},
        visitor: input.payload.visitor,
      }),
      input.blueprint.crmHandover.createLeadInboxEntry,
      hotStatus,
      input.score,
      budget || null,
      followUp,
      JSON.stringify(input.payload.answers),
      JSON.stringify(input.payload.consent),
      JSON.stringify(tracking),
      JSON.stringify(rawPayload),
      input.blueprint.crmHandover.destination,
      input.blueprint.crmHandover.pipelineStage || "Neuer Lead",
      input.blueprint.crmHandover.createTask,
      input.payload.consent.marketing,
      input.submissionIdempotencyHash,
      input.payload.consent.privacy,
      submissionIdempotencyKey,
      normalizedEmail || null,
      normalizedPhone || null,
      input.expectedPublicationRevision,
        ],
      );
    },
  );

  if (row && "identityConflict" in row) {
    return { persisted: false, reason: "Funnel contact identity conflict" };
  }
  if (row?.publicationRevisionMatched === false) {
    return { persisted: false, reason: funnelPublicationRevisionConflictReason };
  }
  if (!row?.submissionId || !row.contactId) {
    return { persisted: false, reason: "Live submission could not be persisted atomically" };
  }

  return {
    persisted: true,
    ids: {
      submissionId: row.submissionId,
      contactId: row.contactId,
      leadId: row.leadId,
      dealId: row.dealId,
      taskId: row.taskId,
      timelineItemId: row.timelineItemId,
    },
  };
}
export async function persistFunnelTestSubmission(input: {
  databaseFunnelId: string;
  session: AppSession;
  blueprint: FunnelBlueprint;
  payload: FunnelSubmissionPayload;
  score: number;
}): Promise<PersistenceResult> {
  if (!canPersist()) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const funnel = await findSubmissionFunnel(input.session, input.databaseFunnelId);
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

  if (!submission) {
    return { persisted: false, reason: "Test submission could not be persisted" };
  }

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

async function findSubmissionFunnel(session: AppSession, databaseFunnelId: string) {
  if (!isUuid(session.workspaceId) || !isUuid(databaseFunnelId)) return null;

  return queryOne<FunnelRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        owner_user_id as "ownerUserId",
        name
      from funnels
      where workspace_id = $1
        and id = $2::uuid
        and project_id is not null
      limit 1
    `,
    [session.workspaceId, databaseFunnelId],
  );
}

export async function isKnowledgeProjectInWorkspace(input: {
  projectId?: string | null;
  session: AppSession;
}) {
  if (!input.projectId) return true;
  if (
    !canPersist() ||
    !isUuid(input.session.workspaceId) ||
    !isUuid(input.projectId)
  ) {
    return false;
  }

  const project = await queryOne<IdRow>(
    `
      select id
      from projects
      where workspace_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    [input.session.workspaceId, input.projectId],
  );
  return Boolean(project);
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
  const chunksSql = addParam(
    params,
    JSON.stringify(
      input.chunks.map((chunk) => ({
        chunk_index: chunk.chunkIndex,
        citation_title: chunk.citationTitle,
        citation_url: chunk.citationUrl ?? null,
        content: chunk.content,
        embedding_model: chunk.embeddingModel ?? null,
        embedding_text: chunk.embedding?.length ? `[${chunk.embedding.join(",")}]` : null,
        metadata: { embedding: chunk.embedding ? "stored" : null, embeddingReady: Boolean(chunk.embedding) },
        token_count: chunk.tokenCount,
      })),
    ),
  );

  const source = await queryOne<IdRow>(
    `
      with selected_project as (
        select id
        from projects
        where workspace_id = $1::uuid
          and id = ${projectSql}
      ),
      inserted_source as (
        insert into knowledge_sources (
          workspace_id, project_id, name, source_type, status, item_count, location, metadata
        )
        select
          $1::uuid,
          selected_project.id,
          ${titleSql},
          ${sourceTypeSql},
          ${statusSql},
          ${countSql},
          ${locationSql},
          ${metadataSql}::jsonb
        from (values (true)) as request_guard(allowed)
        left join selected_project on true
        where ${projectSql} is null or selected_project.id is not null
        returning id
      ),
      inserted_chunks as (
        insert into knowledge_chunks (
          source_id, chunk_index, content, citation_title, citation_url, embedding, token_count, embedding_model, metadata
        )
        select
          inserted_source.id,
          chunk.chunk_index,
          chunk.content,
          chunk.citation_title,
          chunk.citation_url,
          case when chunk.embedding_text is null then null else chunk.embedding_text::vector end,
          chunk.token_count,
          chunk.embedding_model,
          chunk.metadata
        from inserted_source
        cross join lateral jsonb_to_recordset(${chunksSql}::jsonb) as chunk(
          chunk_index integer,
          content text,
          citation_title text,
          citation_url text,
          embedding_text text,
          token_count integer,
          embedding_model text,
          metadata jsonb
        )
        returning id
      )
      select id from inserted_source
    `,
    params,
  );

  if (!source) return null;

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
  webhookEventId?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  if (isUuid(input.webhookEventId)) {
    const webhookConversation = await queryOne<IdRow>(
      `
        select id
        from bot_conversations
        where workspace_id = $1::uuid
          and webhook_event_id = $2::uuid
        limit 1
      `,
      [input.session.workspaceId, input.webhookEventId],
    );
    if (webhookConversation) return webhookConversation.id;
  }

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
  const webhookEventSql = addUuidParam(params, input.webhookEventId);

  const row = await queryOne<IdRow>(
    `
      insert into bot_conversations (
        workspace_id, project_id, bot_id, contact_id, lead_id, title, language, model, metadata,
        webhook_event_id
      )
      select $1, ${projectSql}, ${botSql}, ${contactSql}, ${leadSql}, ${titleSql}, ${languageSql}, ${modelSql}, ${metadataSql}::jsonb,
        ${webhookEventSql}
      where (${projectSql} is null or exists (
          select 1 from projects where workspace_id = $1 and id = ${projectSql}
        ))
        and (${botSql} is null or exists (
          select 1 from bots where workspace_id = $1 and id = ${botSql}
        ))
        and (${contactSql} is null or exists (
          select 1 from contacts where workspace_id = $1 and id = ${contactSql} and archived_at is null
        ))
        and (${leadSql} is null or exists (
          select 1 from leads where workspace_id = $1 and id = ${leadSql}
        ))
      on conflict (workspace_id, webhook_event_id)
        where webhook_event_id is not null
        do nothing
      returning id
    `,
    params,
  );

  if (row?.id) return row.id;
  if (!isUuid(input.webhookEventId)) return null;

  const existing = await queryOne<IdRow>(
    `
      select id
      from bot_conversations
      where workspace_id = $1::uuid
        and webhook_event_id = $2::uuid
      limit 1
    `,
    [input.session.workspaceId, input.webhookEventId],
  );

  return existing?.id ?? null;
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
  if (
    !canPersist() ||
    !isUuid(input.session.workspaceId) ||
    !isUuid(input.session.userId) ||
    !input.session.permissions.includes("crm:write") ||
    !canViewAllWorkspaceContacts(input.session)
  ) return null;

  const requestedProjectId = cleanString(input.projectId);
  if (requestedProjectId && !isUuid(requestedProjectId)) return null;

  const now = new Date().toISOString();
  const slaDueAt = new Date(Date.now() + 1000 * 60 * 60 * 4).toISOString();
  const email = normalizeEmailForStorage(input.customerData?.email || extractEmail(input.prompt));
  const phone = formatPhoneForCrm(input.customerData?.phone || input.contactRef || extractPhone(input.prompt));
  const normalizedEmail = normalizePublicContactEmail(email);
  const normalizedPhone = normalizePublicContactPhone(phone);
  const extractedName = cleanString(input.customerData?.name) || extractName(input.prompt);
  const name = extractedName || (phone ? "WhatsApp " + phone : "WhatsApp Kontakt");
  const leadType = normalizeLeadType(input.prompt);
  const source = cleanString(input.channel) || "Bot";
  const consentLabel = normalizeConsentLabel(input.customerData?.consent);
  const score = Math.min(100, Math.max(0, Math.round(typeof input.score === "number" ? input.score : 50)));
  const hotStatus = score >= 70;
  const intent = input.prompt.slice(0, 260);
  const nextAction = cleanString(input.nextAction) || (hotStatus ? "Lead prüfen und Termin vorbereiten" : "Antwort prüfen und Lead qualifizieren");
  const ownerUserId = input.session.userId;
  const contactRef = cleanString(input.contactRef);
  const metadata = {
    bot: {
      channel: source,
      contactRef: contactRef || null,
      externalMessageId: input.externalMessageId ?? null,
      lastMessageAt: now,
      webhookEventId: input.webhookEventId ?? null,
    },
    preferredChannel: input.customerData?.preferredChannel ?? source,
  };
  const leadMetadata = {
    bot: metadata.bot,
    lastCustomerMessage: input.prompt,
  };
  const contactIdentityLocks = [...new Set([
    ...buildPublicContactIdentityLocks({
      email,
      fallback:
        contactRef ||
        cleanString(input.externalMessageId) ||
        cleanString(input.webhookEventId) ||
        `${source}:${name}`,
      phone,
    }),
    ...(contactRef ? [`bot-ref:${contactRef}`] : []),
  ])].sort();

  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const actor = await transaction.queryOne<IdRow>(
        `
          select id
          from workspace_users
          where workspace_id = $1::uuid
            and id = $2::uuid
            and status = 'active'
          for share
        `,
        [input.session.workspaceId, ownerUserId],
      );
      if (!actor) return null;

      if (requestedProjectId) {
        const project = await transaction.queryOne<IdRow>(
          `
            select id
            from projects
            where workspace_id = $1::uuid
              and id = $2::uuid
            for share
          `,
          [input.session.workspaceId, requestedProjectId],
        );
        if (!project) return null;
      }

      for (const contactIdentityLock of contactIdentityLocks) {
        // Bot, Form, Funnel and manual CRM writes must serialize on the same
        // workspace-scoped identity keys before observing contact state.
        await transaction.execute(
          "select pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text || ':' || $3::text, 0))",
          [input.session.workspaceId, publicContactIdentityLockNamespace, contactIdentityLock],
        );
      }

      if (isUuid(input.webhookEventId)) {
        const replay = await transaction.queryOne<{
          contactId: string;
          leadId: string | null;
          timelineItemId: string;
        }>(
          `
            select
              timeline.contact_id as "contactId",
              lead.id as "leadId",
              timeline.id as "timelineItemId"
            from contact_timeline_items timeline
            left join leads lead
              on lead.workspace_id = timeline.workspace_id
              and lead.id::text = timeline.metadata->>'leadId'
            where timeline.workspace_id = $1::uuid
              and timeline.webhook_event_id = $2::uuid
            limit 1
            for update of timeline
          `,
          [input.session.workspaceId, input.webhookEventId],
        );
        if (replay) {
          return {
            contactCreated: false,
            contactId: replay.contactId,
            leadCreated: false,
            leadId: replay.leadId,
            timelineItemId: replay.timelineItemId,
          };
        }
      }

      type BotContactRow = IdRow & {
        email: string | null;
        phone: string | null;
        projectId: string | null;
      };
      const contactMatches = await transaction.query<BotContactRow>(
        `
          select
            id,
            email,
            phone,
            project_id as "projectId"
          from contacts
          where workspace_id = $1::uuid
            and archived_at is null
            and (
              ($2::text is not null and lower(btrim(email)) = $2::text)
              or (
                $3::text is not null
                and regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g') = $3::text
              )
              or ($4::text is not null and metadata->'bot'->>'contactRef' = $4::text)
            )
          order by updated_at desc
          limit 2
          for update
        `,
        [
          input.session.workspaceId,
          normalizedEmail || null,
          normalizedPhone || null,
          contactRef || null,
        ],
      );
      // A single bot payload must never merge two contacts when its email,
      // phone or channel reference resolve to different tenant records.
      if (contactMatches.length > 1) return null;
      const existingContact = contactMatches[0] ?? null;
      const existingNormalizedEmail = normalizePublicContactEmail(existingContact?.email);
      const existingNormalizedPhone = normalizePublicContactPhone(existingContact?.phone);
      const contactIdentityConflict = Boolean(
        existingContact && (
          (
            normalizedEmail &&
            existingNormalizedEmail &&
            normalizedEmail !== existingNormalizedEmail
          ) ||
          (
            normalizedPhone &&
            existingNormalizedPhone &&
            normalizedPhone !== existingNormalizedPhone
          )
        ),
      );
      // A contactRef, email or phone match may enrich a missing identity, but
      // it must never replace an already established non-empty identity.
      if (contactIdentityConflict) return null;

      const contact = existingContact
        ? await transaction.queryOne<BotContactRow>(
            `
              update contacts
              set owner_user_id = coalesce(owner_user_id, $3::uuid),
                  project_id = coalesce($4::uuid, project_id),
                  name = coalesce(nullif($5, ''), name),
                  role = $6,
                  source = $7,
                  intent = $8,
                  consent_label = $9,
                  email = coalesce(nullif($10, ''), email),
                  phone = coalesce(nullif($11, ''), phone),
                  metadata = metadata || $12::jsonb,
                  updated_at = now()
              where workspace_id = $1::uuid
                and id = $2::uuid
                and archived_at is null
              returning id, email, phone, project_id as "projectId"
            `,
            [
              input.session.workspaceId,
              existingContact.id,
              ownerUserId,
              requestedProjectId || null,
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
        : await transaction.queryOne<BotContactRow>(
            `
              insert into contacts (
                workspace_id, project_id, owner_user_id, name, role, source, intent, consent_label, email, phone, metadata
              )
              values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, nullif($9, ''), nullif($10, ''), $11::jsonb)
              returning id, email, phone, project_id as "projectId"
            `,
            [
              input.session.workspaceId,
              requestedProjectId || null,
              ownerUserId,
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
      if (!contact) throw new Error("Bot CRM contact could not be persisted");

      type BotLeadRow = IdRow & { projectId: string | null };
      const existingLead = await transaction.queryOne<BotLeadRow>(
        `
          select id, project_id as "projectId"
          from leads
          where workspace_id = $1::uuid
            and contact_id = $2::uuid
            and source = $3
          order by updated_at desc
          limit 1
          for update
        `,
        [input.session.workspaceId, contact.id, source],
      );
      const lead = existingLead
        ? await transaction.queryOne<BotLeadRow>(
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
              where workspace_id = $1::uuid and id = $2::uuid
              returning id, project_id as "projectId"
            `,
            [
              input.session.workspaceId,
              existingLead.id,
              requestedProjectId || null,
              leadType,
              statusFromScore(score),
              score,
              intent,
              nextAction,
              hotStatus,
              JSON.stringify(leadMetadata),
            ],
          )
        : await transaction.queryOne<BotLeadRow>(
            `
              insert into leads (
                workspace_id, project_id, contact_id, source, type, status, score, intent, next_action,
                received_at, sla_due_at, last_contact_at, next_contact_at, hot_status, metadata
              )
              values (
                $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9,
                $10::timestamptz, $11::timestamptz, $10::timestamptz, $11::timestamptz, $12, $13::jsonb
              )
              returning id, project_id as "projectId"
            `,
            [
              input.session.workspaceId,
              requestedProjectId || contact.projectId,
              contact.id,
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
      if (!lead) throw new Error("Bot CRM lead could not be persisted");

      const effectiveProjectId = lead.projectId ?? contact.projectId ?? null;
      const timeline = await transaction.queryOne<IdRow>(
        `
          insert into contact_timeline_items (
            workspace_id, contact_id, project_id, channel, title, detail, outcome, metadata,
            webhook_event_id
          )
          values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'info', $7::jsonb, $8::uuid)
          on conflict (workspace_id, webhook_event_id)
            where webhook_event_id is not null
            do nothing
          returning id
        `,
        [
          input.session.workspaceId,
          contact.id,
          effectiveProjectId,
          source,
          source + " Bot-Nachricht",
          input.prompt.slice(0, 600),
          JSON.stringify({ bot: metadata.bot, leadId: lead.id }),
          isUuid(input.webhookEventId) ? input.webhookEventId : null,
        ],
      );
      if (!timeline && isUuid(input.webhookEventId)) {
        const replay = await transaction.queryOne<{
          contactId: string;
          leadId: string | null;
          timelineItemId: string;
        }>(
          `
            select
              timeline.contact_id as "contactId",
              lead.id as "leadId",
              timeline.id as "timelineItemId"
            from contact_timeline_items timeline
            left join leads lead
              on lead.workspace_id = timeline.workspace_id
              and lead.id::text = timeline.metadata->>'leadId'
            where timeline.workspace_id = $1::uuid
              and timeline.webhook_event_id = $2::uuid
            limit 1
          `,
          [input.session.workspaceId, input.webhookEventId],
        );
        if (replay) {
          return {
            contactCreated: false,
            contactId: replay.contactId,
            leadCreated: false,
            leadId: replay.leadId,
            timelineItemId: replay.timelineItemId,
          };
        }
      }
      if (!timeline) throw new Error("Bot CRM timeline item could not be persisted");

      await writeAuditLog({
        action: existingContact ? "bot.contact.updated" : "bot.contact.created",
        after: {
          channel: source,
          contactId: contact.id,
          leadId: lead.id,
          trigger: "bot_message",
        },
        before: existingContact
          ? { contactId: existingContact.id, projectId: existingContact.projectId }
          : null,
        entityId: contact.id,
        entityType: "contact",
        projectId: effectiveProjectId,
        session: input.session,
        transaction,
        webhookEventId: input.webhookEventId,
      });
      await writeAuditLog({
        action: existingLead ? "bot.lead.updated" : "bot.lead.created",
        after: {
          channel: source,
          contactId: contact.id,
          leadId: lead.id,
          score,
          status: statusFromScore(score),
          trigger: "bot_message",
        },
        before: existingLead
          ? { leadId: existingLead.id, projectId: existingLead.projectId }
          : null,
        entityId: lead.id,
        entityType: "lead",
        projectId: effectiveProjectId,
        session: input.session,
        transaction,
        webhookEventId: input.webhookEventId,
      });

      if (!existingLead) {
        const analyticsEventId = await writeCrmAnalyticsEvent({
          channel: source,
          contactId: contact.id,
          entityId: lead.id,
          entityType: "lead",
          eventType: "lead_created",
          leadId: lead.id,
          metadata: {
            contactCreated: !existingContact,
            externalMessageId: input.externalMessageId ?? null,
            score,
            status: statusFromScore(score),
            trigger: "bot_message",
            webhookEventId: input.webhookEventId ?? null,
          },
          module: "lead_inbox",
          projectId: effectiveProjectId,
          source,
          transaction,
          userId: input.session.userId,
          workspaceId: input.session.workspaceId,
        });
        if (!analyticsEventId) throw new Error("Bot CRM analytics event could not be persisted");

        const speedToLeadEventId = await recordSpeedToLeadEvent({
          channel: source,
          contactId: contact.id,
          dueAt: slaDueAt,
          leadId: lead.id,
          metadata: {
            externalMessageId: input.externalMessageId ?? null,
            score,
            sourcePayload: "bot_message",
            trigger: "bot_message",
            webhookEventId: input.webhookEventId ?? null,
          },
          ownerUserId,
          projectId: effectiveProjectId,
          source,
          state: "covered",
          transaction,
          userId: input.session.userId,
          workspaceId: input.session.workspaceId,
        });
        if (!speedToLeadEventId) throw new Error("Bot CRM speed-to-lead event could not be persisted");
      }

      return {
        contactCreated: !existingContact,
        contactId: contact.id,
        leadCreated: !existingLead,
        leadId: lead.id,
        timelineItemId: timeline.id,
      };
    },
  );
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
        and ($3::uuid is null or exists (
          select 1 from contacts where workspace_id = $2 and id = $3::uuid and archived_at is null
        ))
        and ($4::uuid is null or exists (
          select 1 from leads where workspace_id = $2 and id = $4::uuid
        ))
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
export async function updateBotConversationStatus(input: {
  session: AppSession;
  conversationId?: string | null;
  status: "open" | "handoff" | "resolved";
  metadata?: unknown;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.conversationId)) return null;

  const row = await queryOne<IdRow>(
    `
      update bot_conversations
      set status = $3,
          metadata = metadata || $4::jsonb,
          updated_at = now()
      where id = $1 and workspace_id = $2
      returning id
    `,
    [
      input.conversationId,
      input.session.workspaceId,
      input.status,
      JSON.stringify(input.metadata ?? {}),
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
  const channel = cleanString(input.channel);
  if (!canPersist()) return { account: null, status: "unavailable" as const };
  if (!accountRef || !channel || accountRef.length > 256 || channel.length > 80) {
    return { account: null, status: "not_found" as const };
  }

  const rows = await queryRows<{
    actorProductRole: string;
    actorRole: string;
    actorStatus: string;
    actorUserId: string;
    botId: string | null;
    id: string;
    workspaceId: string;
    workspaceName: string | null;
    channel: string;
    externalAccountId: string;
    projectId: string | null;
    provider: string;
    metadata: unknown;
  }>(
    `
      select
        webhook_actor.product_role as "actorProductRole",
        webhook_actor.role as "actorRole",
        webhook_actor.status as "actorStatus",
        webhook_actor.id as "actorUserId",
        bot.id as "botId",
        bca.id,
        bca.workspace_id as "workspaceId",
        w.name as "workspaceName",
        bca.channel,
        bca.external_account_id as "externalAccountId",
        bot.project_id as "projectId",
        bca.provider,
        bca.metadata
      from bot_channel_accounts bca
      left join workspaces w on w.id = bca.workspace_id
      left join bots bot
        on bot.workspace_id = bca.workspace_id
        and bot.id = bca.bot_id
      join lateral (
        select
          workspace_user.id,
          workspace_user.product_role,
          workspace_user.role,
          workspace_user.status
        from workspace_users workspace_user
        where workspace_user.workspace_id = bca.workspace_id
          and workspace_user.status = 'active'
          and workspace_user.role in ('owner', 'admin', 'agent')
          and workspace_user.product_role = any($3::text[])
        order by
          case
            when workspace_user.id::text = bca.metadata->>'connectedByUserId' then 0
            else 1
          end,
          case workspace_user.role
            when 'owner' then 0
            when 'admin' then 1
            else 2
          end,
          workspace_user.created_at asc,
          workspace_user.id asc
        limit 1
      ) webhook_actor on true
      where bca.active = true
        and bca.setup_status in ('ready', 'connected')
        and bca.workspace_id is not null
        and lower(bca.channel) = lower($1)
        and bca.external_account_id = $2
      order by bca.updated_at desc
      limit 2
    `,
    [channel, accountRef, [...botWebhookActorProductRoles]],
  );

  if (rows.length === 0) return { account: null, status: "not_found" as const };
  if (rows.length !== 1) return { account: null, status: "ambiguous" as const };

  const row = rows[0];
  const actorCandidate = row ? {
    productRole: row.actorProductRole,
    role: row.actorRole,
    status: row.actorStatus,
  } : null;
  if (
    !row ||
    !actorCandidate ||
    !isUuid(row.workspaceId) ||
    !isUuid(row.actorUserId) ||
    !isEligibleBotWebhookActor(actorCandidate) ||
    (row.botId !== null && !isUuid(row.botId)) ||
    (row.projectId !== null && !isUuid(row.projectId))
  ) return { account: null, status: "not_found" as const };

  return {
    account: {
      ...row,
      actorProductRole: actorCandidate.productRole,
      actorRole: actorCandidate.role,
      credentials: decryptBotChannelCredentials(row.metadata),
    },
    status: "matched" as const,
  };
}

export async function insertBotChannelWebhook(input: {
  actorUserId: string;
  applyRateBudget: boolean;
  workspaceId: string;
  channelAccountId: string;
  externalMessageId: string;
  contactRef?: string | null;
  eventType: string;
  payload: unknown;
  payloadSha256: string;
  normalizedMessage: unknown;
}) {
  const externalMessageId = cleanString(input.externalMessageId);
  const contactRef = cleanString(input.contactRef) || null;
  const eventType = cleanString(input.eventType);
  const serializedPayload = JSON.stringify(input.payload ?? {});
  const serializedMessage = JSON.stringify(input.normalizedMessage ?? {});
  if (
    !canPersist() ||
    !isUuid(input.actorUserId) ||
    !isUuid(input.workspaceId) ||
    !isUuid(input.channelAccountId) ||
    !/^evt_[0-9a-f]{64}$/u.test(externalMessageId) ||
    !eventType ||
    eventType.length > 100 ||
    (contactRef?.length ?? 0) > 512 ||
    serializedPayload.length > 65_536 ||
    serializedMessage.length > 65_536 ||
    !/^[0-9a-f]{64}$/u.test(input.payloadSha256)
  ) return null;

  const leaseToken = randomUUID();
  const params: unknown[] = [input.channelAccountId, input.workspaceId];
  const externalSql = addParam(params, externalMessageId);
  const contactSql = addParam(params, contactRef);
  const eventSql = addParam(params, eventType);
  const payloadSql = addParam(params, serializedPayload);
  const normalizedSql = addParam(params, serializedMessage);
  const payloadShaSql = addParam(params, input.payloadSha256);
  const leaseTokenSql = addParam(params, leaseToken);
  const leaseSecondsSql = addParam(params, botWebhookLeaseSeconds);

  type WebhookClaimRow = {
    id: string;
    leaseToken: string;
    processingAttempt: number;
    processingResult: unknown;
    replyResult: unknown;
    replyState: string;
    status: string;
  };
  type ExistingWebhookRow = {
    id: string;
    leaseExpiresAt: string | Date | null;
    payloadSha256: string | null;
    processingAttempt: number;
    processingResult: unknown;
    replyResult: unknown;
    replyState: string;
    status: string;
  };
  const claimSql = `
      insert into bot_channel_webhooks (
        workspace_id, channel_account_id, channel, external_message_id, contact_ref,
        event_type, payload, normalized_message, status, payload_sha256,
        processing_attempt, lease_token, lease_expires_at
      )
      select
        bca.workspace_id, bca.id, bca.channel, ${externalSql}, ${contactSql},
        ${eventSql}, ${payloadSql}::jsonb, ${normalizedSql}::jsonb, 'processing', ${payloadShaSql},
        1, ${leaseTokenSql}::uuid, now() + (${leaseSecondsSql}::integer * interval '1 second')
      from bot_channel_accounts bca
      where bca.id = $1::uuid
        and bca.workspace_id = $2::uuid
        and bca.active = true
        and bca.setup_status in ('ready', 'connected')
      on conflict (channel_account_id, external_message_id)
        where channel_account_id is not null and external_message_id is not null
        do update set
          status = 'processing',
          payload_sha256 = coalesce(bot_channel_webhooks.payload_sha256, excluded.payload_sha256),
          processing_attempt = bot_channel_webhooks.processing_attempt + 1,
          lease_token = excluded.lease_token,
          lease_expires_at = excluded.lease_expires_at,
          last_error = null,
          reply_state = case
            when bot_channel_webhooks.reply_state = 'attempting' then 'uncertain'
            else bot_channel_webhooks.reply_state
          end,
          reply_completed_at = case
            when bot_channel_webhooks.reply_state = 'attempting' then now()
            else bot_channel_webhooks.reply_completed_at
          end,
          reply_result = case
            when bot_channel_webhooks.reply_state = 'attempting'
              then coalesce(bot_channel_webhooks.reply_result, '{}'::jsonb)
                || jsonb_build_object('reconciliationReason', 'interrupted_provider_attempt')
            else bot_channel_webhooks.reply_result
          end
        where coalesce(bot_channel_webhooks.payload_sha256, excluded.payload_sha256) = excluded.payload_sha256
          and (
            bot_channel_webhooks.status in ('received', 'failed')
            or (
              bot_channel_webhooks.status = 'processing'
              and bot_channel_webhooks.lease_expires_at <= now()
            )
          )
      returning
        id,
        lease_token as "leaseToken",
        processing_attempt as "processingAttempt",
        processing_result as "processingResult",
        reply_result as "replyResult",
        reply_state as "replyState",
        status
  `;
  const existingSql = `
      select
        id,
        lease_expires_at as "leaseExpiresAt",
        payload_sha256 as "payloadSha256",
        processing_attempt as "processingAttempt",
        processing_result as "processingResult",
        reply_result as "replyResult",
        reply_state as "replyState",
        status
      from bot_channel_webhooks
      where workspace_id = $1::uuid
        and channel_account_id = $2::uuid
        and external_message_id = $3
      order by received_at asc
      limit 1
  `;

  return withTenantTransaction(
    { actorId: input.actorUserId, workspaceId: input.workspaceId },
    async (transaction) => {
      // Account and contact locks are always acquired in lexical order. The
      // account lock serializes every new event for its provider account; the
      // contact lock documents and preserves the narrower budget boundary.
      const budgetLockKeys = [
        `bot_webhook_account:${input.workspaceId}:${input.channelAccountId}`,
        `bot_webhook_contact:${input.workspaceId}:${input.channelAccountId}:${contactRef ?? "anonymous"}`,
      ].sort();
      for (const lockKey of budgetLockKeys) {
        await transaction.queryOne<{ locked: boolean }>(
          `select pg_advisory_xact_lock(hashtextextended($1, 0)) is null as locked`,
          [lockKey],
        );
      }

      const row = await transaction.queryOne<WebhookClaimRow>(claimSql, params);
      if (row) {
        if (input.applyRateBudget && Number(row.processingAttempt) === 1) {
          const counts = await transaction.queryOne<{
            accountEventCount: number | string;
            contactEventCount: number | string;
          }>(
            `
              select
                count(*)::integer as "accountEventCount",
                count(*) filter (where contact_ref = $3)::integer as "contactEventCount"
              from bot_channel_webhooks
              where workspace_id = $1::uuid
                and channel_account_id = $2::uuid
                and received_at >= now() - ($4::integer * interval '1 minute')
                and coalesce(normalized_message->>'text', '') <> ''
            `,
            [input.workspaceId, input.channelAccountId, contactRef, botWebhookRateWindowMinutes],
          );
          if (!counts) throw new Error("Bot webhook rate budget could not be read");
          const budget = evaluateBotWebhookBudget({
            accountEventCount: Number(counts.accountEventCount),
            contactEventCount: Number(counts.contactEventCount),
          });
          if (!budget.allowed) {
            const ignored = await transaction.queryOne<IdRow>(
              `
                update bot_channel_webhooks
                set status = 'ignored',
                    processing_result = jsonb_build_object('reason', $4),
                    completed_at = now(),
                    lease_token = null,
                    lease_expires_at = null,
                    quarantine_reason = $4,
                    quarantined_at = now(),
                    reply_state = 'not_applicable',
                    reply_completed_at = now(),
                    reply_result = jsonb_build_object('reason', $4)
                where workspace_id = $1::uuid
                  and id = $2::uuid
                  and status = 'processing'
                  and lease_token = $3::uuid
                returning id
              `,
              [input.workspaceId, row.id, row.leaseToken, budget.reason],
            );
            if (!ignored) throw new Error("Bot webhook rate limit could not be settled");
            return {
              id: row.id,
              outcome: "ignored" as const,
              processingAttempt: Number(row.processingAttempt),
              processingResult: { reason: budget.reason },
              quarantineReason: budget.reason,
              replyResult: { reason: budget.reason },
              replyState: "not_applicable",
            };
          }
        }

        return {
          id: row.id,
          leaseToken: row.leaseToken,
          outcome: "claimed" as const,
          processingAttempt: Number(row.processingAttempt),
          processingResult: row.processingResult,
          replyResult: row.replyResult,
          replyState: row.replyState,
        };
      }

      const existing = await transaction.queryOne<ExistingWebhookRow>(
        existingSql,
        [input.workspaceId, input.channelAccountId, externalMessageId],
      );
      if (!existing) return null;
      if (existing.payloadSha256 && existing.payloadSha256 !== input.payloadSha256) {
        return {
          id: existing.id,
          outcome: "payload_conflict" as const,
          processingAttempt: Number(existing.processingAttempt),
          processingResult: existing.processingResult,
          replyResult: existing.replyResult,
          replyState: existing.replyState,
        };
      }
      const outcome = existing.status === "completed"
        ? "completed"
        : existing.status === "ignored"
          ? "ignored"
          : "in_flight";

      return {
        id: existing.id,
        leaseExpiresAt: existing.leaseExpiresAt,
        outcome,
        processingAttempt: Number(existing.processingAttempt),
        processingResult: existing.processingResult,
        replyResult: existing.replyResult,
        replyState: existing.replyState,
      };
    },
  );
}

export async function quarantineBotChannelWebhookPayloadConflict(input: {
  id: string;
  workspaceId: string;
}) {
  if (!canPersist() || !isUuid(input.workspaceId) || !isUuid(input.id)) return false;

  const row = await queryOne<IdRow>(
    `
      update bot_channel_webhooks
      set quarantine_reason = 'payload_conflict',
          quarantined_at = coalesce(quarantined_at, now()),
          conflict_count = conflict_count + 1,
          last_error = 'payload_conflict_quarantined'
      where workspace_id = $1::uuid
        and id = $2::uuid
      returning id
    `,
    [input.workspaceId, input.id],
  );

  return Boolean(row);
}

export async function quarantineBotChannelWebhookEnvelope(input: {
  eventCount: number;
  payloadSha256: string;
  provider: "custom" | "meta" | "unknown";
  reason: "batch_event_limit_exceeded";
}) {
  const reason = cleanString(input.reason);
  if (
    !canPersist()
    || !/^[0-9a-f]{64}$/u.test(input.payloadSha256)
    || !["custom", "meta", "unknown"].includes(input.provider)
    || !Number.isSafeInteger(input.eventCount)
    || input.eventCount < 1
    || input.eventCount > 100_000
    || !reason
    || reason.length > 100
  ) return null;

  return queryOne<IdRow>(
    `
      select public.quarantine_bot_channel_webhook_envelope(
        $1, $2, $3, $4
      ) as id
    `,
    [input.payloadSha256, input.provider, input.eventCount, reason],
  );
}

export async function persistBotChannelWebhookProcessingResult(input: {
  id: string;
  leaseToken: string;
  processingResult: unknown;
  workspaceId: string;
}) {
  if (!canPersist() || !isUuid(input.workspaceId) || !isUuid(input.id) || !isUuid(input.leaseToken)) return false;

  const row = await queryOne<IdRow>(
    `
      update bot_channel_webhooks
      set processing_result = $4::jsonb
      where workspace_id = $1::uuid
        and id = $2::uuid
        and status = 'processing'
        and lease_token = $3::uuid
      returning id
    `,
    [input.workspaceId, input.id, input.leaseToken, JSON.stringify(input.processingResult ?? null)],
  );

  return Boolean(row);
}

export async function ignoreBotChannelWebhook(input: {
  id: string;
  leaseToken: string;
  processingResult?: unknown;
  reason?: string;
  workspaceId: string;
}) {
  if (!canPersist() || !isUuid(input.workspaceId) || !isUuid(input.id) || !isUuid(input.leaseToken)) return false;
  const reason = cleanString(input.reason) || "no_processable_text";
  if (reason.length > 100) return false;

  const row = await queryOne<IdRow>(
    `
      update bot_channel_webhooks
      set status = 'ignored',
          processing_result = $4::jsonb,
          completed_at = now(),
          last_error = null,
          lease_token = null,
          lease_expires_at = null,
          quarantine_reason = case
            when $5 = 'no_processable_text' then quarantine_reason
            else $5
          end,
          quarantined_at = case
            when $5 = 'no_processable_text' then quarantined_at
            else coalesce(quarantined_at, now())
          end,
          reply_state = case
            when reply_state = 'attempting' then 'uncertain'
            when reply_state = 'not_requested' then 'not_applicable'
            else reply_state
          end,
          reply_completed_at = case
            when reply_state in ('attempting', 'not_requested') then now()
            else reply_completed_at
          end,
          reply_result = case
            when reply_state in ('attempting', 'not_requested')
              then coalesce(reply_result, '{}'::jsonb) || jsonb_build_object('reason', $5)
            else reply_result
          end
      where workspace_id = $1::uuid
        and id = $2::uuid
        and status = 'processing'
        and lease_token = $3::uuid
      returning id
    `,
    [input.workspaceId, input.id, input.leaseToken, JSON.stringify(input.processingResult ?? null), reason],
  );

  return Boolean(row);
}

export async function beginBotChannelWebhookReplyAttempt(input: {
  id: string;
  leaseToken: string;
  workspaceId: string;
}) {
  if (!canPersist() || !isUuid(input.workspaceId) || !isUuid(input.id) || !isUuid(input.leaseToken)) return null;

  const replyAttemptToken = randomUUID();
  const row = await queryOne<{
    replyAttemptToken: string | null;
    replyResult: unknown;
    replyState: string;
  }>(
    `
      update bot_channel_webhooks
      set reply_state = 'attempting',
          reply_attempt_token = $4::uuid,
          reply_attempted_at = now(),
          reply_completed_at = null,
          reply_result = null
      where workspace_id = $1::uuid
        and id = $2::uuid
        and status = 'processing'
        and lease_token = $3::uuid
        and reply_state = 'not_requested'
      returning
        reply_attempt_token as "replyAttemptToken",
        reply_result as "replyResult",
        reply_state as "replyState"
    `,
    [input.workspaceId, input.id, input.leaseToken, replyAttemptToken],
  );

  if (row) return row;

  return queryOne<{
    replyAttemptToken: string | null;
    replyResult: unknown;
    replyState: string;
  }>(
    `
      select
        reply_attempt_token as "replyAttemptToken",
        reply_result as "replyResult",
        reply_state as "replyState"
      from bot_channel_webhooks
      where workspace_id = $1::uuid
        and id = $2::uuid
        and status = 'processing'
        and lease_token = $3::uuid
      limit 1
    `,
    [input.workspaceId, input.id, input.leaseToken],
  );
}

export async function settleBotChannelWebhookReply(input: {
  id: string;
  leaseToken: string;
  replyAttemptToken: string;
  replyResult: unknown;
  replyState: "blocked" | "completed" | "uncertain";
  workspaceId: string;
}) {
  if (
    !canPersist() ||
    !isUuid(input.workspaceId) ||
    !isUuid(input.id) ||
    !isUuid(input.leaseToken) ||
    !isUuid(input.replyAttemptToken)
  ) return false;

  const row = await queryOne<IdRow>(
    `
      update bot_channel_webhooks
      set reply_state = $5,
          reply_result = $6::jsonb,
          reply_completed_at = now()
      where workspace_id = $1::uuid
        and id = $2::uuid
        and status = 'processing'
        and lease_token = $3::uuid
        and reply_attempt_token = $4::uuid
        and reply_state = 'attempting'
      returning id
    `,
    [
      input.workspaceId,
      input.id,
      input.leaseToken,
      input.replyAttemptToken,
      input.replyState,
      JSON.stringify(input.replyResult ?? null),
    ],
  );

  return Boolean(row);
}

export async function settleBotChannelWebhookReplyWithoutAttempt(input: {
  id: string;
  leaseToken: string;
  replyResult: unknown;
  replyState: "blocked" | "not_applicable";
  workspaceId: string;
}) {
  if (!canPersist() || !isUuid(input.workspaceId) || !isUuid(input.id) || !isUuid(input.leaseToken)) return false;

  const row = await queryOne<IdRow>(
    `
      update bot_channel_webhooks
      set reply_state = $4,
          reply_result = $5::jsonb,
          reply_completed_at = now()
      where workspace_id = $1::uuid
        and id = $2::uuid
        and status = 'processing'
        and lease_token = $3::uuid
        and reply_state = 'not_requested'
      returning id
    `,
    [input.workspaceId, input.id, input.leaseToken, input.replyState, JSON.stringify(input.replyResult ?? null)],
  );

  return Boolean(row);
}

export async function completeBotChannelWebhook(input: {
  id: string;
  leaseToken: string;
  workspaceId: string;
}) {
  if (!canPersist() || !isUuid(input.workspaceId) || !isUuid(input.id) || !isUuid(input.leaseToken)) return false;

  const row = await queryOne<IdRow>(
    `
      update bot_channel_webhooks
      set status = 'completed',
          completed_at = now(),
          last_error = null,
          lease_token = null,
          lease_expires_at = null
      where workspace_id = $1::uuid
        and id = $2::uuid
        and status = 'processing'
        and lease_token = $3::uuid
        and processing_result is not null
        and reply_state in ('completed', 'blocked', 'not_applicable', 'uncertain')
      returning id
    `,
    [input.workspaceId, input.id, input.leaseToken],
  );

  return Boolean(row);
}

export async function failBotChannelWebhook(input: {
  id: string;
  leaseToken: string;
  reason: string;
  workspaceId: string;
}) {
  if (!canPersist() || !isUuid(input.workspaceId) || !isUuid(input.id) || !isUuid(input.leaseToken)) return false;

  const row = await queryOne<IdRow>(
    `
      update bot_channel_webhooks
      set status = 'failed',
          last_error = left($4, 160),
          lease_token = null,
          lease_expires_at = null,
          reply_state = case when reply_state = 'attempting' then 'uncertain' else reply_state end,
          reply_completed_at = case when reply_state = 'attempting' then now() else reply_completed_at end,
          reply_result = case
            when reply_state = 'attempting'
              then coalesce(reply_result, '{}'::jsonb)
                || jsonb_build_object('reconciliationReason', 'processing_failed_after_attempt_started')
            else reply_result
          end
      where workspace_id = $1::uuid
        and id = $2::uuid
        and status = 'processing'
        and lease_token = $3::uuid
      returning id
    `,
    [input.workspaceId, input.id, input.leaseToken, input.reason],
  );

  return Boolean(row);
}

export async function findBotChannelWebhookRunRecovery(input: {
  id: string;
  session: AppSession;
}) {
  if (
    !canPersist()
    || !isUuid(input.session.workspaceId)
    || !isUuid(input.session.userId)
    || !isUuid(input.id)
  ) return null;

  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const recovery = await transaction.queryOne<{
        conversationId: string;
        messageContent: string;
        messageId: string;
        messageMetadata: unknown;
        messageModel: string | null;
      }>(
        `
          select
            conversation.id as "conversationId",
            message.content as "messageContent",
            message.id as "messageId",
            message.metadata as "messageMetadata",
            message.model as "messageModel"
          from bot_conversations conversation
          join bot_messages message
            on message.workspace_id = conversation.workspace_id
            and message.conversation_id = conversation.id
            and message.webhook_event_id = conversation.webhook_event_id
            and message.role = 'assistant'
          where conversation.workspace_id = $1::uuid
            and conversation.webhook_event_id = $2::uuid
          limit 1
        `,
        [input.session.workspaceId, input.id],
      );
      if (!recovery) return null;

      const reconciled = await recordFirstResponseAnalyticsEvent({
        conversationId: recovery.conversationId,
        messageId: recovery.messageId,
        metadata: recovery.messageMetadata,
        model: recovery.messageModel,
        session: input.session,
        transaction,
      });
      if (!reconciled) throw new Error("Bot webhook first-response recovery could not be reconciled");

      return {
        conversationId: recovery.conversationId,
        messageContent: recovery.messageContent,
        messageMetadata: recovery.messageMetadata,
      };
    },
  );
}

export async function listBotChannelWebhookEvents(input: {
  session: AppSession;
  limit?: number;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return [];

  return queryRows<{
    id: string;
    channel: string;
    completedAt: string | Date | null;
    externalMessageId: string | null;
    contactRef: string | null;
    eventType: string;
    leaseExpiresAt: string | Date | null;
    normalizedMessage: unknown;
    processingAttempt: number;
    replyAttemptedAt: string | Date | null;
    replyCompletedAt: string | Date | null;
    replyState: string;
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
        processing_attempt as "processingAttempt",
        lease_expires_at as "leaseExpiresAt",
        completed_at as "completedAt",
        reply_state as "replyState",
        reply_attempted_at as "replyAttemptedAt",
        reply_completed_at as "replyCompletedAt",
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

type BotMessageInsertInput = {
  session: AppSession;
  conversationId?: string | null;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolName?: string | null;
  toolCallId?: string | null;
  model?: string | null;
  metadata?: unknown;
  webhookEventId?: string | null;
};

async function persistBotMessage(input: BotMessageInsertInput, transaction?: TenantTransaction) {
  const insertSql = `
    insert into bot_messages (
      workspace_id, conversation_id, role, content, tool_name, tool_call_id, model, metadata,
      webhook_event_id
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid)
    on conflict (workspace_id, webhook_event_id, role)
      where webhook_event_id is not null
      do nothing
    returning id
  `;
  const insertParams = [
    input.session.workspaceId,
    input.conversationId,
    input.role,
    input.content,
    input.toolName ?? null,
    input.toolCallId ?? null,
    input.model ?? null,
    JSON.stringify(input.metadata ?? {}),
    isUuid(input.webhookEventId) ? input.webhookEventId : null,
  ];
  const row = transaction
    ? await transaction.queryOne<IdRow>(insertSql, insertParams)
    : await queryOne<IdRow>(insertSql, insertParams);

  const existingSql = `
    select id
    from bot_messages
    where workspace_id = $1::uuid
      and webhook_event_id = $2::uuid
      and role = $3
    limit 1
  `;
  const existingParams = [input.session.workspaceId, input.webhookEventId, input.role];
  const persistedRow = row ?? (isUuid(input.webhookEventId)
    ? transaction
      ? await transaction.queryOne<IdRow>(existingSql, existingParams)
      : await queryOne<IdRow>(existingSql, existingParams)
    : null);

  const updateSql = `
    update bot_conversations
    set updated_at = now()
    where id = $1 and workspace_id = $2
    returning id
  `;
  if (transaction) {
    await transaction.queryOne<IdRow>(updateSql, [input.conversationId, input.session.workspaceId]);
  } else {
    await queryOne<IdRow>(updateSql, [input.conversationId, input.session.workspaceId]);
  }

  if (persistedRow?.id && input.role === "assistant") {
    const reconciled = await recordFirstResponseAnalyticsEvent({
      conversationId: input.conversationId as string,
      messageId: persistedRow.id,
      metadata: input.metadata,
      model: input.model,
      session: input.session,
      transaction,
    });
    if (transaction && !reconciled) throw new Error("Bot first-response effects could not be persisted");
  }

  return row?.id ?? null;
}

export async function insertBotMessage(input: BotMessageInsertInput) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.conversationId)) return null;

  if (input.role === "assistant" && isUuid(input.webhookEventId) && isUuid(input.session.userId)) {
    // For webhook runs the assistant row is the recovery marker. Commit it
    // together with first_response analytics and speed-to-lead so a transient
    // failure cannot leave a marker that falsely claims derived effects exist.
    return withTenantTransaction(
      { actorId: input.session.userId, workspaceId: input.session.workspaceId },
      (transaction) => persistBotMessage(input, transaction),
    );
  }

  return persistBotMessage(input);
}

async function recordFirstResponseAnalyticsEvent(input: {
  conversationId: string;
  messageId: string;
  metadata?: unknown;
  model?: string | null;
  session: AppSession;
  transaction?: TenantTransaction;
}) {
  type ConversationRow = {
    botId: string | null;
    contactId: string | null;
    leadId: string | null;
    metadata: unknown;
    projectId: string | null;
  };
  const conversationSql = `
    select
      bot_id as "botId",
      contact_id as "contactId",
      lead_id as "leadId",
      metadata,
      project_id as "projectId"
    from bot_conversations
    where id = $1 and workspace_id = $2
    limit 1
  `;
  const conversationParams = [input.conversationId, input.session.workspaceId];
  const conversation = input.transaction
    ? await input.transaction.queryOne<ConversationRow>(conversationSql, conversationParams)
    : await queryOne<ConversationRow>(conversationSql, conversationParams);

  if (!conversation) return null;

  if (input.transaction) {
    // The duplicate query below treats either a shared Contact or a shared
    // Lead as the same first-response entity. Acquire every available entity
    // lock in one global order so the lock equivalence matches that OR query.
    const firstResponseScopeKeys = [
      conversation.contactId ? `contact:${conversation.contactId}` : null,
      conversation.leadId ? `lead:${conversation.leadId}` : null,
    ].filter((value): value is string => Boolean(value));
    if (!firstResponseScopeKeys.length) {
      firstResponseScopeKeys.push(`conversation:${input.conversationId}`);
    }
    firstResponseScopeKeys.sort();
    for (const firstResponseScope of firstResponseScopeKeys) {
      await input.transaction.queryOne<{ locked: boolean }>(
        `select pg_advisory_xact_lock(hashtextextended($1, 0)) is null as locked`,
        [`bot_first_response:${input.session.workspaceId}:${firstResponseScope}`],
      );
    }
  }

  type FirstResponseRow = IdRow & { occurredAt: string | Date };
  const exactAnalyticsSql = `
    select id, occurred_at as "occurredAt"
    from analytics_events
    where workspace_id = $1
      and event_type = 'first_response'
      and metadata->>'conversationId' = $2
    order by occurred_at asc
    limit 1
  `;
  const exactAnalyticsParams = [input.session.workspaceId, input.conversationId];
  const exactAnalytics = input.transaction
    ? await input.transaction.queryOne<FirstResponseRow>(exactAnalyticsSql, exactAnalyticsParams)
    : await queryOne<FirstResponseRow>(exactAnalyticsSql, exactAnalyticsParams);

  if (!exactAnalytics) {
    const priorEntityAnalyticsSql = `
      select id, occurred_at as "occurredAt"
      from analytics_events
      where workspace_id = $1
        and event_type = 'first_response'
        and (
          ($2::uuid is not null and lead_id = $2::uuid)
          or ($3::uuid is not null and contact_id = $3::uuid)
        )
      order by occurred_at asc
      limit 1
    `;
    const priorEntityAnalyticsParams = [input.session.workspaceId, conversation.leadId, conversation.contactId];
    const priorEntityAnalytics = input.transaction
      ? await input.transaction.queryOne<FirstResponseRow>(priorEntityAnalyticsSql, priorEntityAnalyticsParams)
      : await queryOne<FirstResponseRow>(priorEntityAnalyticsSql, priorEntityAnalyticsParams);
    if (priorEntityAnalytics) return priorEntityAnalytics.id;
  }

  const conversationMetadata = asPlainObject(conversation.metadata);
  const messageMetadata = asPlainObject(input.metadata);
  const channel = cleanString(messageMetadata.channel as string)
    || cleanString(conversationMetadata.channel as string)
    || cleanString(conversationMetadata.source as string)
    || "bot";
  const entityId = conversation.leadId ?? conversation.contactId ?? input.messageId;
  const entityType = conversation.leadId ? "lead" : conversation.contactId ? "contact" : "bot_message";
  const firstResponseAt = exactAnalytics
    ? exactAnalytics.occurredAt instanceof Date
      ? exactAnalytics.occurredAt.toISOString()
      : String(exactAnalytics.occurredAt)
    : new Date().toISOString();

  const analyticsEventId = exactAnalytics?.id ?? await writeCrmAnalyticsEvent({
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
      occurredAt: firstResponseAt,
      projectId: conversation.projectId,
      source: channel,
      transaction: input.transaction,
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    });
  if (!analyticsEventId) return null;

  const speedEventSql = `
    select id
    from speed_to_lead_events
    where workspace_id = $1
      and metadata->>'conversationId' = $2
      and metadata->>'sourcePayload' = 'bot_first_response'
    order by created_at asc
    limit 1
  `;
  const speedEventParams = [input.session.workspaceId, input.conversationId];
  const existingSpeedEvent = input.transaction
    ? await input.transaction.queryOne<IdRow>(speedEventSql, speedEventParams)
    : await queryOne<IdRow>(speedEventSql, speedEventParams);

  if (!existingSpeedEvent) {
    const speedEventId = await recordSpeedToLeadEvent({
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
      transaction: input.transaction,
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    });
    if (input.transaction && !speedEventId) throw new Error("Bot speed-to-lead effect could not be persisted");
  }

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
  webhookEventId?: string | null;
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
  const webhookEventSql = addUuidParam(params, input.webhookEventId);

  const row = await queryOne<IdRow>(
    `
      insert into bot_tool_calls (
        workspace_id, conversation_id, bot_id, tool_name, risk_level, input, output, status, requires_approval, error,
        webhook_event_id
      )
      values (
        $1, ${conversationSql}, ${botSql}, ${toolSql}, ${riskSql}, ${inputSql}::jsonb,
        ${outputSql}::jsonb, ${statusSql}, ${approvalSql}, ${errorSql},
        ${webhookEventSql}
      )
      on conflict (workspace_id, webhook_event_id, tool_name)
        where webhook_event_id is not null
        do nothing
      returning id
    `,
    params,
  );

  if (row?.id) return row.id;
  if (!isUuid(input.webhookEventId)) return null;

  const existing = await queryOne<IdRow>(
    `
      select id
      from bot_tool_calls
      where workspace_id = $1::uuid
        and webhook_event_id = $2::uuid
        and tool_name = $3
      limit 1
    `,
    [input.session.workspaceId, input.webhookEventId, input.toolName],
  );

  return existing?.id ?? null;
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
  webhookEventId?: string | null;
}) {
  if (
    ["queued", "sending", "sent"].includes(input.status) &&
    !evaluateLaunchScope("customerCommunicationProviderMutation").allowed
  ) {
    return null;
  }
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
  const webhookEventSql = addUuidParam(params, input.webhookEventId);

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
        sent_at,
        webhook_event_id
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
        ${sentAtSql}::timestamptz,
        ${webhookEventSql}
      )
      on conflict (workspace_id, webhook_event_id)
        where webhook_event_id is not null
        do nothing
      returning id
    `,
    params,
  );

  if (row?.id) return row.id;
  if (!isUuid(input.webhookEventId)) return null;

  const existing = await queryOne<IdRow>(
    `
      select id
      from bot_document_sends
      where workspace_id = $1::uuid
        and webhook_event_id = $2::uuid
      limit 1
    `,
    [input.session.workspaceId, input.webhookEventId],
  );

  return existing?.id ?? null;
}

export async function updateBotDocumentSendDelivery(input: {
  session: AppSession;
  documentSendId?: string | null;
  status: string;
  metadata?: unknown;
  sentAt?: string | null;
}) {
  if (
    ["queued", "sending", "sent"].includes(input.status) &&
    !evaluateLaunchScope("customerCommunicationProviderMutation").allowed
  ) {
    return null;
  }
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
  deliveryPurpose: "bot_document" | "meeting_qa_test" | "newsletter";
  provider: string;
  providerMessageId?: string | null;
  toEmail: string;
  subject: string;
  status: "queued" | "sent" | "delivered" | "bounced" | "complained" | "suppressed" | "failed";
  error?: string | null;
  metadata?: unknown;
  sentAt?: string | null;
}) {
  const deliveryLaunchEnabled = input.deliveryPurpose === "newsletter"
    ? evaluateLaunchScope("newsletterDelivery").allowed
    : evaluateLaunchScope("customerCommunicationProviderMutation").allowed;
  if (
    ["queued", "sent", "delivered"].includes(input.status) &&
    !deliveryLaunchEnabled
  ) {
    return null;
  }
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
  email: string;
  tokenId: string;
  workspaceId: string;
}) {
  const email = normalizeEmailForStorage(input.email);

  if (
    !canPersist() ||
    !isUuid(input.workspaceId) ||
    !email ||
    !/^[A-Za-z0-9_-]{32}$/u.test(input.tokenId)
  ) {
    return {
      contactIds: [] as string[],
      persisted: false,
      reason: !canPersist() ? "database_unavailable" : "invalid_request",
      suppressionId: null as string | null,
    };
  }

  const campaignId = isUuid(input.campaignId) ? input.campaignId : null;
  const result = await queryOne<{
    contactIds: string[];
    suppressionId: string;
  }>(
    `
      with lock_scope as (
        select pg_advisory_xact_lock(hashtextextended($1::text || ':' || lower($2), 0))
      ), valid_campaign as (
        select id
        from newsletter_campaigns
        where workspace_id = $1 and id = $3::uuid
        limit 1
      ), upserted_suppression as (
        insert into newsletter_suppressions (
          workspace_id, campaign_id, email, reason, source, metadata
        )
        select
          $1,
          (select id from valid_campaign),
          $2,
          'unsubscribe',
          'signed_newsletter_unsubscribe',
          jsonb_build_object('unsubscribeTokenId', $4::text)
        from lock_scope
        on conflict (workspace_id, lower(email)) do update
        set
          campaign_id = coalesce(excluded.campaign_id, newsletter_suppressions.campaign_id),
          reason = 'unsubscribe',
          source = excluded.source,
          metadata = newsletter_suppressions.metadata || excluded.metadata,
          captured_at = case
            when newsletter_suppressions.metadata->>'unsubscribeTokenId' = $4 then newsletter_suppressions.captured_at
            else now()
          end
        returning id
      ), matched_contacts as (
        select c.id, c.project_id as "projectId"
        from contacts c
        cross join lock_scope
        where c.workspace_id = $1 and lower(c.email) = lower($2)
        limit 50
      ), latest_consent as (
        select
          matched_contacts.id as "contactId",
          latest.status
        from matched_contacts
        left join lateral (
          select cr.status
          from consent_records cr
          where cr.workspace_id = $1
            and cr.contact_id = matched_contacts.id
            and cr.channel = 'Newsletter'
          order by cr.captured_at desc, cr.id desc
          limit 1
        ) latest on true
      ), updated_contacts as (
        update contacts c
        set consent_label = 'Abgemeldet', updated_at = now()
        from matched_contacts
        where c.id = matched_contacts.id
          and c.workspace_id = $1
          and c.consent_label is distinct from 'Abgemeldet'
        returning c.id
      ), inserted_consents as (
        insert into consent_records (
          workspace_id, contact_id, project_id, channel, status, source, metadata
        )
        select
          $1,
          matched_contacts.id,
          matched_contacts."projectId",
          'Newsletter',
          'Abgemeldet',
          'signed_newsletter_unsubscribe',
          jsonb_build_object(
            'campaignId', (select id from valid_campaign),
            'trigger', 'confirmed_unsubscribe',
            'unsubscribeTokenId', $4::text
          )
        from matched_contacts
        left join latest_consent on latest_consent."contactId" = matched_contacts.id
        where coalesce(latest_consent.status, '') !~* '(abgemeldet|opt.?out|unsubscribe|unsubscribed)'
        returning contact_id
      )
      select
        upserted_suppression.id as "suppressionId",
        coalesce(
          (select array_agg(matched_contacts.id order by matched_contacts.id) from matched_contacts),
          array[]::uuid[]
        ) as "contactIds"
      from upserted_suppression
    `,
    [input.workspaceId, email, campaignId, input.tokenId],
  );

  return {
    contactIds: result?.contactIds ?? [],
    persisted: Boolean(result?.suppressionId),
    reason: result ? null : "database_unavailable",
    suppressionId: result?.suppressionId ?? null,
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
