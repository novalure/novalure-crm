import type { AppSession } from "@/lib/auth/session";
import { queryOne } from "@/lib/db/client";
import { canPersist, isUuid } from "@/lib/db/runtime-repositories";

export type ConsentPolicyChannel =
  | "Newsletter"
  | "E-Mail"
  | "WhatsApp"
  | "Instagram"
  | "Telefon"
  | "Tracking Pixel"
  | "CAPI"
  | "Webhook";
export type ConsentPolicyPurpose =
  | "newsletter"
  | "botOutreach"
  | "salesFollowUp"
  | "meetingFollowUp"
  | "tracking"
  | "webhook";

export type ConsentPolicyReason =
  | "allowed_opt_in"
  | "allowed_contact_label_opt_in"
  | "contact_missing"
  | "database_unavailable"
  | "decision_log_unavailable"
  | "missing_address"
  | "missing_opt_in"
  | "newsletter_suppression"
  | "opt_out";

export type ConsentPolicyDecision = {
  allowed: boolean;
  channel: ConsentPolicyChannel;
  contactId?: string | null;
  decisionId?: string | null;
  email?: string | null;
  projectId?: string | null;
  purpose: ConsentPolicyPurpose;
  reason: ConsentPolicyReason;
  sourceConsentId?: string | null;
  suppressionId?: string | null;
};

type ContactConsentRow = {
  consentLabel: string;
  email: string | null;
  id: string;
  phone: string | null;
  projectId: string | null;
};

type ConsentRecordRow = {
  channel: string;
  id: string;
  status: string;
};

type IdRow = { id: string };

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeEmail(value: unknown) {
  const email = cleanString(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizePhone(value: unknown) {
  return cleanString(value).replace(/^00/, "").replace(/[^0-9]/g, "");
}

function needsEmail(channel: ConsentPolicyChannel) {
  return channel === "Newsletter" || channel === "E-Mail";
}

function needsPhone(channel: ConsentPolicyChannel) {
  return channel === "WhatsApp" || channel === "Telefon";
}

function isTrackingChannel(channel: ConsentPolicyChannel) {
  return channel === "Tracking Pixel" || channel === "CAPI" || channel === "Webhook";
}

function isOptIn(value: string | null | undefined) {
  const normalized = value ?? "";
  if (/(double.?opt.?in|doi).*(offen|pending|open)|pending/i.test(normalized)) return false;

  return /(opt.?in|einwilligung|zugestimmt|subscribed|newsletter\s+ja|ja\s+newsletter|yes|true)/i.test(normalized);
}

function isOptOut(value: string | null | undefined) {
  return /(opt.?out|abgemeldet|unsubscribe|unsubscribed|widerspruch|stop|no|false)/i.test(value ?? "");
}

function consentChannelsFor(channel: ConsentPolicyChannel, purpose: ConsentPolicyPurpose) {
  if (purpose === "newsletter") return ["Newsletter"];
  if (purpose === "tracking") return ["Tracking Pixel", "CAPI", "Webhook", "Newsletter"];
  if (purpose === "webhook") return ["Webhook", "CAPI", "Newsletter"];
  if (purpose === "meetingFollowUp") return ["E-Mail", "Newsletter"];
  if (channel === "E-Mail") return ["E-Mail", "Newsletter"];
  return [channel];
}

async function findContact(input: {
  contactId?: string | null;
  email?: string | null;
  phone?: string | null;
  workspaceId: string;
}) {
  if (isUuid(input.contactId)) {
    return queryOne<ContactConsentRow>(
      `
        select
          id,
          project_id as "projectId",
          consent_label as "consentLabel",
          email,
          phone
        from contacts
        where id = $1::uuid and workspace_id = $2::uuid
        limit 1
      `,
      [input.contactId, input.workspaceId],
    );
  }

  if (input.email) {
    return queryOne<ContactConsentRow>(
      `
        select
          id,
          project_id as "projectId",
          consent_label as "consentLabel",
          email,
          phone
        from contacts
        where workspace_id = $1::uuid and lower(email) = lower($2)
        order by updated_at desc
        limit 1
      `,
      [input.workspaceId, input.email],
    );
  }

  if (input.phone) {
    return queryOne<ContactConsentRow>(
      `
        select
          id,
          project_id as "projectId",
          consent_label as "consentLabel",
          email,
          phone
        from contacts
        where workspace_id = $1::uuid
          and regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = $2
        order by updated_at desc
        limit 1
      `,
      [input.workspaceId, input.phone],
    );
  }

  return null;
}

async function findSuppression(input: {
  email?: string | null;
  workspaceId: string;
}) {
  if (!input.email) return null;

  return queryOne<IdRow>(
    `
      select id
      from newsletter_suppressions
      where workspace_id = $1::uuid and lower(email) = lower($2)
      limit 1
    `,
    [input.workspaceId, input.email],
  );
}

async function findLatestConsent(input: {
  channel: ConsentPolicyChannel;
  contactId: string;
  purpose: ConsentPolicyPurpose;
  workspaceId: string;
}) {
  return queryOne<ConsentRecordRow>(
    `
      select id, channel, status
      from consent_records
      where workspace_id = $1::uuid
        and contact_id = $2::uuid
        and channel = any($3::text[])
      order by captured_at desc
      limit 1
    `,
    [
      input.workspaceId,
      input.contactId,
      consentChannelsFor(input.channel, input.purpose),
    ],
  );
}

async function insertDecision(input: {
  allowed: boolean;
  channel: ConsentPolicyChannel;
  contactId?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown>;
  projectId?: string | null;
  purpose: ConsentPolicyPurpose;
  reason: ConsentPolicyReason;
  sourceConsentId?: string | null;
  suppressionId?: string | null;
  workspaceId: string;
}) {
  const row = await queryOne<IdRow>(
    `
      insert into consent_policy_decisions (
        workspace_id,
        project_id,
        contact_id,
        channel,
        purpose,
        allowed,
        reason,
        source_consent_id,
        metadata
      )
      values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::jsonb)
      returning id
    `,
    [
      input.workspaceId,
      isUuid(input.projectId) ? input.projectId : null,
      input.contactId,
      input.channel,
      input.purpose,
      input.allowed,
      input.reason,
      isUuid(input.sourceConsentId) ? input.sourceConsentId : null,
      JSON.stringify({
        ...(input.metadata ?? {}),
        email: input.email ?? null,
        suppressionId: input.suppressionId ?? null,
      }),
    ],
  );

  return row?.id ?? null;
}

export async function evaluateOutboundConsent(input: {
  channel: ConsentPolicyChannel;
  contactId?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown>;
  phone?: string | null;
  projectId?: string | null;
  purpose: ConsentPolicyPurpose;
  session?: AppSession;
  workspaceId?: string | null;
}): Promise<ConsentPolicyDecision> {
  const workspaceId = input.session?.workspaceId ?? input.workspaceId ?? null;
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const base = {
    channel: input.channel,
    email: email || null,
    purpose: input.purpose,
  };

  if (!canPersist() || !isUuid(workspaceId)) {
    return { ...base, allowed: false, reason: "database_unavailable" };
  }

  if (!isTrackingChannel(input.channel) && ((needsEmail(input.channel) && !email) || (needsPhone(input.channel) && !phone))) {
    let decisionId: string | null = null;
    try {
      decisionId = await insertDecision({
        allowed: false,
        channel: input.channel,
        contactId: input.contactId,
        email,
        metadata: input.metadata,
        projectId: input.projectId,
        purpose: input.purpose,
        reason: "missing_address",
        workspaceId,
      });
    } catch {
      decisionId = null;
    }

    return { ...base, allowed: false, decisionId, projectId: input.projectId ?? null, reason: "missing_address" };
  }

  let contact: ContactConsentRow | null = null;
  let suppression: IdRow | null = null;
  let consent: ConsentRecordRow | null = null;
  let reason: ConsentPolicyReason = "missing_opt_in";
  let allowed = false;

  try {
    contact = await findContact({
      contactId: input.contactId,
      email,
      phone,
      workspaceId,
    });

    if (!contact) {
      reason = "contact_missing";
    } else {
      suppression = await findSuppression({
        email: email || contact.email,
        workspaceId,
      });

      if (suppression) {
        reason = "newsletter_suppression";
      } else {
        consent = await findLatestConsent({
          channel: input.channel,
          contactId: contact.id,
          purpose: input.purpose,
          workspaceId,
        });

        if (isOptOut(consent?.status) || isOptOut(contact.consentLabel)) {
          reason = "opt_out";
        } else if (isOptIn(consent?.status)) {
          allowed = true;
          reason = "allowed_opt_in";
        } else if (input.purpose !== "newsletter" && isOptIn(contact.consentLabel)) {
          allowed = true;
          reason = "allowed_contact_label_opt_in";
        }
      }
    }
  } catch {
    return { ...base, allowed: false, reason: "database_unavailable" };
  }

  let decisionId: string | null = null;
  try {
    decisionId = await insertDecision({
      allowed,
      channel: input.channel,
      contactId: contact?.id ?? null,
      email: (email || contact?.email) ?? null,
      metadata: input.metadata,
      projectId: input.projectId ?? contact?.projectId ?? null,
      purpose: input.purpose,
      reason,
      sourceConsentId: consent?.id ?? null,
      suppressionId: suppression?.id ?? null,
      workspaceId,
    });
  } catch {
    if (allowed) {
      return {
        ...base,
        allowed: false,
        contactId: contact?.id ?? null,
        projectId: input.projectId ?? contact?.projectId ?? null,
        reason: "decision_log_unavailable",
        sourceConsentId: consent?.id ?? null,
        suppressionId: suppression?.id ?? null,
      };
    }
  }

  return {
    ...base,
    allowed,
    contactId: contact?.id ?? null,
    decisionId,
    projectId: input.projectId ?? contact?.projectId ?? null,
    reason,
    sourceConsentId: consent?.id ?? null,
    suppressionId: suppression?.id ?? null,
  };
}
