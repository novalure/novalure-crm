import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { isUuid, writeAuditLog, type PersistenceResult } from "@/lib/db/runtime-repositories";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import { isTruthyPublicConsentValue } from "@/lib/form-consent";
import { validatePublicFormFieldValue } from "@/lib/form-submission-validation";
import { createFormField } from "@/lib/form-types";
import {
  buildPublicFormPath,
  parsePublicSlugLookup,
  type PublicSlugLookup,
} from "@/lib/public-routing";
import {
  getPublicFormLaunchBlockReason,
  isMarketingConsentField,
  isPrivacyConsentField,
} from "@/lib/public-form-dto";
import {
  parsePublicSubmissionResponseSnapshot,
  type PublicSubmissionResponseSnapshot,
} from "@/lib/security/public-submission-abuse";
import {
  buildPublicContactIdentityLocks,
  normalizePublicContactEmail,
  normalizePublicContactPhone,
  publicContactIdentityLockNamespace,
} from "@/lib/security/public-contact-identity";
import type {
  FormField,
  FormFieldType,
  FormStep,
  FormStatus,
  FormSubmissionSummary,
  FormTarget,
  FormTemplate,
  FormVariant,
  FormsRuntimePayload,
  WebsiteForm,
} from "@/lib/form-types";

type IdRow = { id: string };

function canonicalizeFormSaveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeFormSaveValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeFormSaveValue(nested)]),
    );
  }
  return value;
}

function hashFormSaveRequest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeFormSaveValue(value)))
    .digest("hex");
}

type FormRow = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  ownerUserId: string | null;
  funnelId: string | null;
  name: string;
  slug: string;
  status: string;
  variant: string;
  template: string;
  crmTarget: string;
  pipelineStage: string;
  ownerMode: string;
  campaign: string;
  tags: string[] | null;
  fields: unknown;
  actions: unknown;
  settings: unknown;
  visits: number | string;
  submissions: number | string;
  conversionRate: number | string;
  lastSubmission: string | Date | null;
  workspacePublicKey?: string | null;
  writeApplied?: boolean;
};

type PublicFormRow = FormRow & {
  workspaceName: string | null;
  funnelAudience: string | null;
  ownerActive: boolean;
};

type SubmissionRow = {
  id: string;
  formId: string;
  contactName: string | null;
  contactEmail: string | null;
  leadId: string | null;
  score: number | string;
  status: string;
  intent: string | null;
  nextAction: string | null;
  createdAt: string | Date;
};

type AtomicFormSubmissionRow = {
  contactId: string | null;
  dealId: string | null;
  invariant: number | string;
  leadId: string | null;
  persistenceState: "conflict" | "created" | "identity_conflict" | "replay";
  responsePayload: unknown;
  submissionId: string | null;
  taskId: string | null;
  timelineItemId: string | null;
};

export type WebsiteFormSubmissionPersistenceResult =
  | (Extract<PersistenceResult, { persisted: true }> & {
      form: WebsiteForm;
      redirectUrl: string;
      response: PublicSubmissionResponseSnapshot;
    })
  | (Extract<PersistenceResult, { persisted: false }> & { form?: WebsiteForm });

type FormLookup = {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  projectId: string | null;
  ownerUserId: string | null;
  ownerActive: boolean;
  funnelId: string | null;
  funnelAudience: string | null;
  form: WebsiteForm;
  publicPath: string | null;
};

type LegacyPublicFormRoute =
  | { status: "ambiguous"; slug: string }
  | { status: "not_found"; slug: string }
  | { canonicalPath: string; formId: string; slug: string; status: "unique"; workspacePublicKey: string };

type FormDataLike = {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
  entries(): IterableIterator<[string, FormDataEntryValue]>;
};

const defaultActions: WebsiteForm["actions"] = {
  createTask: true,
  followUpEmail: false,
  internalNotification: true,
  newsletterList: false,
  redirectUrl: "",
  showMeeting: false,
  thankYouMessage: "Danke, wir melden uns in Kürze.",
};

const defaultSteps: FormStep[] = [{ description: "", id: "step_contact", title: "Kontakt" }];

const defaultFields: FormField[] = [
  createFallbackField("text", "Name", "name", true, defaultSteps[0].id),
  createFallbackField("email", "E-Mail", "email", true, defaultSteps[0].id),
  createFallbackField("phone", "Telefon", "phone", false, defaultSteps[0].id),
  createFallbackField("consent", "Datenschutz akzeptieren", "privacy", true, defaultSteps[0].id),
];

export async function listWebsiteForms(input: { session: AppSession; limit?: number }): Promise<FormsRuntimePayload> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { forms: [], source: "fallback", submissions: [] };
  }

  try {
    const forms = await queryRows<FormRow>(
      `
        select
          f.id,
          f.workspace_id as "workspaceId",
          f.project_id as "projectId",
          f.owner_user_id as "ownerUserId",
          f.funnel_id as "funnelId",
          f.name,
          f.slug,
          f.status,
          f.variant,
          f.template,
          f.crm_target as "crmTarget",
          f.pipeline_stage as "pipelineStage",
          f.owner_mode as "ownerMode",
          f.campaign,
          f.tags,
          f.fields,
          f.actions,
          f.settings,
          f.visits_count as visits,
          f.submissions_count as submissions,
          f.conversion_rate as "conversionRate",
          f.last_submission_at as "lastSubmission",
          w.public_key as "workspacePublicKey"
        from forms f
        left join workspaces w on w.id = f.workspace_id
        where f.workspace_id = $1
        order by f.updated_at desc, f.created_at desc
        limit $2
      `,
      [input.session.workspaceId, input.limit ?? 100],
    );

    const submissions = await queryRows<SubmissionRow>(
      `
        select
          fs.id,
          fs.form_id as "formId",
          c.name as "contactName",
          c.email as "contactEmail",
          fs.lead_id as "leadId",
          fs.score,
          fs.status,
          coalesce(l.intent, fs.answers->>'message', fs.answers->>'intent') as intent,
          l.next_action as "nextAction",
          fs.created_at as "createdAt"
        from form_submissions fs
        left join contacts c on c.id = fs.contact_id
        left join leads l on l.id = fs.lead_id
        where fs.workspace_id = $1
        order by fs.created_at desc
        limit 50
      `,
      [input.session.workspaceId],
    );

    return {
      forms: forms.map(toWebsiteForm),
      source: "database",
      submissions: submissions.map(toSubmissionSummary),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Forms loader failed",
      forms: [],
      source: "fallback",
      submissions: [],
    };
  }
}

export async function upsertWebsiteForm(input: {
  expectedVersion: number;
  session: AppSession;
  form: WebsiteForm;
  operationId: string;
}): Promise<{
  code?:
    | "FORM_CONSENT_CONFIGURATION_UNAVAILABLE"
    | "FORM_CUSTOM_PATTERN_UNAVAILABLE"
    | "FORM_FILE_UPLOAD_UNAVAILABLE"
    | "FORM_OWNER_INVALID"
    | "FORM_OWNER_MODE_UNAVAILABLE"
    | "FORM_PERSISTENCE_UNAVAILABLE"
    | "FORM_SAVE_CONFLICT";
  form: WebsiteForm | null;
  persisted: boolean;
  reason?: string;
}> {
  if (!hasDatabaseUrl()) {
    return { form: null, persisted: false, reason: "DATABASE_URL is not configured" };
  }

  if (!isUuid(input.session.workspaceId)) {
    return { form: null, persisted: false, reason: "Workspace is not a database UUID" };
  }

  const form = normalizeWebsiteForm(input.form);
  if (form.ownerMode !== "user") {
    return {
      code: "FORM_OWNER_MODE_UNAVAILABLE",
      form: null,
      persisted: false,
      reason: "Round-robin assignment is not available for public forms",
    };
  }
  if (
    (form.status === "aktiv" || form.status === "eingebaut") &&
    form.fields.some((field) => Boolean(field.validationPattern.trim()))
  ) {
    return {
      code: "FORM_CUSTOM_PATTERN_UNAVAILABLE",
      form: null,
      persisted: false,
      reason: "Custom validation patterns require a linear-time validator before this form can be published",
    };
  }
  if (
    (form.status === "aktiv" || form.status === "eingebaut") &&
    getPublicFormLaunchBlockReason(form) === "form_consent_configuration_unavailable"
  ) {
    return {
      code: "FORM_CONSENT_CONFIGURATION_UNAVAILABLE",
      form: null,
      persisted: false,
      reason: "Public forms require one unconditional required privacy consent field and no unclassified consent fields",
    };
  }
  if (
    (form.status === "aktiv" || form.status === "eingebaut") &&
    form.fields.some((field) => field.type === "file")
  ) {
    return {
      code: "FORM_FILE_UPLOAD_UNAVAILABLE",
      form: null,
      persisted: false,
      reason: "File fields require durable file storage before this form can be published",
    };
  }
  if (form.status === "aktiv" || form.status === "eingebaut") {
    const workspace = await queryOne<{ publicKey: string | null }>(
      "select public_key as \"publicKey\" from workspaces where id = $1 limit 1",
      [input.session.workspaceId],
    );
    if (!workspace?.publicKey?.trim()) {
      return {
        form: null,
        persisted: false,
        reason: "A workspace public key is required before publishing a form",
      };
    }
  }
  const existingId = await resolveExistingFormId(input.session.workspaceId, form);
  const funnel = await resolveFunnel(input.session.workspaceId, form.funnelId);
  const projectId = funnel?.projectId ?? (await resolveFallbackProjectId(input.session.workspaceId));
  const requestedOwnerUserId = form.ownerUserId;
  const ownerUserId = await resolveActiveWorkspaceOwner(
    input.session.workspaceId,
    requestedOwnerUserId,
  );
  if (!ownerUserId) {
    return {
      code: "FORM_OWNER_INVALID",
      form: null,
      persisted: false,
      reason: "The selected form owner is not an active member of this workspace",
    };
  }
  const slug = slugify(form.slug || form.name) || `formular-${input.operationId}`;
  const tags = parseTags(form.tags);
  const settings = {
    doubleOptIn: form.doubleOptIn,
    legacyId: isUuid(form.id) ? undefined : form.id,
    progressMode: form.progressMode,
    spamProtection: form.spamProtection,
    steps: form.steps,
    utmCapture: form.utmCapture,
  };
  const saveRequestHash = hashFormSaveRequest({
    actions: form.actions,
    campaign: form.campaign,
    crmTarget: form.crmTarget,
    expectedVersion: input.expectedVersion,
    fields: form.fields,
    funnelId: funnel?.id ?? null,
    mode: existingId ? "update" : "insert",
    name: form.name,
    ownerMode: form.ownerMode,
    ownerUserId,
    pipelineStage: form.pipelineStage,
    projectId,
    settings,
    slug,
    status: form.status,
    tags,
    template: form.template,
    variant: form.variant,
    ...(existingId
      ? {}
      : {
          conversionRate: form.conversionRate,
          lastSubmission: form.lastSubmission || null,
          submissions: form.submissions,
          visits: form.visits,
        }),
  });
  const insertSettings = {
    ...settings,
    lastSaveOperationId: input.operationId,
    lastSaveRequestHash: saveRequestHash,
    version: 1,
  };

  const row = await withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const savedRow = existingId
    ? await transaction.queryOne<FormRow>(
        `
          with previous as materialized (
            select id as previous_id, settings as previous_settings
            from forms
            where workspace_id = $1 and id = $2
            for update
          )
          update forms
          set
            project_id = $3,
            owner_user_id = $4,
            funnel_id = $5,
            name = $6,
            slug = $7,
            status = $8,
            variant = $9,
            template = $10,
            crm_target = $11,
            pipeline_stage = $12,
            owner_mode = $13,
            campaign = $14,
            tags = $15::text[],
            fields = $16::jsonb,
            actions = $17::jsonb,
            settings = settings || $18::jsonb || jsonb_build_object(
              'lastSaveOperationId', $19::text,
              'lastSaveRequestHash', $21::text,
              'version', case
                when settings->>'lastSaveOperationId' = $19::text
                  and settings->>'lastSaveRequestHash' = $21::text
                  then coalesce((settings->>'version')::integer, 1)
                else coalesce((settings->>'version')::integer, 1) + 1
              end
            ),
            updated_at = now()
          from previous
          where forms.workspace_id = $1 and forms.id = previous.previous_id
            and (
              (
                previous.previous_settings->>'lastSaveOperationId' = $19::text
                and previous.previous_settings->>'lastSaveRequestHash' = $21::text
              )
              or coalesce((previous.previous_settings->>'version')::integer, 1) = $20::integer
            )
            and not exists (
              select 1
              from forms conflicting_form
              where conflicting_form.workspace_id = $1
                and conflicting_form.slug = $7
                and conflicting_form.id <> forms.id
            )
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            owner_user_id as "ownerUserId",
            funnel_id as "funnelId",
            name,
            slug,
            status,
            variant,
            template,
            crm_target as "crmTarget",
            pipeline_stage as "pipelineStage",
            owner_mode as "ownerMode",
            campaign,
            tags,
            fields,
            actions,
            settings,
            visits_count as visits,
            submissions_count as submissions,
            conversion_rate as "conversionRate",
            last_submission_at as "lastSubmission",
            (select public_key from workspaces where id = forms.workspace_id) as "workspacePublicKey",
            (
              previous.previous_settings->>'lastSaveOperationId' is distinct from $19::text
              or previous.previous_settings->>'lastSaveRequestHash' is distinct from $21::text
            ) as "writeApplied"
        `,
        [
          input.session.workspaceId,
          existingId,
          projectId,
          ownerUserId,
          funnel?.id ?? null,
          form.name,
          slug,
          form.status,
          form.variant,
          form.template,
          form.crmTarget,
          form.pipelineStage,
          form.ownerMode,
          form.campaign,
          tags,
          JSON.stringify(form.fields),
          JSON.stringify(form.actions),
          JSON.stringify(settings),
          input.operationId,
          input.expectedVersion,
          saveRequestHash,
        ],
      )
    : await transaction.queryOne<FormRow>(
        `
          insert into forms (
            workspace_id,
            project_id,
            owner_user_id,
            funnel_id,
            name,
            slug,
            status,
            variant,
            template,
            crm_target,
            pipeline_stage,
            owner_mode,
            campaign,
            tags,
            fields,
            actions,
            settings,
            visits_count,
            submissions_count,
            conversion_rate,
            last_submission_at
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14::text[], $15::jsonb, $16::jsonb, $17::jsonb,
            $18, $19, $20, $21::timestamptz
          )
          on conflict (workspace_id, slug) do update
          set updated_at = forms.updated_at
          where forms.settings->>'lastSaveOperationId' = excluded.settings->>'lastSaveOperationId'
            and forms.settings->>'lastSaveRequestHash' = excluded.settings->>'lastSaveRequestHash'
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            owner_user_id as "ownerUserId",
            funnel_id as "funnelId",
            name,
            slug,
            status,
            variant,
            template,
            crm_target as "crmTarget",
            pipeline_stage as "pipelineStage",
            owner_mode as "ownerMode",
            campaign,
            tags,
            fields,
            actions,
            settings,
            visits_count as visits,
            submissions_count as submissions,
            conversion_rate as "conversionRate",
            last_submission_at as "lastSubmission",
            (select public_key from workspaces where id = forms.workspace_id) as "workspacePublicKey",
            (xmax = 0) as "writeApplied"
        `,
        [
          input.session.workspaceId,
          projectId,
          ownerUserId,
          funnel?.id ?? null,
          form.name,
          slug,
          form.status,
          form.variant,
          form.template,
          form.crmTarget,
          form.pipelineStage,
          form.ownerMode,
          form.campaign,
          tags,
          JSON.stringify(form.fields),
          JSON.stringify(form.actions),
          JSON.stringify(insertSettings),
          form.visits,
          form.submissions,
          form.conversionRate,
          form.lastSubmission || null,
        ],
      );

      if (savedRow?.writeApplied) {
        await writeAuditLog({
          session: input.session,
          action: existingId ? "form.updated" : "form.created",
          entityType: "form",
          entityId: savedRow.id,
          after: { formId: savedRow.id, name: savedRow.name, status: savedRow.status },
          transaction,
        });
      }

      return savedRow;
    },
  );

  if (!row) {
    return {
      code: "FORM_SAVE_CONFLICT",
      form: null,
      persisted: false,
      reason: "The form changed in another tab or its public slug is already in use. Reload before retrying.",
    };
  }

  return { form: toWebsiteForm(row), persisted: true };
}

export async function getPublicWebsiteForm(input: PublicSlugLookup | { formId: string }): Promise<FormLookup | null> {
  if (!hasDatabaseUrl()) return null;

  const formId = "formId" in input && isUuid(input.formId) ? input.formId : null;
  const route = "workspacePublicKey" in input
    ? {
        slug: slugify(input.slug),
        workspacePublicKey: input.workspacePublicKey.trim(),
      }
    : null;

  if (!formId && (!route?.workspacePublicKey || !route.slug)) return null;

  const row = await queryOne<PublicFormRow>(
    `
      select
        f.id,
        f.workspace_id as "workspaceId",
        f.project_id as "projectId",
        f.owner_user_id as "ownerUserId",
        f.funnel_id as "funnelId",
        f.name,
        f.slug,
        f.status,
        f.variant,
        f.template,
        f.crm_target as "crmTarget",
        f.pipeline_stage as "pipelineStage",
        f.owner_mode as "ownerMode",
        f.campaign,
        f.tags,
        f.fields,
        f.actions,
        f.settings,
        f.visits_count as visits,
        f.submissions_count as submissions,
        f.conversion_rate as "conversionRate",
        f.last_submission_at as "lastSubmission",
        w.name as "workspaceName",
        w.public_key as "workspacePublicKey",
        (form_owner.id is not null) as "ownerActive",
        fn.audience as "funnelAudience"
      from forms f
      join workspaces w on w.id = f.workspace_id
      left join workspace_users form_owner
        on form_owner.workspace_id = f.workspace_id
       and form_owner.id = f.owner_user_id
       and form_owner.status = 'active'
      left join funnels fn
        on fn.workspace_id = f.workspace_id
       and fn.id = f.funnel_id
       and fn.project_id is not distinct from f.project_id
      where f.status in ('aktiv', 'eingebaut')
        and (
          ($1::uuid is not null and f.id = $1::uuid)
          or (
            $1::uuid is null
            and w.public_key = $2
            and f.slug = $3
          )
        )
      order by case when f.status = 'eingebaut' then 0 when f.status = 'aktiv' then 1 else 2 end,
        f.updated_at desc
      limit 1
    `,
    [formId, route?.workspacePublicKey ?? "", route?.slug ?? ""],
  );

  if (!row) return null;

  const publicPath = row.workspacePublicKey
    ? buildPublicFormPath({ workspacePublicKey: row.workspacePublicKey, slug: row.slug })
    : null;

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    projectId: row.projectId,
    ownerUserId: row.ownerUserId,
    ownerActive: row.ownerActive,
    funnelId: row.funnelId,
    funnelAudience: row.funnelAudience,
    form: toWebsiteForm(row),
    publicPath,
  };
}

export async function getPublicWebsiteFormByKey(formKey: string): Promise<FormLookup | null> {
  const route = parsePublicSlugLookup(formKey);
  if (route) return getPublicWebsiteForm(route);
  if (isUuid(formKey)) return getPublicWebsiteForm({ formId: formKey });

  const legacy = await getLegacyPublicWebsiteFormRoute(formKey);
  if (legacy.status !== "unique") return null;

  return getPublicWebsiteForm({
    slug: legacy.slug,
    workspacePublicKey: legacy.workspacePublicKey,
  });
}

export async function getLegacyPublicWebsiteFormRoute(slugValue: string): Promise<LegacyPublicFormRoute> {
  if (!hasDatabaseUrl()) return { status: "not_found", slug: slugValue };

  const slug = slugify(slugValue);
  if (!slug) return { status: "not_found", slug };

  const rows = await queryRows<{
    formId: string;
    slug: string;
    workspacePublicKey: string;
  }>(
    `
      select
        f.id as "formId",
        f.slug,
        w.public_key as "workspacePublicKey"
      from forms f
      join workspaces w on w.id = f.workspace_id
      where f.status in ('aktiv', 'eingebaut')
        and (
          f.slug = $1
          or f.settings->>'legacyId' = $1
        )
      order by case when f.status = 'eingebaut' then 0 when f.status = 'aktiv' then 1 else 2 end,
        f.updated_at desc
      limit 2
    `,
    [slug],
  );

  if (!rows.length) return { status: "not_found", slug };
  if (rows.length > 1) return { status: "ambiguous", slug };

  const [row] = rows;
  return {
    canonicalPath: buildPublicFormPath({ workspacePublicKey: row.workspacePublicKey, slug: row.slug }),
    formId: row.formId,
    slug: row.slug,
    status: "unique",
    workspacePublicKey: row.workspacePublicKey,
  };
}

export async function persistWebsiteFormSubmission(input: {
  actionHash: string;
  formData: FormDataLike;
  formId: string;
  formKey: string;
  idempotencyHash: string;
  leaseVersion: number;
  requestUrl: string;
  requestHash: string;
  scopeHash: string;
  successResponse: PublicSubmissionResponseSnapshot;
  workspaceId: string;
}): Promise<WebsiteFormSubmissionPersistenceResult> {
  if (!hasDatabaseUrl()) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  if (
    !isUuid(input.formId) ||
    !isUuid(input.workspaceId) ||
    !Number.isSafeInteger(input.leaseVersion) ||
    input.leaseVersion < 1 ||
    [input.actionHash, input.idempotencyHash, input.requestHash, input.scopeHash]
      .some((value) => !/^[a-f0-9]{64}$/u.test(value))
  ) {
    return { persisted: false, reason: "invalid_atomic_submission_scope" };
  }

  const successResponse = parsePublicSubmissionResponseSnapshot(input.successResponse);
  if (!successResponse) {
    return { persisted: false, reason: "invalid_atomic_submission_response" };
  }

  const lookup = await getPublicWebsiteFormByKey(input.formKey);
  if (
    !lookup ||
    lookup.id !== input.formId ||
    lookup.workspaceId !== input.workspaceId
  ) {
    return { persisted: false, reason: "Form not found" };
  }

  const form = lookup.form;
  const launchBlockReason = getPublicFormLaunchBlockReason(form, lookup.ownerActive);
  if (launchBlockReason) return { form, persisted: false, reason: launchBlockReason };
  if (!isUuid(lookup.ownerUserId)) return { form, persisted: false, reason: "form_owner_unavailable" };
  if (Array.from(input.formData.entries()).some(([, value]) => typeof value !== "string")) {
    return { form, persisted: false, reason: "form_file_upload_unavailable" };
  }
  const answers = extractAnswers(form, input.formData);
  const consent = extractConsent(form, answers, input.formData);

  const validationError = validateWebsiteFormSubmission(form, answers, input.formData);
  if (validationError) {
    return { persisted: false, reason: validationError, form };
  }

  const emailIdentity = resolveSemanticFieldValue(form, answers, input.formData, "email");
  if (emailIdentity.conflict) {
    return { form, persisted: false, reason: "multiple_email_values" };
  }
  const phoneIdentity = resolveSemanticFieldValue(form, answers, input.formData, "phone");
  if (phoneIdentity.conflict) {
    return { form, persisted: false, reason: "multiple_phone_values" };
  }

  const tracking = extractTracking(input.formData, input.requestUrl, form);
  const email = emailIdentity.value;
  const phone = phoneIdentity.value;
  const name = firstString(answers, ["name", "full_name", "fullname", "contact_name"]) || email || "Website Formular";
  const message = firstString(answers, ["message", "nachricht", "intent", "bedarf"]);
  const intent = message || `${form.name} Anfrage`;
  const score = scoreFormSubmission(form, answers, consent);
  const source = form.template === "newsletter" ? "Newsletter" : form.funnelId ? "Website Funnel" : "Website";
  const leadType = normalizeLeadType(lookup.funnelAudience);
  const idempotencyKey = `form:${input.idempotencyHash}`;
  const contactIdentityLocks = buildPublicContactIdentityLocks({
    email,
    fallback: input.idempotencyHash,
    phone,
  });

  const row = await withTenantTransaction(
    { actorId: lookup.ownerUserId, workspaceId: lookup.workspaceId },
    async (transaction) => {
      // Each identity lock is a separate READ COMMITTED statement. The CTE
      // below therefore starts with a fresh snapshot after a prior submitter
      // holding the same lock commits.
      for (const contactIdentityLock of contactIdentityLocks) {
        await transaction.execute(
          `select pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text || ':' || $3::text, 0))`,
          [lookup.workspaceId, publicContactIdentityLockNamespace, contactIdentityLock],
        );
      }
      return transaction.queryOne<AtomicFormSubmissionRow>(
    `
      with claim_fence as materialized (
        select claim.idempotency_hash
        from public_submission_idempotency claim
        where claim.idempotency_hash = $3
          and claim.action_hash = $4
          and claim.scope_hash = $5
          and claim.request_hash = $6
          and claim.lease_version = $7::bigint
          and claim.state = 'processing'
          and claim.expires_at > now()
        for update
      ),
      selected_form as materialized (
        select
          form.id,
          form.workspace_id as "workspaceId",
          form.project_id as "projectId",
          form.funnel_id as "funnelId",
          owner.id as "assignedOwnerId",
          owner.id as "ownerUserId",
          form.name,
          form.template,
          form.crm_target as "crmTarget"
        from forms form
        join workspaces workspace
          on workspace.id = form.workspace_id
        cross join claim_fence
        left join projects project
          on project.workspace_id = form.workspace_id
         and project.id = form.project_id
        left join workspace_users owner
          on owner.workspace_id = form.workspace_id
         and owner.id = form.owner_user_id
         and owner.status = 'active'
        left join funnels funnel
          on funnel.workspace_id = form.workspace_id
         and funnel.id = form.funnel_id
         and funnel.project_id is not distinct from form.project_id
        where form.workspace_id = $1::uuid
          and form.id = $2::uuid
          and coalesce((form.settings->>'version')::integer, 1) = $38::integer
          and form.status in ('aktiv', 'eingebaut')
          and form.owner_mode = 'user'
          and form.owner_user_id = $35::uuid
          and (form.project_id is null or project.id is not null)
          and owner.id = $35::uuid
          and (form.funnel_id is null or funnel.id is not null)
        for update of form
      ),
      existing_submission as materialized (
        select
          submission.id as "submissionId",
          submission.contact_id as "contactId",
          submission.lead_id as "leadId",
          submission.deal_id as "dealId",
          submission.task_id as "taskId",
          submission.request_hash as "requestHash",
          submission.response_payload as "responsePayload",
          (
            select timeline.id
            from contact_timeline_items timeline
            where timeline.workspace_id = submission.workspace_id
              and timeline.metadata->>'submissionIdempotencyHash' = $3
            order by timeline.occurred_at asc
            limit 1
          ) as "timelineItemId"
        from form_submissions submission
        join selected_form form
          on form."workspaceId" = submission.workspace_id
         and form.id = submission.form_id
        where submission.idempotency_key = $8
        limit 1
        for update of submission
      ),
      email_contacts as materialized (
        select
          contact.id,
          contact.created_at,
          contact.project_id,
          lower(btrim(contact.email)) as normalized_email,
          regexp_replace(coalesce(contact.phone, ''), '[^0-9+]', '', 'g') as normalized_phone
        from contacts contact
        join selected_form form
          on form."workspaceId" = contact.workspace_id
        where not exists (select 1 from existing_submission)
          and $36::text is not null
          and contact.archived_at is null
          and (contact.project_id = form."projectId" or contact.project_id is null)
          and lower(btrim(contact.email)) = $36::text
        for update of contact
      ),
      phone_contacts as materialized (
        select
          contact.id,
          contact.created_at,
          contact.project_id,
          lower(btrim(contact.email)) as normalized_email,
          regexp_replace(coalesce(contact.phone, ''), '[^0-9+]', '', 'g') as normalized_phone
        from contacts contact
        join selected_form form
          on form."workspaceId" = contact.workspace_id
        where not exists (select 1 from existing_submission)
          and $37::text is not null
          and contact.archived_at is null
          and (contact.project_id = form."projectId" or contact.project_id is null)
          and regexp_replace(coalesce(contact.phone, ''), '[^0-9+]', '', 'g') = $37::text
        for update of contact
      ),
      contact_identity as materialized (
        select
          (
            select email.id
            from email_contacts email
            order by (email.project_id = form."projectId") desc, email.created_at asc
            limit 1
          ) as "emailContactId",
          (
            select phone.id
            from phone_contacts phone
            order by (phone.project_id = form."projectId") desc, phone.created_at asc
            limit 1
          ) as "phoneContactId",
          (
            select count(distinct matched.id) > 1
            from (
              select id from email_contacts
              union all
              select id from phone_contacts
            ) matched
          )
          or exists (
            select 1
            from email_contacts email
            where $37::text is not null
              and nullif(email.normalized_phone, '') is not null
              and email.normalized_phone <> $37::text
          )
          or exists (
            select 1
            from phone_contacts phone
            where $36::text is not null
              and nullif(phone.normalized_email, '') is not null
              and phone.normalized_email <> $36::text
          ) as conflict
        from selected_form form
      ),
      existing_contact as materialized (
        select contact.id
        from contacts contact
        cross join contact_identity identity
        where not identity.conflict
          and contact.id = coalesce(identity."emailContactId", identity."phoneContactId")
      ),
      updated_contact as (
        update contacts contact
        set
          owner_user_id = coalesce(contact.owner_user_id, form."assignedOwnerId"),
          project_id = coalesce(form."projectId", contact.project_id),
          name = coalesce(nullif($9::text, ''), contact.name),
          role = $10,
          source = $11,
          intent = $12,
          consent_label = $13,
          email = coalesce(nullif(btrim(contact.email), ''), $14::text),
          phone = coalesce(nullif(btrim(contact.phone), ''), $15::text),
          metadata = contact.metadata || $16::jsonb,
          updated_at = now()
        from selected_form form
        cross join existing_contact existing
        where contact.workspace_id = form."workspaceId"
          and contact.id = existing.id
        returning contact.id
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
          form."workspaceId",
          form."projectId",
          form."assignedOwnerId",
          $9,
          $10,
          $11,
          $12,
          $13,
          $14::text,
          $15::text,
          $16::jsonb
        from selected_form form
        cross join contact_identity identity
        where not exists (select 1 from existing_submission)
          and not identity.conflict
          and not exists (select 1 from existing_contact)
        returning id
      ),
      chosen_contact as materialized (
        select id from updated_contact
        union all
        select id from inserted_contact
        limit 1
      ),
      prepared_ids as materialized (
        select
          gen_random_uuid() as "leadId",
          gen_random_uuid() as "dealId",
          gen_random_uuid() as "taskId",
          gen_random_uuid() as "submissionId",
          gen_random_uuid() as "privacyConsentId",
          gen_random_uuid() as "marketingConsentId",
          gen_random_uuid() as "timelineItemId",
          gen_random_uuid() as "auditId",
          gen_random_uuid() as "funnelAnalyticsId",
          gen_random_uuid() as "leadAnalyticsId",
          gen_random_uuid() as "speedToLeadId",
          gen_random_uuid() as "newsletterAnalyticsId"
        from selected_form
        where not exists (select 1 from existing_submission)
      ),
      inserted_lead as (
        insert into leads (
          id,
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
          ids."leadId",
          form."workspaceId",
          form."projectId",
          contact.id,
          form."assignedOwnerId",
          $11,
          $10,
          'Neu',
          $17::integer,
          $18::text,
          $12,
          $19,
          now(),
          now() + interval '4 hours',
          $17::integer >= 70,
          jsonb_build_object(
            'answers', $20::jsonb,
            'consent', $21::jsonb,
            'formId', form.id,
            'pipelineStage', $26::text,
            'submissionIdempotencyHash', $3,
            'tracking', $22::jsonb
          ),
          $8
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        where $24::boolean
        returning id
      ),
      inserted_deal as (
        insert into deals (
          id,
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
          ids."dealId",
          form."workspaceId",
          form."projectId",
          contact.id,
          form."assignedOwnerId",
          (select id from inserted_lead limit 1),
          $9 || ' - ' || form.name,
          $26,
          least(95, greatest(15, $17::integer)),
          $11,
          $19,
          jsonb_build_object(
            'formId', form.id,
            'submissionId', ids."submissionId",
            'submissionIdempotencyHash', $3,
            'tracking', $22::jsonb
          ),
          $8
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        where $25::boolean
        returning id
      ),
      inserted_task as (
        insert into tasks (
          id,
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
          ids."taskId",
          form."workspaceId",
          form."projectId",
          contact.id,
          (select id from inserted_lead limit 1),
          form."assignedOwnerId",
          $28,
          now() + interval '2 hours',
          case when $17::integer >= 70 then 'Hoch' else 'Mittel' end,
          'open',
          jsonb_build_object(
            'dealId', (select id from inserted_deal limit 1),
            'formId', form.id,
            'submissionId', ids."submissionId",
            'submissionIdempotencyHash', $3,
            'tracking', $22::jsonb
          )
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        where $27::boolean
        returning id
      ),
      success_response as materialized (
        select $34::jsonb as payload
        from chosen_contact contact
        cross join prepared_ids ids
      ),
      inserted_submission as (
        insert into form_submissions (
          id,
          workspace_id,
          project_id,
          form_id,
          funnel_id,
          contact_id,
          lead_id,
          deal_id,
          task_id,
          mode,
          status,
          score,
          answers,
          consent,
          tracking,
          raw_payload,
          idempotency_key,
          request_hash,
          response_payload,
          claim_lease_version
        )
        select
          ids."submissionId",
          form."workspaceId",
          form."projectId",
          form.id,
          form."funnelId",
          contact.id,
          (select id from inserted_lead limit 1),
          (select id from inserted_deal limit 1),
          (select id from inserted_task limit 1),
          'live',
          'processed',
          $17::integer,
          $20::jsonb,
          $21::jsonb,
          $22::jsonb,
          $23::jsonb,
          $8,
          $6,
          response.payload,
          $7::bigint
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        cross join success_response response
        returning id, contact_id, lead_id, deal_id, task_id, response_payload
      ),
      inserted_privacy_consent as (
        insert into consent_records (
          id,
          workspace_id,
          contact_id,
          project_id,
          channel,
          status,
          source,
          metadata
        )
        select
          ids."privacyConsentId",
          form."workspaceId",
          contact.id,
          form."projectId",
          'Website Formular',
          'Opt-in',
          form.name,
          jsonb_build_object(
            'consent', $21::jsonb,
            'formId', form.id,
            'submissionId', submission.id,
            'submissionIdempotencyHash', $3,
            'tracking', $22::jsonb
          )
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        cross join inserted_submission submission
        where $29::boolean
        returning id
      ),
      inserted_marketing_consent as (
        insert into consent_records (
          id,
          workspace_id,
          contact_id,
          project_id,
          channel,
          status,
          source,
          metadata
        )
        select
          ids."marketingConsentId",
          form."workspaceId",
          contact.id,
          form."projectId",
          'Newsletter',
          case when $31::boolean then 'Double-Opt-in offen' else 'Opt-in' end,
          form.name,
          jsonb_build_object(
            'consent', $21::jsonb,
            'formId', form.id,
            'submissionId', submission.id,
            'submissionIdempotencyHash', $3,
            'tracking', $22::jsonb
          )
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        cross join inserted_submission submission
        where $30::boolean
        returning id
      ),
      inserted_timeline as (
        insert into contact_timeline_items (
          id,
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
          ids."timelineItemId",
          form."workspaceId",
          contact.id,
          form."projectId",
          'Website',
          'Formular eingesendet',
          form.name || ' - Score ' || $17::text,
          'offen',
          jsonb_build_object(
            'formId', form.id,
            'leadId', (select id from inserted_lead limit 1),
            'submissionId', submission.id,
            'submissionIdempotencyHash', $3
          )
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        cross join inserted_submission submission
        returning id
      ),
      updated_form as (
        update forms form
        set
          submissions_count = form.submissions_count + 1,
          last_submission_at = now(),
          conversion_rate = case
            when form.visits_count > 0
              then round(((form.submissions_count + 1)::numeric / form.visits_count::numeric) * 100, 2)
            else form.conversion_rate
          end,
          updated_at = now()
        from inserted_submission submission
        where form.workspace_id = $1::uuid
          and form.id = $2::uuid
        returning form.id
      ),
      inserted_audit as (
        insert into audit_logs (
          id,
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
          ids."auditId",
          form."workspaceId",
          form."projectId",
          form."ownerUserId",
          'form.submission.persisted',
          'form_submission',
          submission.id,
          null,
          jsonb_build_object(
            'contactId', contact.id,
            'dealId', (select id from inserted_deal limit 1),
            'formId', form.id,
            'leadId', (select id from inserted_lead limit 1),
            'submissionIdempotencyHash', $3,
            'taskId', (select id from inserted_task limit 1)
          )
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        cross join inserted_submission submission
        returning id
      ),
      inserted_funnel_analytics as (
        insert into analytics_events (
          id,
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
          ids."funnelAnalyticsId",
          form."workspaceId",
          form."projectId",
          submission.id,
          'form_submission',
          form."ownerUserId",
          contact.id,
          (select id from inserted_lead limit 1),
          (select id from inserted_deal limit 1),
          form."funnelId",
          'funnel_submit',
          'funnel',
          $11,
          $11,
          0,
          now(),
          jsonb_build_object(
            'analyticsVersion', 1,
            'crmTarget', form."crmTarget",
            'entityId', submission.id,
            'entityType', 'form_submission',
            'formId', form.id,
            'formTemplate', form.template,
            'score', $17::integer,
            'submissionIdempotencyHash', $3,
            'taskId', (select id from inserted_task limit 1),
            'tracking', $22::jsonb
          )
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        cross join inserted_submission submission
        where $32::boolean
        returning id
      ),
      inserted_lead_analytics as (
        insert into analytics_events (
          id,
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
          ids."leadAnalyticsId",
          form."workspaceId",
          form."projectId",
          lead.id,
          'lead',
          form."ownerUserId",
          contact.id,
          lead.id,
          (select id from inserted_deal limit 1),
          form."funnelId",
          'lead_created',
          'lead_inbox',
          $11,
          $11,
          0,
          now(),
          jsonb_build_object(
            'analyticsVersion', 1,
            'crmTarget', form."crmTarget",
            'entityId', lead.id,
            'entityType', 'lead',
            'formId', form.id,
            'formTemplate', form.template,
            'score', $17::integer,
            'submissionIdempotencyHash', $3,
            'trigger', case when form."funnelId" is not null then 'funnel_submit' else 'form_submit' end
          )
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        cross join inserted_lead lead
        returning id
      ),
      inserted_speed_to_lead as (
        insert into speed_to_lead_events (
          id,
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
          ids."speedToLeadId",
          form."workspaceId",
          form."projectId",
          lead.id,
          contact.id,
          form."assignedOwnerId",
          'covered',
          now() + interval '4 hours',
          null,
          240,
          'teams',
          jsonb_build_object(
            'formId', form.id,
            'formTemplate', form.template,
            'score', $17::integer,
            'source', $11,
            'sourcePayload', 'website_form',
            'submissionId', submission.id,
            'submissionIdempotencyHash', $3,
            'trigger', case when form."funnelId" is not null then 'funnel_submit' else 'form_submit' end
          )
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        cross join inserted_lead lead
        cross join inserted_submission submission
        returning id
      ),
      inserted_newsletter_analytics as (
        insert into analytics_events (
          id,
          workspace_id,
          project_id,
          entity_id,
          entity_type,
          user_id,
          contact_id,
          lead_id,
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
          ids."newsletterAnalyticsId",
          form."workspaceId",
          form."projectId",
          submission.id,
          'form_submission',
          form."ownerUserId",
          contact.id,
          (select id from inserted_lead limit 1),
          form."funnelId",
          'newsletter_event',
          'newsletter',
          $11,
          'email',
          0,
          now(),
          jsonb_build_object(
            'analyticsVersion', 1,
            'entityId', submission.id,
            'entityType', 'form_submission',
            'event', 'form_opt_in',
            'formId', form.id,
            'formTemplate', form.template,
            'score', $17::integer,
            'submissionIdempotencyHash', $3,
            'tracking', $22::jsonb
          )
        from selected_form form
        cross join chosen_contact contact
        cross join prepared_ids ids
        cross join inserted_submission submission
        where $33::boolean
        returning id
      ),
      submission_outcome as materialized (
        select
          'created'::text as "persistenceState",
          submission.id as "submissionId",
          submission.contact_id as "contactId",
          submission.lead_id as "leadId",
          submission.deal_id as "dealId",
          submission.task_id as "taskId",
          timeline.id as "timelineItemId",
          submission.response_payload as "responsePayload"
        from inserted_submission submission
        cross join inserted_timeline timeline
        union all
        select
          case
            when existing."requestHash" = $6 then 'replay'::text
            else 'conflict'::text
          end,
          existing."submissionId",
          existing."contactId",
          existing."leadId",
          existing."dealId",
          existing."taskId",
          existing."timelineItemId",
          existing."responsePayload"
        from existing_submission existing
        union all
        select
          'identity_conflict'::text,
          null::uuid,
          null::uuid,
          null::uuid,
          null::uuid,
          null::uuid,
          null::uuid,
          null::jsonb
        from contact_identity identity
        where identity.conflict
          and not exists (select 1 from existing_submission)
      ),
      atomic_ready as materialized (
        select
          case
            when exists (
              select 1 from contact_identity identity where identity.conflict
            ) then true
            when exists (
              select 1
              from existing_submission existing
              where existing."requestHash" <> $6
            ) then true
            when exists (
              select 1
              from existing_submission existing
              where existing."requestHash" = $6
                and jsonb_typeof(existing."responsePayload") = 'object'
            ) then true
            when not exists (select 1 from existing_submission) then
              (select count(*) from chosen_contact) = 1
              and (select count(*) from inserted_lead) = case when $24::boolean then 1 else 0 end
              and (select count(*) from inserted_deal) = case when $25::boolean then 1 else 0 end
              and (select count(*) from inserted_task) = case when $27::boolean then 1 else 0 end
              and (select count(*) from inserted_submission) = 1
              and (select count(*) from inserted_privacy_consent) = case when $29::boolean then 1 else 0 end
              and (select count(*) from inserted_marketing_consent) = case when $30::boolean then 1 else 0 end
              and (select count(*) from inserted_timeline) = 1
              and (select count(*) from updated_form) = 1
              and (select count(*) from inserted_audit) = 1
              and (select count(*) from inserted_funnel_analytics) = case when $32::boolean then 1 else 0 end
              and (select count(*) from inserted_lead_analytics) = case when $24::boolean then 1 else 0 end
              and (select count(*) from inserted_speed_to_lead) = case when $24::boolean then 1 else 0 end
              and (select count(*) from inserted_newsletter_analytics) = case when $33::boolean then 1 else 0 end
            else false
          end as ready
        from selected_form
      ),
      completed_claim as (
        update public_submission_idempotency claim
        set
          state = 'completed',
          response_payload = outcome."responsePayload",
          completed_at = now(),
          expires_at = greatest(claim.expires_at, now() + interval '24 hours')
        from submission_outcome outcome
        cross join atomic_ready ready
        where ready.ready
          and outcome."persistenceState" in ('created', 'replay')
          and claim.idempotency_hash = $3
          and claim.action_hash = $4
          and claim.scope_hash = $5
          and claim.request_hash = $6
          and claim.lease_version = $7::bigint
          and claim.state = 'processing'
          and exists (select 1 from claim_fence)
        returning claim.response_payload
      )
      select
        outcome."persistenceState",
        outcome."submissionId",
        outcome."contactId",
        outcome."leadId",
        outcome."dealId",
        outcome."taskId",
        outcome."timelineItemId",
        completed.response_payload as "responsePayload",
        1 / case
          when ready.ready
            and (
              (outcome."persistenceState" in ('conflict', 'identity_conflict') and completed.response_payload is null)
              or (outcome."persistenceState" in ('created', 'replay') and completed.response_payload is not null)
            )
          then 1
          else 0
        end as invariant
      from submission_outcome outcome
      cross join atomic_ready ready
      left join completed_claim completed
        on outcome."persistenceState" in ('created', 'replay')
      limit 1
    `,
    [
      lookup.workspaceId,
      lookup.id,
      input.idempotencyHash,
      input.actionHash,
      input.scopeHash,
      input.requestHash,
      input.leaseVersion,
      idempotencyKey,
      name,
      leadType,
      source,
      intent,
      consent.marketing && !form.doubleOptIn ? "Opt-in" : "Nur CRM",
      email || null,
      phone || null,
      JSON.stringify({
        answers,
        formId: lookup.id,
        submissionIdempotencyHash: input.idempotencyHash,
        tracking,
      }),
      score,
      firstString(answers, ["budget", "preis", "price"]) || null,
      getNextAction(form),
      JSON.stringify(answers),
      JSON.stringify(consent),
      JSON.stringify({ ...tracking, submissionIdempotencyHash: input.idempotencyHash }),
      JSON.stringify({
        ...serializeFormDataPayload(input.formData),
        submissionIdempotencyHash: input.idempotencyHash,
      }),
      form.crmTarget !== "contact",
      form.crmTarget === "deal",
      form.pipelineStage || "Neuer Lead",
      form.actions.createTask || form.crmTarget === "ticket",
      form.crmTarget === "ticket" ? `Ticket prüfen: ${form.name}` : getNextAction(form),
      consent.privacy,
      consent.marketing,
      form.doubleOptIn,
      Boolean(lookup.funnelId),
      form.template === "newsletter" || form.actions.newsletterList,
      JSON.stringify(successResponse),
      lookup.ownerUserId,
      emailIdentity.normalizedValue || null,
      phoneIdentity.normalizedValue || null,
      form.version,
    ],
      );
    },
  );

  if (!row) {
    const current = await getPublicWebsiteFormByKey(input.formKey);
    if (
      current?.id === lookup.id &&
      current.workspaceId === lookup.workspaceId &&
      current.form.version !== form.version
    ) {
      return { form: current.form, persisted: false, reason: "submission_proof_stale" };
    }
    return { form, persisted: false, reason: "atomic_submission_scope_unavailable" };
  }
  if (row.persistenceState === "conflict") {
    return { form, persisted: false, reason: "submission_replay_conflict" };
  }
  if (row.persistenceState === "identity_conflict") {
    return { form, persisted: false, reason: "contact_identity_conflict" };
  }

  const response = parsePublicSubmissionResponseSnapshot(row.responsePayload);
  if (
    !response ||
    Number(row.invariant) !== 1 ||
    !row.submissionId ||
    !row.contactId
  ) {
    return { form, persisted: false, reason: "atomic_submission_response_invalid" };
  }

  return {
    form,
    ids: {
      contactId: row.contactId,
      dealId: row.dealId,
      leadId: row.leadId,
      submissionId: row.submissionId,
      taskId: row.taskId,
      timelineItemId: row.timelineItemId,
    },
    persisted: true,
    redirectUrl: form.actions.redirectUrl,
    response,
  };
}

async function resolveExistingFormId(workspaceId: string, form: WebsiteForm) {
  if (isUuid(form.id)) {
    const row = await queryOne<IdRow>(
      "select id from forms where workspace_id = $1 and id = $2 limit 1",
      [workspaceId, form.id],
    );
    if (row) return row.id;
  }

  const legacy = await queryOne<IdRow>(
    "select id from forms where workspace_id = $1 and settings->>'legacyId' = $2 limit 1",
    [workspaceId, form.id],
  );

  return legacy?.id ?? null;
}

async function resolveFunnel(workspaceId: string, funnelId: string) {
  if (!isUuid(funnelId)) return null;

  return queryOne<{ id: string; projectId: string | null; ownerUserId: string | null }>(
    `
      select id, project_id as "projectId", owner_user_id as "ownerUserId"
      from funnels
      where workspace_id = $1 and id = $2
      limit 1
    `,
    [workspaceId, funnelId],
  );
}

async function resolveActiveWorkspaceOwner(workspaceId: string, userId: string | null | undefined) {
  if (!isUuid(workspaceId) || !isUuid(userId)) return null;

  const owner = await queryOne<IdRow>(
    `
      select id
      from workspace_users
      where workspace_id = $1::uuid
        and id = $2::uuid
        and status = 'active'
      limit 1
    `,
    [workspaceId, userId],
  );
  return owner?.id ?? null;
}

async function resolveFallbackProjectId(workspaceId: string) {
  const row = await queryOne<IdRow>(
    `
      select id
      from projects
      where workspace_id = $1
      order by created_at asc
      limit 1
    `,
    [workspaceId],
  );

  return row?.id ?? null;
}

function toWebsiteForm(row: FormRow): WebsiteForm {
  const settings = asObject(row.settings);
  const steps = normalizeSteps(settings.steps, row.name);
  return {
    actions: normalizeActions(row.actions),
    campaign: row.campaign ?? "",
    conversionRate: Number(row.conversionRate ?? 0),
    crmTarget: normalizeTarget(row.crmTarget),
    doubleOptIn: Boolean(settings.doubleOptIn),
    fields: normalizeFields(row.fields, steps[0]?.id ?? defaultSteps[0].id),
    funnelId: row.funnelId ?? "",
    id: row.id,
    lastSubmission: toIso(row.lastSubmission),
    name: row.name,
    ownerMode: row.ownerMode === "user" ? "user" : "roundRobin",
    ownerUserId: row.ownerUserId ?? "",
    pipelineStage: row.pipelineStage || "Lead Inbox",
    progressMode: normalizeProgressMode(settings.progressMode),
    spamProtection: settings.spamProtection !== false,
    status: normalizeStatus(row.status),
    steps,
    submissions: Number(row.submissions ?? 0),
    slug: row.slug,
    tags: Array.isArray(row.tags) ? row.tags.join(", ") : "",
    template: normalizeTemplate(row.template),
    utmCapture: settings.utmCapture !== false,
    variant: normalizeVariant(row.variant),
    version: normalizeVersion(settings.version),
    visits: Number(row.visits ?? 0),
    workspacePublicKey: row.workspacePublicKey ?? undefined,
  };
}

function normalizeVersion(value: unknown) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

function toSubmissionSummary(row: SubmissionRow): FormSubmissionSummary {
  return {
    contactEmail: row.contactEmail ?? "",
    contactName: row.contactName ?? "Website Kontakt",
    createdAt: toIso(row.createdAt),
    formId: row.formId,
    id: row.id,
    intent: row.intent ?? "Formular eingesendet",
    leadId: row.leadId,
    nextAction: row.nextAction ?? "Eingang prüfen",
    score: Number(row.score ?? 0),
    status: row.status,
  };
}

function normalizeWebsiteForm(form: WebsiteForm): WebsiteForm {
  const steps = normalizeSteps(form.steps, form.name);
  const fallbackStepId = steps[0]?.id ?? defaultSteps[0].id;
  return {
    ...form,
    actions: { ...defaultActions, ...form.actions },
    fields: form.fields.length
      ? normalizeFields(form.fields, fallbackStepId)
      : defaultFields.map((field) => ({ ...field, stepId: field.type === "hidden" ? "" : fallbackStepId })),
    progressMode: normalizeProgressMode(form.progressMode),
    slug: form.slug || slugify(form.name),
    status: normalizeStatus(form.status),
    steps,
    template: normalizeTemplate(form.template),
    variant: normalizeVariant(form.variant),
    crmTarget: normalizeTarget(form.crmTarget),
  };
}

function extractAnswers(form: WebsiteForm, formData: FormDataLike) {
  const answers: Record<string, unknown> = {};

  for (const field of form.fields) {
    const entries = field.type === "hidden"
      ? []
      : formData.getAll(field.id).filter((value): value is FormDataEntryValue => value !== null);
    const normalized = field.type === "hidden"
      ? field.defaultValue.trim()
      : field.type === "multiCheckbox"
        ? entries.map(normalizeEntry).filter((value) => value !== "")
        : normalizeEntry(entries[0] ?? null);
    if (Array.isArray(normalized) ? normalized.length > 0 : normalized !== "") {
      answers[field.crmField || field.id] = normalized;
    }
  }

  return answers;
}

function extractConsent(form: WebsiteForm, answers: Record<string, unknown>, formData: FormDataLike) {
  const submittedFields = form.fields
    .filter((field) => isSubmittedFormFieldVisible(form, field, answers, formData))
    .filter((field) => getFormDataFieldEntries(field, formData).some(isTruthyPublicConsentValue));
  const privacy = submittedFields.some(isPrivacyConsentField);
  const marketing = submittedFields.some(isMarketingConsentField);

  return {
    doubleOptIn: form.doubleOptIn,
    marketing,
    privacy,
  };
}

function validateWebsiteFormSubmission(
  form: WebsiteForm,
  answers: Record<string, unknown>,
  formData: FormDataLike,
) {
  for (const field of form.fields) {
    if (field.type === "hidden") continue;
    if (!isSubmittedFormFieldVisible(form, field, answers, formData)) continue;

    const value = getSubmittedFieldValue(field, answers, formData);
    if (
      field.required &&
      (field.type === "checkbox" || field.type === "consent") &&
      !getFormDataFieldEntries(field, formData).some(isTruthyPublicConsentValue)
    ) {
      return isPrivacyConsentField(field)
        ? "privacy_consent_required"
        : `required_field_missing:${field.id}`;
    }

    if (field.required && isEmptySubmittedValue(value)) {
      return `required_field_missing:${field.id}`;
    }

    const validationError = validatePublicFormFieldValue(field, value);
    if (validationError) return validationError;
  }

  return "";
}

function isSubmittedFormFieldVisible(
  form: WebsiteForm,
  field: FormField,
  answers: Record<string, unknown>,
  formData: FormDataLike,
) {
  if (!field.conditionalFieldId || !field.conditionalValue) return true;
  const controller = form.fields.find((candidate) =>
    candidate.id === field.conditionalFieldId ||
    candidate.crmField === field.conditionalFieldId
  );
  if (!controller) return true;
  const value = getSubmittedFieldValue(controller, answers, formData);
  if (Array.isArray(value)) {
    return value.some((entry) => String(entry).trim() === field.conditionalValue);
  }
  return String(value ?? "").trim() === field.conditionalValue;
}

function resolveSemanticFieldValue(
  form: WebsiteForm,
  answers: Record<string, unknown>,
  formData: FormDataLike,
  type: "email" | "phone",
) {
  const values = form.fields
    .filter((field) => field.type === type)
    .flatMap((field) => {
      const value = getSubmittedFieldValue(field, answers, formData);
      return Array.isArray(value) ? value : [value];
    })
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim());
  const unique = new Map<string, string>();
  for (const value of values) {
    const identity = type === "email"
      ? normalizePublicContactEmail(value)
      : normalizePublicContactPhone(value);
    if (identity) unique.set(identity, value);
  }
  return {
    conflict: unique.size > 1,
    normalizedValue: unique.keys().next().value ?? "",
    value: unique.values().next().value ?? "",
  };
}

function getSubmittedFieldValue(field: FormField, answers: Record<string, unknown>, formData: FormDataLike) {
  const key = field.crmField || field.id;
  if (key in answers) return answers[key];
  const entries = field.type === "hidden" ? [] : formData.getAll(field.id).map(normalizeEntry).filter(Boolean);
  return field.type === "multiCheckbox" ? entries : entries[0] ?? "";
}

function getFormDataFieldEntries(field: FormField, formData: FormDataLike) {
  return field.type === "hidden" ? [] : formData.getAll(field.id);
}

function isEmptySubmittedValue(value: unknown) {
  if (Array.isArray(value)) return value.length === 0 || value.every((item) => String(item).trim() === "");
  return String(value ?? "").trim() === "";
}

function extractTracking(formData: FormDataLike, requestUrl: string, form: WebsiteForm) {
  const url = new URL(requestUrl);
  const tracking: Record<string, unknown> = {
    campaign: form.campaign,
    formVariant: stringFromFormData(formData, "form_variant") || form.variant,
    funnelId: stringFromFormData(formData, "funnel_id") || form.funnelId,
    pageUrl: stringFromFormData(formData, "page_url") || stringFromFormData(formData, "return_to"),
    referrer: stringFromFormData(formData, "referrer"),
  };

  for (const [key, value] of formData.entries()) {
    if (key.startsWith("utm_") || key === "gclid" || key === "fbclid") {
      tracking[key] = normalizeEntry(value);
    }
  }

  for (const key of ["utm_source", "utm_medium", "utm_campaign", "gclid", "fbclid"]) {
    const value = url.searchParams.get(key);
    if (value && !(key in tracking)) tracking[key] = value;
  }

  return tracking;
}

function scoreFormSubmission(form: WebsiteForm, answers: Record<string, unknown>, consent: { privacy: boolean; marketing: boolean }) {
  let score = 20;
  score += Math.min(45, Object.values(answers).filter(Boolean).length * 8);
  if (firstString(answers, form.fields.filter((field) => field.type === "phone").map((field) => field.crmField || field.id))) score += 10;
  if (firstString(answers, ["budget", "investment_volume", "living_area"])) score += 8;
  if (firstString(answers, ["preferred_date", "preferred_time", "selling_timeline"])) score += 6;
  if (consent.privacy) score += 10;
  if (form.actions.showMeeting) score += 5;
  if (form.crmTarget === "deal") score += 10;
  return Math.min(100, score);
}

function getNextAction(form: WebsiteForm) {
  if (form.actions.showMeeting) return "Meeting-Buchung anbieten";
  if (form.actions.followUpEmail) return "Follow-up E-Mail senden";
  if (form.crmTarget === "ticket") return "Ticket prüfen";
  return "Formulareingang prüfen";
}

function normalizeEntry(value: FormDataEntryValue | null) {
  if (value === null) return "";
  if (typeof value === "string") return value.trim();
  return value.name ? { fileName: value.name, size: value.size, type: value.type } : "";
}

function serializeFormDataPayload(formData: FormDataLike) {
  const payload: Record<string, unknown> = {};
  for (const [key, entry] of formData.entries()) {
    const value = normalizeEntry(entry);
    if (!(key in payload)) {
      payload[key] = value;
      continue;
    }
    const previous = payload[key];
    payload[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return payload;
}

function firstString(answers: Record<string, unknown>, keys: string[]) {
  const normalized = new Map(Object.entries(answers).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = normalized.get(key.toLowerCase());
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === "string" && item.trim());
      if (typeof first === "string") return first.trim();
    }
  }
  return "";
}

function stringFromFormData(formData: FormDataLike, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFields(value: unknown, fallbackStepId = defaultSteps[0].id): FormField[] {
  const raw = Array.isArray(value) ? value : defaultFields;
  const fields = raw.flatMap((item) => {
    const object = asObject(item);
    const type = normalizeFieldType(object.type);
    if (!type) return [];
    const crmField = typeof object.crmField === "string" && object.crmField ? object.crmField : defaultCrmField(type);
    return [createFormField({
      conditionalFieldId: typeof object.conditionalFieldId === "string" ? object.conditionalFieldId : "",
      conditionalValue: typeof object.conditionalValue === "string" ? object.conditionalValue : "",
      crmField,
      defaultValue: type === "consent" || (type === "checkbox" && isMarketingConsentCrmField(crmField))
        ? ""
        : typeof object.defaultValue === "string" ? object.defaultValue : "",
      errorMessage: typeof object.errorMessage === "string" ? object.errorMessage : "",
      fileAccept: typeof object.fileAccept === "string" ? object.fileAccept : type === "file" ? ".pdf,.jpg,.jpeg,.png,.doc,.docx" : "",
      fileMaxMb: typeof object.fileMaxMb === "number" ? object.fileMaxMb : type === "file" ? 10 : 0,
      helpText: typeof object.helpText === "string" ? object.helpText : "",
      id: typeof object.id === "string" && object.id ? object.id : `field_${type}_${Math.random().toString(16).slice(2)}`,
      label: typeof object.label === "string" && object.label ? object.label : defaultLabel(type),
      maxValue: typeof object.maxValue === "string" ? object.maxValue : type === "rating" ? "5" : "",
      minValue: typeof object.minValue === "string" ? object.minValue : type === "rating" ? "1" : "",
      multiple: Boolean(object.multiple),
      options: normalizeOptions(type, object.options),
      placeholder: typeof object.placeholder === "string" ? object.placeholder : "",
      required: Boolean(object.required),
      stepId: type === "hidden" ? "" : typeof object.stepId === "string" && object.stepId ? object.stepId : fallbackStepId,
      type,
      validationPattern: typeof object.validationPattern === "string" ? object.validationPattern : "",
    })];
  });

  return fields.length ? fields : defaultFields.map((field) => ({ ...field, stepId: field.type === "hidden" ? "" : fallbackStepId }));
}

function isMarketingConsentCrmField(value: string) {
  return ["marketing_consent", "newsletter_consent"].includes(value.trim().toLowerCase());
}

function normalizeSteps(value: unknown, fallbackTitle: string): FormStep[] {
  const raw = Array.isArray(value) ? value : defaultSteps;
  const steps = raw.flatMap((item, index) => {
    const object = asObject(item);
    const id = typeof object.id === "string" && object.id ? object.id : `step_${index + 1}`;
    const title = typeof object.title === "string" && object.title ? object.title : index === 0 ? fallbackTitle || "Kontakt" : `Schritt ${index + 1}`;
    return [{
      description: typeof object.description === "string" ? object.description : "",
      id,
      title,
    }];
  });

  return steps.length ? steps : defaultSteps;
}

function normalizeProgressMode(value: unknown): WebsiteForm["progressMode"] {
  return value === "steps" || value === "percent" ? value : "none";
}

function normalizeOptions(type: FormFieldType, value: unknown) {
  const options = Array.isArray(value)
    ? value.filter((option): option is string => typeof option === "string" && option.trim().length > 0)
    : [];
  if (options.length) return options;
  if (type === "select" || type === "radio") return ["Wohnung", "Haus", "Grundstück"];
  if (type === "multiCheckbox") return ["Graz", "Wien", "Umland"];
  return [];
}

function normalizeActions(value: unknown): WebsiteForm["actions"] {
  const object = asObject(value);
  return {
    createTask: Boolean(object.createTask ?? defaultActions.createTask),
    followUpEmail: Boolean(object.followUpEmail ?? defaultActions.followUpEmail),
    internalNotification: Boolean(object.internalNotification ?? defaultActions.internalNotification),
    newsletterList: Boolean(object.newsletterList ?? defaultActions.newsletterList),
    redirectUrl: typeof object.redirectUrl === "string" ? object.redirectUrl : "",
    showMeeting: Boolean(object.showMeeting ?? defaultActions.showMeeting),
    thankYouMessage: typeof object.thankYouMessage === "string" ? object.thankYouMessage : defaultActions.thankYouMessage,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeStatus(value: unknown): FormStatus {
  return value === "aktiv" || value === "eingebaut" || value === "fehler" ? value : "entwurf";
}

function normalizeVariant(value: unknown): FormVariant {
  return value === "embed" || value === "popup" || value === "slideIn" || value === "stickyTop" || value === "stickyBottom" ||
    value === "button" || value === "standalone" || value === "qr"
    ? value
    : "embed";
}

function normalizeTemplate(value: unknown): FormTemplate {
  return value === "buyerProfile" ||
    value === "consultation" ||
    value === "investorProfile" ||
    value === "leadMagnet" ||
    value === "newsletter" ||
    value === "projectExpose" ||
    value === "sellerValuation" ||
    value === "support" ||
    value === "viewing"
    ? value
    : "contact";
}

function normalizeTarget(value: unknown): FormTarget {
  return value === "contact" || value === "deal" || value === "ticket" ? value : "lead";
}

function normalizeFieldType(value: unknown): FormFieldType | null {
  return value === "checkbox" ||
    value === "company" ||
    value === "consent" ||
    value === "date" ||
    value === "email" ||
    value === "file" ||
    value === "hidden" ||
    value === "multiCheckbox" ||
    value === "number" ||
    value === "phone" ||
    value === "radio" ||
    value === "range" ||
    value === "rating" ||
    value === "select" ||
    value === "text" ||
    value === "textarea" ||
    value === "time" ||
    value === "url"
    ? value
    : null;
}

function normalizeLeadType(value: string | null) {
  return value && value.trim() ? value.trim() : "Käufer";
}

function parseTags(value: string) {
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function createFallbackField(type: FormFieldType, label: string, crmField: string, required: boolean, stepId = defaultSteps[0].id): FormField {
  return createFormField({
    crmField,
    helpText: type === "consent" ? "Ich stimme der Verarbeitung meiner Daten zu." : "",
    id: `field_${crmField}`,
    label,
    placeholder: type === "email" ? "name@example.com" : "",
    required,
    stepId,
    type,
  });
}

function defaultCrmField(type: FormFieldType) {
  if (type === "textarea") return "message";
  if (type === "consent") return "privacy";
  if (type === "hidden") return "utm_content";
  if (type === "multiCheckbox") return "preferences";
  return type;
}

function defaultLabel(type: FormFieldType) {
  const labels: Record<FormFieldType, string> = {
    checkbox: "Einwilligung",
    company: "Firma",
    consent: "Datenschutz akzeptieren",
    date: "Datum",
    email: "E-Mail",
    file: "Datei hochladen",
    hidden: "Hidden Field",
    multiCheckbox: "Mehrfachauswahl",
    number: "Zahl",
    phone: "Telefon",
    radio: "Auswahl",
    range: "Skala",
    rating: "Bewertung",
    select: "Dropdown",
    text: "Name",
    textarea: "Nachricht",
    time: "Zeit",
    url: "URL",
  };
  return labels[type];
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toIso(value: string | Date | null) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}
