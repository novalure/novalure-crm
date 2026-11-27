import type { AppSession } from "@/lib/auth/session";
import {
  assertCrmFields,
  assertCrmUuid,
  assertProjectGrant,
  CrmCommandError,
  executeCrmCommand,
  withCrmRead,
  type TenantTransaction,
  type TenantTransactionOptions,
} from "@/lib/crm-command";
import { getContactVisibilityScope } from "@/lib/contact-access";
import { getWorkspaceEnabledModules, hasProductCapability, isWorkspaceModuleEnabled, type WorkspaceModuleKey } from "@/lib/product-model";
import {
  emptyNewsletterDraft,
  normalizeNewsletterDraft,
} from "@/lib/newsletter-workspace";
import {
  normalizeMarketingSelection,
  type MarketingTemplate,
  type MarketingAudience,
  type MarketingTag,
  type MarketingSource,
} from "@/lib/marketing-domain";
import { readMarketingSourceDetails } from "@/lib/db/marketing-source-report-repository";
import { newsletterVariableIssues } from "@/lib/newsletter-message-variables";
import { readMarketingRelatedOutcomes } from "@/lib/db/marketing-related-outcomes-repository";

const sourceModules: Record<MarketingSource["kind"], WorkspaceModuleKey> = {
  newsletter: "newsletter", automation: "tasks", funnel: "funnels", expose: "properties", form: "funnels",
};
async function currentMarketingModules(tx: TenantTransaction, session: AppSession) {
  const workspace = await tx.queryOne<{ name: string; setup: Record<string, unknown> }>("select name,setup_state as setup from workspaces where id=$1::uuid", [session.workspaceId]);
  return getWorkspaceEnabledModules({ workspaceId: session.workspaceId, workspaceName: workspace?.name ?? session.workspaceName, setupState: workspace?.setup });
}
export async function marketingSchemaInstalled(tx: TenantTransaction) {
  return Boolean(
    (
      await tx.queryOne<{ installed: boolean }>(
        "select to_regclass('public.crm_marketing_tags') is not null as installed",
      )
    )?.installed,
  );
}
type Metadata = { idempotencyKey: string; correlationId: string };
const invalid = (message: string): never => {
  throw new CrmCommandError("INVALID_MARKETING", message);
};
const text = (value: unknown, max = 180) =>
  typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : invalid("Name bzw. Text fehlt oder ist zu lang.");
const version = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalid("Gespeicherte Version fehlt.");
export function normalizeMarketingVariants(
  value: unknown,
): MarketingTemplate["variants"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("Sprachvarianten fehlen.");
  const variants = value as Record<string, unknown>,
    result: MarketingTemplate["variants"] = {};
  if (
    !Object.keys(variants).length ||
    Object.keys(variants).some((key) => !["de", "en", "es"].includes(key))
  )
    return invalid(
      "Mindestens eine gültige DE-/EN-/ES-Sprachvariante ist erforderlich.",
    );
  for (const [language, variant] of Object.entries(variants)) {
    if (!variant || typeof variant !== "object" || Array.isArray(variant))
      return invalid("Ungültige Sprachvariante.");
    assertCrmFields(variant as Record<string, unknown>, [
      "subject",
      "previewText",
      "contentBlocks",
    ]);
    const draft = normalizeNewsletterDraft({
      ...emptyNewsletterDraft(),
      ...variant,
      language,
    });
    if (!draft.subject || !draft.contentBlocks.length)
      return invalid(
        "Jede gespeicherte Sprachvariante braucht Betreff und Inhalt.",
      );
    if (newsletterVariableIssues(JSON.stringify(variant)).length)
      return invalid(
        "Diese Vorlage enthält eine nicht unterstützte Pflichtvariable.",
      );
    result[language as keyof typeof result] = {
      subject: draft.subject,
      previewText: draft.previewText,
      contentBlocks: draft.contentBlocks,
    };
  }
  return result;
}
export async function assertMarketingTagScope(
  tx: TenantTransaction,
  workspaceId: string,
  projectId: string,
  tagIds: string[],
) {
  if (!tagIds.length) return;
  const tags = await tx.query<{ id: string }>(
    "select id from crm_marketing_tags where workspace_id=$1::uuid and project_id=$2::uuid and id=any($3::uuid[])",
    [workspaceId, projectId, tagIds],
  );
  if (tags.length !== tagIds.length)
    throw new CrmCommandError(
      "TAG_SCOPE",
      "Ein Tag gehört nicht zu diesem Projekt.",
      403,
    );
}
async function subjectAccess(
  tx: TenantTransaction,
  session: AppSession,
  projectId: string,
  kind: "contact" | "lead",
  id: string,
) {
  const visibility = getContactVisibilityScope(session);
  if (visibility.kind === "none")
    throw new CrmCommandError("FORBIDDEN", "Kontaktzugriff fehlt.", 403);
  const row =
    kind === "contact"
      ? await tx.queryOne(
          "select id from contacts where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid and archived_at is null and ($4::uuid is null or owner_user_id=$4::uuid) for share",
          [
            session.workspaceId,
            projectId,
            id,
            visibility.kind === "own" ? visibility.userId : null,
          ],
        )
      : await tx.queryOne(
          `select l.id from leads l left join contacts c on c.workspace_id=l.workspace_id and c.id=l.contact_id where l.workspace_id=$1::uuid and l.project_id=$2::uuid and l.id=$3::uuid and l.status<>'Archiviert' and ($4::uuid is null or l.assigned_to_user_id=$4::uuid) for share of l`,
          [
            session.workspaceId,
            projectId,
            id,
            visibility.kind === "own" ? visibility.userId : null,
          ],
        );
  if (!row)
    throw new CrmCommandError(
      "SUBJECT_UNAVAILABLE",
      "Originalkontakt bzw. Lead ist nicht verfügbar.",
      403,
    );
}
export async function mutateMarketing(
  session: AppSession,
  input: Record<string, unknown>,
  metadata: Metadata,
  options: TenantTransactionOptions = {},
) {
  const action = String(input.action),
    projectId = assertCrmUuid(input.projectId),
    id = input.id ? assertCrmUuid(input.id) : undefined,
    expected = version(input.expectedRevision);
  const fields: Record<string, string[]> = {
    tag: ["name"],
    assignTag: ["tagId", "subjectType", "subjectId", "active", "source"],
    profile: ["contactId", "countryCode", "preferredLanguage", "timezone"],
    audience: ["name", "audience", "selection"],
    template: ["name", "variants"],
    initiative: ["name", "goal"],
    sourceLink: ["initiativeId", "kind", "sourceId", "active"],
  };
  if (!fields[action]) return invalid("Unbekannte Marketingaktion.");
  assertCrmFields(input, [
    "action",
    "projectId",
    "id",
    "expectedRevision",
    ...fields[action],
  ]);
  return executeCrmCommand(
    session,
    {
      operation: `crm.marketing.${action}`,
      projectId,
      resourceId: id,
      capability: "workspace:operate",
      payload: input,
      ...metadata,
    },
    async (tx, context) => {
      if (context.session.serviceIdentity)
        throw new CrmCommandError(
          "FORBIDDEN",
          "Persönliche Anmeldung erforderlich.",
          403,
        );
      const modules = await currentMarketingModules(tx, context.session);
      const requiredModule = ["tag", "assignTag", "profile"].includes(action) ? "contacts" : ["audience", "template"].includes(action) ? "newsletter" : action === "sourceLink" ? sourceModules[input.kind as MarketingSource["kind"]] : undefined;
      if (requiredModule && !isWorkspaceModuleEnabled(modules, requiredModule)) throw new CrmCommandError("MODULE_DISABLED", "Dieser Marketingbereich ist im Arbeitsbereich ausgeschaltet.", 403);
      const args = [context.workspaceId, projectId];
      if (action === "tag") {
        const name = text(input.name, 80);
        const row = id
          ? await tx.queryOne<{ id: string; revision: number }>(
              "update crm_marketing_tags set name=$4,revision=revision+1,updated_by=$5::uuid,updated_at=now() where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid and revision=$6 returning id,revision",
              [...args, id, name, context.actorId, expected],
            )
          : expected === 0
            ? await tx.queryOne<{ id: string; revision: number }>(
                "insert into crm_marketing_tags(workspace_id,project_id,name,updated_by) values($1::uuid,$2::uuid,$3,$4::uuid) returning id,revision",
                [...args, name, context.actorId],
              )
            : null;
        if (!row)
          throw new CrmCommandError(
            "VERSION_CONFLICT",
            "Tag wurde geändert. Bitte neu laden.",
            409,
          );
        return { persisted: true, ...row };
      }
      if (action === "profile") {
        const contactId = assertCrmUuid(input.contactId);
        await subjectAccess(
          tx,
          context.session,
          projectId,
          "contact",
          contactId,
        );
        if (
          input.countryCode !== null &&
          !["AT", "DE", "ES", "IE"].includes(String(input.countryCode))
        )
          return invalid("Land ist ungültig.");
        if (
          input.preferredLanguage !== null &&
          !["de", "en", "es"].includes(String(input.preferredLanguage))
        )
          return invalid("Bevorzugte Sprache ist ungültig.");
        if (
          input.timezone !== null &&
          (typeof input.timezone !== "string" ||
            !(await tx.queryOne(
              "select name from pg_timezone_names where name=$1",
              [input.timezone],
            )))
        )
          return invalid("Zeitzone ist ungültig.");
        const row = await tx.queryOne<{ id: string; revision: number }>(
          "update contacts set country_code=$4,preferred_language=$5,contact_timezone=$6,marketing_profile_revision=marketing_profile_revision+1,updated_at=now() where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid and marketing_profile_revision=$7 returning id,marketing_profile_revision as revision",
          [
            ...args,
            contactId,
            input.countryCode,
            input.preferredLanguage,
            input.timezone,
            expected,
          ],
        );
        if (!row)
          throw new CrmCommandError(
            "VERSION_CONFLICT",
            "Kontakt wurde geändert. Bitte neu laden.",
            409,
          );
        return { persisted: true, ...row };
      }
      if (action === "assignTag") {
        const tagId = assertCrmUuid(input.tagId),
          subjectId = assertCrmUuid(input.subjectId),
          kind = input.subjectType;
        if (
          !["contact", "lead"].includes(String(kind)) ||
          typeof input.active !== "boolean"
        )
          return invalid("Tagziel ist ungültig.");
        await subjectAccess(
          tx,
          context.session,
          projectId,
          kind as "contact" | "lead",
          subjectId,
        );
        await assertMarketingTagScope(tx, context.workspaceId, projectId, [
          tagId,
        ]);
        const source = text(input.source, 300),
          column = kind === "contact" ? "contact_id" : "lead_id";
        const current = await tx.queryOne<{ id: string; revision: number }>(
          `select id,revision from crm_marketing_tag_assignments where workspace_id=$1::uuid and project_id=$2::uuid and tag_id=$3::uuid and ${column}=$4::uuid for update`,
          [...args, tagId, subjectId],
        );
        if ((current?.revision ?? 0) !== expected)
          throw new CrmCommandError(
            "VERSION_CONFLICT",
            "Tagzuordnung wurde geändert.",
            409,
          );
        const row = current
          ? await tx.queryOne<{ id: string; revision: number }>(
              "update crm_marketing_tag_assignments set active=$3,source=$4,revision=revision+1,updated_by=$5::uuid,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid returning id,revision",
              [
                context.workspaceId,
                current.id,
                input.active,
                source,
                context.actorId,
              ],
            )
          : await tx.queryOne<{ id: string; revision: number }>(
              `insert into crm_marketing_tag_assignments(workspace_id,project_id,tag_id,${column},active,source,updated_by) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid) returning id,revision`,
              [
                ...args,
                tagId,
                subjectId,
                input.active,
                source,
                context.actorId,
              ],
            );
        return { persisted: true, ...row! };
      }
      if (action === "audience") {
        const name = text(input.name),
          audience = String(input.audience);
        if (
          ![
            "Alle",
            "Käufer",
            "Verkäufer",
            "Investor",
            "Bauträger",
            "Makler",
          ].includes(audience)
        )
          return invalid("Kontaktart ist ungültig.");
        let selection;
        try {
          selection = normalizeMarketingSelection(input.selection);
        } catch (error) {
          return invalid(
            error instanceof Error ? error.message : "Ungültige Auswahl.",
          );
        }
        await assertMarketingTagScope(
          tx,
          context.workspaceId,
          projectId,
          selection.tagIds,
        );
        const row = id
          ? await tx.queryOne<{ id: string; revision: number }>(
              `update newsletter_segments set name=$4,audience=$5,selection_rules=$6::jsonb,selection_revision=selection_revision+1,updated_at=now() where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid and selection_revision=$7 returning id,selection_revision as revision`,
              [
                ...args,
                id,
                name,
                audience,
                JSON.stringify(selection),
                expected,
              ],
            )
          : expected === 0
            ? await tx.queryOne<{ id: string; revision: number }>(
                `insert into newsletter_segments(workspace_id,project_id,name,audience,language,source,rules,selection_rules) values($1::uuid,$2::uuid,$3,$4,'de','CRM','[]',$5::jsonb) returning id,selection_revision as revision`,
                [...args, name, audience, JSON.stringify(selection)],
              )
            : null;
        if (!row)
          throw new CrmCommandError(
            "VERSION_CONFLICT",
            "Zielgruppe wurde geändert.",
            409,
          );
        return { persisted: true, ...row };
      }
      if (action === "template") {
        const name = text(input.name),
          variants = normalizeMarketingVariants(input.variants);
        const row = id
          ? await tx.queryOne<{ id: string; revision: number }>(
              "update crm_marketing_templates set name=$4,variants=$5::jsonb,revision=revision+1,updated_by=$6::uuid,updated_at=now() where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid and revision=$7 returning id,revision",
              [
                ...args,
                id,
                name,
                JSON.stringify(variants),
                context.actorId,
                expected,
              ],
            )
          : expected === 0
            ? await tx.queryOne<{ id: string; revision: number }>(
                "insert into crm_marketing_templates(workspace_id,project_id,name,variants,updated_by) values($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid) returning id,revision",
                [...args, name, JSON.stringify(variants), context.actorId],
              )
            : null;
        if (!row)
          throw new CrmCommandError(
            "VERSION_CONFLICT",
            "Vorlage wurde geändert.",
            409,
          );
        await tx.execute(
          "insert into crm_marketing_template_versions(workspace_id,project_id,template_id,revision,name,variants,created_by) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7::uuid)",
          [
            ...args,
            row.id,
            row.revision,
            name,
            JSON.stringify(variants),
            context.actorId,
          ],
        );
        return { persisted: true, ...row };
      }
      if (action === "initiative") {
        const name = text(input.name),
          goal =
            typeof input.goal === "string" && input.goal.length <= 2000
              ? input.goal.trim()
              : invalid("Ziel ist zu lang.");
        const row = id
          ? await tx.queryOne<{ id: string; revision: number }>(
              "update crm_marketing_initiatives set name=$4,goal=$5,revision=revision+1,updated_by=$6::uuid,updated_at=now() where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid and revision=$7 returning id,revision",
              [...args, id, name, goal, context.actorId, expected],
            )
          : expected === 0
            ? await tx.queryOne<{ id: string; revision: number }>(
                "insert into crm_marketing_initiatives(workspace_id,project_id,name,goal,updated_by) values($1::uuid,$2::uuid,$3,$4,$5::uuid) returning id,revision",
                [...args, name, goal, context.actorId],
              )
            : null;
        if (!row)
          throw new CrmCommandError(
            "VERSION_CONFLICT",
            "Marketingvorhaben wurde geändert.",
            409,
          );
        return { persisted: true, ...row };
      }
      const initiativeId = assertCrmUuid(input.initiativeId),
        sourceId = assertCrmUuid(input.sourceId),
        kind = String(input.kind);
      if (
        !["newsletter", "automation", "funnel", "expose", "form"].includes(
          kind,
        ) ||
        typeof input.active !== "boolean"
      )
        return invalid("Originalquelle ist ungültig.");
      const current = await tx.queryOne<{ id: string; revision: number }>(
        "select id,revision from crm_marketing_source_links where workspace_id=$1::uuid and project_id=$2::uuid and initiative_id=$3::uuid and kind=$4 and source_id=$5::uuid for update",
        [...args, initiativeId, kind, sourceId],
      );
      if ((current?.revision ?? 0) !== expected)
        throw new CrmCommandError(
          "VERSION_CONFLICT",
          "Quellenverknüpfung wurde geändert.",
          409,
        );
      const row = current
        ? await tx.queryOne<{ id: string; revision: number }>(
            "update crm_marketing_source_links set active=$3,revision=revision+1,updated_by=$4::uuid,updated_at=now() where workspace_id=$1::uuid and id=$2::uuid returning id,revision",
            [context.workspaceId, current.id, input.active, context.actorId],
          )
        : await tx.queryOne<{ id: string; revision: number }>(
            "insert into crm_marketing_source_links(workspace_id,project_id,initiative_id,kind,source_id,active,updated_by) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7::uuid) returning id,revision",
            [
              ...args,
              initiativeId,
              kind,
              sourceId,
              input.active,
              context.actorId,
            ],
          );
      return { persisted: true, ...row! };
    },
    options,
  );
}
export async function readMarketingWorkspace(
  session: AppSession,
  projectId?: string,
  options: TenantTransactionOptions & { days?: 30 | 90 | 365 } = {},
) {
  return withCrmRead(
    session,
    async (tx, fresh) => {
      if (fresh.serviceIdentity)
        throw new CrmCommandError(
          "FORBIDDEN",
          "Persönliche Anmeldung erforderlich.",
          403,
        );
      if (projectId) await assertProjectGrant(tx, fresh, projectId);
      const days = options.days ?? 30;
      if (![30, 90, 365].includes(days)) return invalid("Berichtszeitraum ist ungültig.");
      const modules = await currentMarketingModules(tx, fresh);
      const contactsEnabled = isWorkspaceModuleEnabled(modules, "contacts"), newsletterEnabled = isWorkspaceModuleEnabled(modules, "newsletter");
      const canReadResults = isWorkspaceModuleEnabled(modules, "analytics") && hasProductCapability(fresh.productRole, "analytics:read");
      const args = [fresh.workspaceId, projectId ?? null],
        visibility = getContactVisibilityScope(fresh),
        owner = visibility.kind === "own" ? visibility.userId : null;
      const projects = await tx.query<{ id: string; name: string }>(
        "select id,name from projects where workspace_id=$1::uuid and ($2::uuid is null or id=$2::uuid) order by name",
        args,
      );
      const tags = contactsEnabled ? await tx.query<MarketingTag>(
        'select id,project_id as "projectId",name,revision from crm_marketing_tags where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) order by name',
        args,
      ) : [];
      const contacts =
        visibility.kind === "none" || !contactsEnabled
          ? []
          : await tx.query<{
              id: string;
              projectId: string;
              name: string;
              email: string;
              countryCode: string | null;
              preferredLanguage: string | null;
              timezone: string | null;
              revision: number;
            }>(
              'select id,project_id as "projectId",name,email,country_code as "countryCode",preferred_language as "preferredLanguage",contact_timezone as timezone,marketing_profile_revision as revision from contacts where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) and archived_at is null and ($3::uuid is null or owner_user_id=$3::uuid) order by name limit 1001',
              [...args, owner],
            );
      const leads =
        visibility.kind === "none" || !contactsEnabled
          ? []
          : await tx.query<{ id: string; projectId: string; name: string }>(
              `select l.id,l.project_id as "projectId",coalesce(c.name,l.type) as name from leads l left join contacts c on c.workspace_id=l.workspace_id and c.id=l.contact_id where l.workspace_id=$1::uuid and ($2::uuid is null or l.project_id=$2::uuid) and l.status<>'Archiviert' and ($3::uuid is null or l.assigned_to_user_id=$3::uuid) order by l.received_at desc limit 1001`,
              [...args, owner],
            );
      const assignments = await tx.query<{
        id: string;
        tagId: string;
        contactId: string | null;
        leadId: string | null;
        active: boolean;
        revision: number;
        source: string;
      }>(
        'select id,tag_id as "tagId",contact_id as "contactId",lead_id as "leadId",active,revision,source from crm_marketing_tag_assignments where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) and (contact_id=any($3::uuid[]) or lead_id=any($4::uuid[]))',
        [...args, contacts.map((c) => c.id), leads.map((l) => l.id)],
      );
      const audiences = newsletterEnabled ? await tx.query<MarketingAudience>(
        'select id,project_id as "projectId",name,audience,selection_rules as selection,selection_revision as revision from newsletter_segments where workspace_id=$1::uuid and project_id is not null and ($2::uuid is null or project_id=$2::uuid) order by name limit 1000',
        args,
      ) : [];
      const templates = newsletterEnabled ? await tx.query<MarketingTemplate>(
        'select id,project_id as "projectId",name,revision,variants from crm_marketing_templates where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) order by name limit 1000',
        args,
      ) : [];
      const initiatives = await tx.query<{
        id: string;
        projectId: string;
        name: string;
        goal: string;
        revision: number;
      }>(
        'select id,project_id as "projectId",name,goal,revision from crm_marketing_initiatives where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) order by updated_at desc limit 1000',
        args,
      );
      const links = await tx.query<{
        id: string;
        initiativeId: string;
        kind: MarketingSource["kind"];
        sourceId: string;
        active: boolean;
        revision: number;
      }>(
        'select id,initiative_id as "initiativeId",kind,source_id as "sourceId",active,revision from crm_marketing_source_links where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid)',
        args,
      );
      const sources: MarketingSource[] = [];
      const installed = new Set((await tx.query<{ name: string }>("select relname as name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relname=any($1::text[]) and has_table_privilege(current_user,c.oid,'SELECT')", [["newsletter_campaigns", "crm_newsletter_deliveries", "crm_provider_delivery_events", "crm_automations", "crm_automation_enrollments", "crm_automation_drafts", "crm_automation_mail_deliveries", "funnels", "forms", "web_expose_versions", "web_expose_inquiries", "web_expose_sessions", "web_expose_events", "form_submissions", "funnel_submissions", "property_viewing_slots", "property_reservations", "property_sales", "deals"]])).map(row => row.name));
      for (const [kind, table, name, status] of [
        ["newsletter", "newsletter_campaigns", "name", "status"],
        ["automation", "crm_automations", "name", "status"],
        ["funnel", "funnels", "name", "status"],
        ["form", "forms", "name", "status"],
        [
          "expose",
          "web_expose_versions",
          "coalesce(snapshot->>'title','Immobilienwebsite')",
          "case when active then 'Veröffentlicht' else 'Zurückgezogen' end",
        ],
      ] as const) {
        if (!installed.has(table) || !isWorkspaceModuleEnabled(modules, sourceModules[kind])) continue;
        const rows = await tx.query<Omit<MarketingSource, "kind" | "results">>(
          `select id,project_id as "projectId",${kind === "expose" ? "property_id" : "null::uuid"} as "propertyId",${name} as name,${status} as status from ${table} where workspace_id=$1::uuid and project_id is not null and ($2::uuid is null or project_id=$2::uuid) order by id limit 1000`,
          args,
        );
        sources.push(...rows.map((row) => ({ ...row, kind, results: {} })));
      }
      // These are source-specific observations, never summed into a fictitious funnel.
      const mailResults = canReadResults && installed.has("crm_newsletter_deliveries") ? await tx.query<{
        id: string;
        status: string;
        count: number;
      }>(
        "select d.campaign_id as id,d.status,count(*)::integer as count from crm_newsletter_deliveries d join contacts c on c.workspace_id=d.workspace_id and c.id=d.contact_id where d.workspace_id=$1::uuid and d.campaign_id=any($2::uuid[]) and ($3::uuid is null or c.owner_user_id=$3::uuid) and d.created_at>=clock_timestamp()-make_interval(days=>$4::integer) group by d.campaign_id,d.status",
        [
          fresh.workspaceId,
          sources.filter((s) => s.kind === "newsletter").map((s) => s.id),
          owner,
          days,
        ],
      ) : [];
      const exposeResults = canReadResults && installed.has("web_expose_inquiries") ? await tx.query<{ id: string; count: number }>(
        "select e.version_id as id,count(*)::integer as count from web_expose_inquiries i join web_expose_links e on e.workspace_id=i.workspace_id and e.id=i.link_id join leads l on l.workspace_id=i.workspace_id and l.id=i.lead_id where i.workspace_id=$1::uuid and e.version_id=any($2::uuid[]) and ($3::uuid is null or l.assigned_to_user_id=$3::uuid) and i.created_at>=clock_timestamp()-make_interval(days=>$4::integer) group by e.version_id",
        [
          fresh.workspaceId,
          sources.filter((s) => s.kind === "expose").map((s) => s.id),
          owner,
          days,
        ],
      ) : [];
      const incomingResults = new Map<string, number>();
      for (const [kind, table, column] of [
        ["form", "form_submissions", "form_id"],
        ["funnel", "funnel_submissions", "funnel_id"],
      ] as const) {
        if (!canReadResults || !installed.has(table) || !isWorkspaceModuleEnabled(modules, sourceModules[kind])) continue;
        const rows = await tx.query<{ id: string; count: number }>(
          `select s.${column} as id,count(*)::integer as count from ${table} s join leads l on l.workspace_id=s.workspace_id and l.id=s.lead_id where s.workspace_id=$1::uuid and s.${column}=any($2::uuid[]) and s.mode='live' and ($3::uuid is null or l.assigned_to_user_id=$3::uuid) and s.created_at>=clock_timestamp()-make_interval(days=>$4::integer) group by s.${column}`,
          [
            fresh.workspaceId,
            sources.filter((s) => s.kind === kind).map((s) => s.id),
            owner,
            days,
          ],
        );
        for (const row of rows)
          incomingResults.set(kind + ":" + row.id, row.count);
      }
      for (const source of sources) {
        if (!canReadResults) continue;
        if (source.kind === "newsletter")
          source.results = Object.fromEntries(
            mailResults
              .filter((r) => r.id === source.id)
              .map((r) => [r.status, r.count]),
          );
        else if (source.kind === "expose" && installed.has("web_expose_inquiries"))
          source.results = {
            inquiries:
              exposeResults.find((r) => r.id === source.id)?.count ?? 0,
          };
        else if ((source.kind === "form" && installed.has("form_submissions")) || (source.kind === "funnel" && installed.has("funnel_submissions")))
          source.results = {
            incomingSubmissions:
              incomingResults.get(source.kind + ":" + source.id) ?? 0,
          };
      }
      const attribution = canReadResults ? await readMarketingSourceDetails(tx, fresh, sources, days, installed, owner) : [];
      const outcomeReadable = new Set(installed);
      if (!isWorkspaceModuleEnabled(modules,"tasks")) for (const table of ["crm_automation_enrollments","crm_automation_drafts","crm_automation_mail_deliveries"]) outcomeReadable.delete(table);
      if (!isWorkspaceModuleEnabled(modules,"properties")) outcomeReadable.delete("property_viewing_slots");
      if (!isWorkspaceModuleEnabled(modules,"reservations")) outcomeReadable.delete("property_reservations");
      if (!isWorkspaceModuleEnabled(modules,"units")) outcomeReadable.delete("property_sales");
      if (!isWorkspaceModuleEnabled(modules,"pipeline")) outcomeReadable.delete("deals");
      const relatedOutcomes = canReadResults ? await readMarketingRelatedOutcomes(tx,fresh,sources,days,outcomeReadable,owner) : [];
      return {
        source: "database" as const,
        report: { days, asOf: new Date().toISOString(), canReadResults },
        attribution: attribution.slice(0, 200),
        attributionTruncated: attribution.length > 200,
        relatedOutcomes,
        workspaceId: fresh.workspaceId,
        agentName: fresh.name,
        projects,
        tags,
        contacts: contacts.slice(0, 1000),
        leads: leads.slice(0, 1000),
        contactsTruncated: contacts.length > 1000,
        leadsTruncated: leads.length > 1000,
        assignments,
        audiences,
        templates,
        initiatives,
        links,
        sources,
        unavailableSources: (Object.keys(sourceModules) as MarketingSource["kind"][]).filter(kind => isWorkspaceModuleEnabled(modules, sourceModules[kind]) && !installed.has({newsletter:"newsletter_campaigns",automation:"crm_automations",funnel:"funnels",expose:"web_expose_versions",form:"forms"}[kind])),
        canEdit:
          fresh.permissions.includes("crm:write") &&
          hasProductCapability(fresh.productRole, "workspace:operate"),
      };
    },
    options,
  );
}
