import type { AppSession } from "@/lib/auth/session";
import { writeCrmAnalyticsEvent } from "@/lib/db/analytics-event-repositories";
import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { recordSpeedToLeadEvent } from "@/lib/db/speed-to-lead-repositories";
import { isUuid, writeAuditLog, type PersistenceResult } from "@/lib/db/runtime-repositories";
import { createFormField } from "@/lib/form-types";
import { getProductRoleCapabilities } from "@/lib/product-model";
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
};

type PublicFormRow = FormRow & {
  workspaceName: string | null;
  funnelAudience: string | null;
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

type FormLookup = {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  projectId: string | null;
  ownerUserId: string | null;
  funnelId: string | null;
  funnelAudience: string | null;
  form: WebsiteForm;
};

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
          last_submission_at as "lastSubmission"
        from forms
        where workspace_id = $1
        order by updated_at desc, created_at desc
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
  session: AppSession;
  form: WebsiteForm;
}): Promise<{ form: WebsiteForm | null; persisted: boolean; reason?: string }> {
  if (!hasDatabaseUrl()) {
    return { form: null, persisted: false, reason: "DATABASE_URL is not configured" };
  }

  if (!isUuid(input.session.workspaceId)) {
    return { form: null, persisted: false, reason: "Workspace is not a database UUID" };
  }

  const form = normalizeWebsiteForm(input.form);
  const existingId = await resolveExistingFormId(input.session.workspaceId, form);
  const funnel = await resolveFunnel(input.session.workspaceId, form.funnelId);
  const projectId = funnel?.projectId ?? (await resolveFallbackProjectId(input.session.workspaceId));
  const ownerUserId = form.ownerMode === "user" && isUuid(form.ownerUserId)
    ? form.ownerUserId
    : funnel?.ownerUserId ?? (isUuid(input.session.userId) ? input.session.userId : null);
  const slug = slugify(form.name) || `formular-${Date.now()}`;
  const tags = parseTags(form.tags);
  const settings = {
    doubleOptIn: form.doubleOptIn,
    legacyId: isUuid(form.id) ? undefined : form.id,
    progressMode: form.progressMode,
    spamProtection: form.spamProtection,
    steps: form.steps,
    utmCapture: form.utmCapture,
  };

  const row = existingId
    ? await queryOne<FormRow>(
        `
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
            settings = settings || $18::jsonb,
            updated_at = now()
          where workspace_id = $1 and id = $2
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
            last_submission_at as "lastSubmission"
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
        ],
      )
    : await queryOne<FormRow>(
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
            last_submission_at as "lastSubmission"
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
          JSON.stringify(settings),
          form.visits,
          form.submissions,
          form.conversionRate,
          form.lastSubmission || null,
        ],
      );

  if (!row) {
    return { form: null, persisted: false, reason: "Form could not be saved" };
  }

  await writeAuditLog({
    session: input.session,
    action: existingId ? "form.updated" : "form.created",
    entityType: "form",
    entityId: row.id,
    after: { formId: row.id, name: row.name, status: row.status },
  });

  return { form: toWebsiteForm(row), persisted: true };
}

export async function getPublicWebsiteForm(formKey: string): Promise<FormLookup | null> {
  if (!hasDatabaseUrl()) return null;

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
        fn.audience as "funnelAudience"
      from forms f
      left join workspaces w on w.id = f.workspace_id
      left join funnels fn on fn.id = f.funnel_id
      where f.status in ('aktiv', 'eingebaut')
        and (
          ($1::uuid is not null and f.id = $1::uuid)
          or f.slug = $2
          or f.settings->>'legacyId' = $2
        )
      order by case when f.status = 'eingebaut' then 0 when f.status = 'aktiv' then 1 else 2 end,
        f.updated_at desc
      limit 1
    `,
    [isUuid(formKey) ? formKey : null, formKey],
  );

  if (!row) return null;

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    projectId: row.projectId,
    ownerUserId: row.ownerUserId,
    funnelId: row.funnelId,
    funnelAudience: row.funnelAudience,
    form: toWebsiteForm(row),
  };
}

export async function persistWebsiteFormSubmission(input: {
  formData: FormDataLike;
  formKey: string;
  requestUrl: string;
}): Promise<PersistenceResult & { form?: WebsiteForm; redirectUrl?: string }> {
  if (!hasDatabaseUrl()) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const lookup = await getPublicWebsiteForm(input.formKey);
  if (!lookup) {
    return { persisted: false, reason: "Form not found" };
  }

  const form = lookup.form;
  const answers = extractAnswers(form, input.formData);
  const consent = extractConsent(form, input.formData);

  if (form.fields.some((field) => field.type === "consent" && field.required) && !consent.privacy) {
    return { persisted: false, reason: "privacy_consent_required", form };
  }

  const validationError = validateWebsiteFormSubmission(form, answers, input.formData, consent);
  if (validationError) {
    return { persisted: false, reason: validationError, form };
  }

  const tracking = extractTracking(input.formData, input.requestUrl, form);
  const email = firstString(answers, ["email", "e_mail", "mail"]);
  const phone = firstString(answers, ["phone", "telefon", "telephone"]);
  const name = firstString(answers, ["name", "full_name", "fullname", "contact_name"]) || email || "Website Formular";
  const message = firstString(answers, ["message", "nachricht", "intent", "bedarf"]);
  const intent = message || `${form.name} Anfrage`;
  const score = scoreFormSubmission(form, answers, consent);
  const now = new Date().toISOString();
  const slaDueAt = new Date(Date.now() + 1000 * 60 * 60 * 4).toISOString();
  const source = form.template === "newsletter" ? "Newsletter" : form.funnelId ? "Website Funnel" : "Website";
  const leadType = normalizeLeadType(lookup.funnelAudience);
  const assignedOwnerId = form.ownerMode === "user" && isUuid(lookup.ownerUserId) ? lookup.ownerUserId : null;

  const contactId = await upsertContact({
    answers,
    consentLabel: consent.marketing && !form.doubleOptIn ? "Opt-in" : "Nur CRM",
    email,
    form,
    intent,
    leadType,
    name,
    ownerUserId: assignedOwnerId,
    phone,
    projectId: lookup.projectId,
    source,
    tracking,
    workspaceId: lookup.workspaceId,
  });

  const lead = form.crmTarget === "contact"
    ? null
    : await queryOne<IdRow>(
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
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, $14, $15::jsonb)
          returning id
        `,
        [
          lookup.workspaceId,
          lookup.projectId,
          contactId,
          assignedOwnerId,
          source,
          leadType,
          "Neu",
          score,
          firstString(answers, ["budget", "preis", "price"]) || null,
          intent,
          getNextAction(form),
          now,
          slaDueAt,
          score >= 70,
          JSON.stringify({ answers, consent, formId: lookup.id, pipelineStage: form.pipelineStage, tracking }),
        ],
      );

  const deal = form.crmTarget === "deal"
    ? await queryOne<IdRow>(
        `
          insert into deals (
            workspace_id, project_id, contact_id, owner_user_id, lead_id, name, stage, probability, source, next_action, metadata
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
          returning id
        `,
        [
          lookup.workspaceId,
          lookup.projectId,
          contactId,
          assignedOwnerId,
          lead?.id ?? null,
          `${name} - ${form.name}`,
          form.pipelineStage || "Neuer Lead",
          Math.min(95, Math.max(15, score)),
          source,
          getNextAction(form),
          JSON.stringify({ formId: lookup.id, tracking }),
        ],
      )
    : null;

  const task = form.actions.createTask || form.crmTarget === "ticket"
    ? await queryOne<IdRow>(
        `
          insert into tasks (workspace_id, project_id, contact_id, lead_id, owner_user_id, title, due_at, priority, status, metadata)
          values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, 'open', $9::jsonb)
          returning id
        `,
        [
          lookup.workspaceId,
          lookup.projectId,
          contactId,
          lead?.id ?? null,
          assignedOwnerId,
          form.crmTarget === "ticket" ? `Ticket prüfen: ${form.name}` : getNextAction(form),
          new Date(Date.now() + 1000 * 60 * 60 * 2).toISOString(),
          score >= 70 ? "Hoch" : "Mittel",
          JSON.stringify({ formId: lookup.id, dealId: deal?.id ?? null, tracking }),
        ],
      )
    : null;

  if (contactId && consent.privacy) {
    await queryOne(
      `
        insert into consent_records (workspace_id, contact_id, project_id, channel, status, source, metadata)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        returning id
      `,
      [
        lookup.workspaceId,
        contactId,
        lookup.projectId,
        "Website Formular",
        form.doubleOptIn ? "Double-Opt-in offen" : "Opt-in",
        form.name,
        JSON.stringify({ formId: lookup.id, consent, tracking }),
      ],
    );
  }

  if (contactId && consent.marketing) {
    await queryOne(
      `
        insert into consent_records (workspace_id, contact_id, project_id, channel, status, source, metadata)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        returning id
      `,
      [
        lookup.workspaceId,
        contactId,
        lookup.projectId,
        "Newsletter",
        form.doubleOptIn ? "Double-Opt-in offen" : "Opt-in",
        form.name,
        JSON.stringify({ formId: lookup.id, consent, tracking }),
      ],
    );
  }

  const submission = await queryOne<IdRow>(
    `
      insert into form_submissions (
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
        raw_payload
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, 'live', 'processed', $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb)
      returning id
    `,
    [
      lookup.workspaceId,
      lookup.projectId,
      lookup.id,
      lookup.funnelId,
      contactId,
      lead?.id ?? null,
      deal?.id ?? null,
      task?.id ?? null,
      score,
      JSON.stringify(answers),
      JSON.stringify(consent),
      JSON.stringify(tracking),
      JSON.stringify(Object.fromEntries(input.formData.entries())),
    ],
  );

  if (contactId) {
    await queryOne(
      `
        insert into contact_timeline_items (
          workspace_id, contact_id, project_id, channel, title, detail, outcome, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        returning id
      `,
      [
        lookup.workspaceId,
        contactId,
        lookup.projectId,
        "Website",
        "Formular eingesendet",
        `${form.name} - Score ${score}`,
        "offen",
        JSON.stringify({ formId: lookup.id, submissionId: submission?.id ?? null, leadId: lead?.id ?? null }),
      ],
    );
  }

  await queryOne(
    `
      update forms
      set submissions_count = submissions_count + 1,
          last_submission_at = now(),
          conversion_rate = case
            when visits_count > 0 then round(((submissions_count + 1)::numeric / visits_count::numeric) * 100, 2)
            else conversion_rate
          end,
          updated_at = now()
      where id = $1
      returning id
    `,
    [lookup.id],
  );

  const formSession: AppSession = {
    authenticated: true,
    email: "website@novalure.local",
    name: "Website Formular",
    permissions: [],
    productPermissions: getProductRoleCapabilities("assistant_backoffice"),
    productRole: "assistant_backoffice",
    role: "owner",
    source: "database",
    userId: lookup.ownerUserId ?? "00000000-0000-0000-0000-000000000000",
    workspaceId: lookup.workspaceId,
    workspaceName: lookup.workspaceName ?? "Novalure",
  };

  await Promise.all([
    writeAuditLog({
      session: formSession,
      action: "form.submission.persisted",
      entityType: "form_submission",
      entityId: submission?.id,
      after: { contactId, dealId: deal?.id ?? null, formId: lookup.id, leadId: lead?.id ?? null, taskId: task?.id ?? null },
    }),
    lookup.funnelId
      ? writeCrmAnalyticsEvent({
          channel: source,
          contactId,
          dealId: deal?.id ?? null,
          entityId: submission?.id ?? null,
          entityType: "form_submission",
          eventType: "funnel_submit",
          funnelId: lookup.funnelId,
          leadId: lead?.id ?? null,
          metadata: {
            crmTarget: form.crmTarget,
            formId: lookup.id,
            formTemplate: form.template,
            score,
            taskId: task?.id ?? null,
            tracking,
          },
          module: "funnel",
          projectId: lookup.projectId,
          source,
          userId: lookup.ownerUserId,
          workspaceId: lookup.workspaceId,
        })
      : null,
    lead?.id
      ? writeCrmAnalyticsEvent({
          channel: source,
          contactId,
          dealId: deal?.id ?? null,
          entityId: lead.id,
          entityType: "lead",
          eventType: "lead_created",
          funnelId: lookup.funnelId,
          leadId: lead.id,
          metadata: {
            crmTarget: form.crmTarget,
            formId: lookup.id,
            formTemplate: form.template,
            score,
            trigger: lookup.funnelId ? "funnel_submit" : "form_submit",
          },
          module: "lead_inbox",
          projectId: lookup.projectId,
          source,
          userId: lookup.ownerUserId,
          workspaceId: lookup.workspaceId,
        })
      : null,
    lead?.id
      ? recordSpeedToLeadEvent({
          channel: source,
          contactId,
          dueAt: slaDueAt,
          leadId: lead.id,
          metadata: {
            formId: lookup.id,
            formTemplate: form.template,
            score,
            sourcePayload: "website_form",
            trigger: lookup.funnelId ? "funnel_submit" : "form_submit",
          },
          ownerUserId: assignedOwnerId,
          projectId: lookup.projectId,
          source,
          state: "covered",
          userId: lookup.ownerUserId,
          workspaceId: lookup.workspaceId,
        })
      : null,
    form.template === "newsletter" || form.actions.newsletterList
      ? writeCrmAnalyticsEvent({
          channel: "email",
          contactId,
          entityId: submission?.id ?? contactId,
          entityType: "form_submission",
          eventType: "newsletter_event",
          funnelId: lookup.funnelId,
          leadId: lead?.id ?? null,
          metadata: {
            event: "form_opt_in",
            formId: lookup.id,
            formTemplate: form.template,
            score,
            tracking,
          },
          module: "newsletter",
          projectId: lookup.projectId,
          source,
          userId: lookup.ownerUserId,
          workspaceId: lookup.workspaceId,
        })
      : null,
  ]);

  return {
    form,
    persisted: true,
    redirectUrl: form.actions.redirectUrl,
    ids: {
      contactId,
      dealId: deal?.id ?? null,
      leadId: lead?.id ?? null,
      submissionId: submission?.id ?? null,
      taskId: task?.id ?? null,
    },
  };
}

async function upsertContact(input: {
  answers: Record<string, unknown>;
  consentLabel: string;
  email: string;
  form: WebsiteForm;
  intent: string;
  leadType: string;
  name: string;
  ownerUserId: string | null;
  phone: string;
  projectId: string | null;
  source: string;
  tracking: Record<string, unknown>;
  workspaceId: string;
}) {
  const existing = input.email || input.phone
    ? await queryOne<IdRow>(
        `
          select id
          from contacts
          where workspace_id = $1
            and (
              ($2::text <> '' and lower(email) = lower($2))
              or ($3::text <> '' and phone = $3)
            )
          order by updated_at desc
          limit 1
        `,
        [input.workspaceId, input.email, input.phone],
      )
    : null;

  if (existing) {
    await queryOne(
      `
        update contacts
        set
          owner_user_id = coalesce(owner_user_id, $3::uuid),
          project_id = coalesce($4, project_id),
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
        input.workspaceId,
        existing.id,
        input.ownerUserId,
        input.projectId,
        input.name,
        input.leadType,
        input.source,
        input.intent,
        input.consentLabel,
        input.email,
        input.phone,
        JSON.stringify({ answers: input.answers, formId: input.form.id, tracking: input.tracking }),
      ],
    );

    return existing.id;
  }

  const contact = await queryOne<IdRow>(
    `
      insert into contacts (
        workspace_id, project_id, owner_user_id, name, role, source, intent, consent_label, email, phone, metadata
      )
      values ($1, $2, $3::uuid, $4, $5, $6, $7, $8, nullif($9, ''), nullif($10, ''), $11::jsonb)
      returning id
    `,
    [
      input.workspaceId,
      input.projectId,
      input.ownerUserId,
      input.name,
      input.leadType,
      input.source,
      input.intent,
      input.consentLabel,
      input.email,
      input.phone,
      JSON.stringify({ answers: input.answers, formId: input.form.id, tracking: input.tracking }),
    ],
  );

  return contact?.id ?? null;
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
    tags: Array.isArray(row.tags) ? row.tags.join(", ") : "",
    template: normalizeTemplate(row.template),
    utmCapture: settings.utmCapture !== false,
    variant: normalizeVariant(row.variant),
    visits: Number(row.visits ?? 0),
  };
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
    const keys = [field.id, field.crmField, field.type, slugify(field.label)].filter(
      (key): key is string => Boolean(key),
    );
    const entries = keys.flatMap((key) => formData.getAll(key)).filter((value): value is FormDataEntryValue => value !== null);
    const normalized =
      field.type === "multiCheckbox"
        ? entries.map(normalizeEntry).filter((value) => value !== "")
        : normalizeEntry(entries[0] ?? null);
    if (Array.isArray(normalized) ? normalized.length > 0 : normalized !== "") {
      answers[field.crmField || field.id] = normalized;
    }
  }

  for (const [key, value] of formData.entries()) {
    if (
      key.startsWith("utm_") ||
      key === "form_id" ||
      key === "form_slug" ||
      key === "form_variant" ||
      key === "funnel_id" ||
      key === "page_url" ||
      key === "referrer" ||
      key === "return_to"
    ) continue;
    if (!(key in answers)) {
      const normalized = normalizeEntry(value);
      if (normalized !== "") answers[key] = normalized;
    }
  }

  return answers;
}

function extractConsent(form: WebsiteForm, formData: FormDataLike) {
  const privacy = Boolean(formData.get("privacy")) || Boolean(formData.get("privacy_consent"));
  const marketing = Boolean(formData.get("marketing_consent")) || (form.template === "newsletter" && privacy);

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
  consent: { privacy: boolean; marketing: boolean },
) {
  for (const field of form.fields) {
    if (field.type === "hidden") continue;

    if (field.required && field.type === "consent" && !consent.privacy) {
      return "privacy_consent_required";
    }

    const value = getSubmittedFieldValue(field, answers, formData);
    if (field.required && isEmptySubmittedValue(value)) {
      return `required_field_missing:${field.crmField || field.id}`;
    }

    if (field.type === "email" && !isEmptySubmittedValue(value) && !isValidEmail(String(Array.isArray(value) ? value[0] : value))) {
      return "invalid_email";
    }
  }

  const email = firstString(answers, ["email", "e_mail", "mail"]);
  if (email && !isValidEmail(email)) return "invalid_email";

  return "";
}

function getSubmittedFieldValue(field: FormField, answers: Record<string, unknown>, formData: FormDataLike) {
  const key = field.crmField || field.id;
  if (key in answers) return answers[key];
  const entries = formData.getAll(key).map(normalizeEntry).filter(Boolean);
  return field.type === "multiCheckbox" ? entries : entries[0] ?? "";
}

function isEmptySubmittedValue(value: unknown) {
  if (Array.isArray(value)) return value.length === 0 || value.every((item) => String(item).trim() === "");
  return String(value ?? "").trim() === "";
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
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
  if (firstString(answers, ["phone", "telefon"])) score += 10;
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
    return [createFormField({
      conditionalFieldId: typeof object.conditionalFieldId === "string" ? object.conditionalFieldId : "",
      conditionalValue: typeof object.conditionalValue === "string" ? object.conditionalValue : "",
      crmField: typeof object.crmField === "string" && object.crmField ? object.crmField : defaultCrmField(type),
      defaultValue: typeof object.defaultValue === "string" ? object.defaultValue : "",
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
