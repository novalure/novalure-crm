import type { AppSession } from "@/lib/auth/session";
import type { BotEvaluationCaseResult, BotEvaluationRun } from "@/lib/crm-types";
import { writeCrmAnalyticsEvent } from "@/lib/db/analytics-event-repositories";
import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { recordSpeedToLeadEvent } from "@/lib/db/speed-to-lead-repositories";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import type { FunnelBlueprint, FunnelSubmissionPayload } from "@/lib/funnel-schema";
import { resolveCanonicalFunnelSubmissionSemantics } from "@/lib/funnel-submission-validation";
import { decryptSecret, encryptSecret } from "@/lib/integrations/secret-box";
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
type FunnelSubmissionPersistenceRow = {
  contactId: string;
  dealId: string | null;
  leadId: string | null;
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
  session: AppSession;
  blueprint: FunnelBlueprint;
  payload: FunnelSubmissionPayload;
  score: number;
  submissionIdempotencyHash: string;
}): Promise<PersistenceResult> {
  if (!canPersist()) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }
  if (
    !isUuid(input.session.workspaceId) ||
    !isUuid(input.session.userId) ||
    !isUuid(input.databaseFunnelId) ||
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
      with selected_funnel as (
        select
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          owner_user_id as "ownerUserId",
          name
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
        (select id from inserted_timeline limit 1) as "timelineItemId"
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
        (select id from existing_timeline limit 1)
      from existing_submission existing
      where existing."contactId" is not null
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
        ],
      );
    },
  );

  if (row && "identityConflict" in row) {
    return { persisted: false, reason: "Funnel contact identity conflict" };
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
  const ownerUserId = isUuid(input.session.userId) ? input.session.userId : null;
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
          where workspace_id = $1 and id = $2
          returning id
        `,
        [
          input.session.workspaceId,
          existingContact.id,
          ownerUserId,
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
            workspace_id, project_id, owner_user_id, name, role, source, intent, consent_label, email, phone, metadata
          )
          values ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, nullif($9, ''), nullif($10, ''), $11::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          isUuid(input.projectId) ? input.projectId : null,
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
  if (!canPersist()) return { account: null, status: "unavailable" as const };
  if (!accountRef) return { account: null, status: "not_found" as const };

  const rows = await queryRows<{
    id: string;
    workspaceId: string;
    workspaceName: string | null;
    channel: string;
    externalAccountId: string;
    provider: string;
    metadata: unknown;
  }>(
    `
      select
        bca.id,
        bca.workspace_id as "workspaceId",
        w.name as "workspaceName",
        bca.channel,
        bca.external_account_id as "externalAccountId",
        bca.provider,
        bca.metadata
      from bot_channel_accounts bca
      left join workspaces w on w.id = bca.workspace_id
      where bca.active = true
        and bca.setup_status in ('ready', 'connected')
        and bca.workspace_id is not null
        and lower(bca.channel) = lower($1)
        and bca.external_account_id = $2
      order by bca.updated_at desc
      limit 2
    `,
    [input.channel, accountRef],
  );

  if (rows.length === 0) return { account: null, status: "not_found" as const };
  if (rows.length !== 1) return { account: null, status: "ambiguous" as const };

  const row = rows[0];
  if (!row || !isUuid(row.workspaceId)) return { account: null, status: "not_found" as const };

  return {
    account: {
      ...row,
      credentials: decryptBotChannelCredentials(row.metadata),
    },
    status: "matched" as const,
  };
}

export async function insertBotChannelWebhook(input: {
  workspaceId: string;
  channelAccountId: string;
  externalMessageId: string;
  contactRef?: string | null;
  eventType: string;
  payload: unknown;
  normalizedMessage: unknown;
  status?: string;
}) {
  if (
    !canPersist() ||
    !isUuid(input.workspaceId) ||
    !isUuid(input.channelAccountId) ||
    !cleanString(input.externalMessageId)
  ) return null;

  const params: unknown[] = [input.channelAccountId, input.workspaceId];
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
      select
        bca.workspace_id, bca.id, bca.channel, ${externalSql}, ${contactSql},
        ${eventSql}, ${payloadSql}::jsonb, ${normalizedSql}::jsonb, ${statusSql}
      from bot_channel_accounts bca
      where bca.id = $1::uuid
        and bca.workspace_id = $2::uuid
        and bca.active = true
        and bca.setup_status in ('ready', 'connected')
      on conflict do nothing
      returning id, status
    `,
    params,
  );

  if (row) return { duplicate: false, id: row.id, status: row.status };

  const existing = await queryOne<{ id: string; status: string }>(
    `
      select id, status
      from bot_channel_webhooks
      where channel_account_id = $1::uuid
        and external_message_id = $2
      order by received_at asc
      limit 1
    `,
    [input.channelAccountId, input.externalMessageId],
  );

  return existing ? { duplicate: true, id: existing.id, status: existing.status } : null;
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
