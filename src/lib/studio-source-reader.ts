import "server-only";
import { createHash } from "node:crypto";
import { verifyVercelOidcToken } from "@vercel/oidc";
import {
  CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_WORKSPACE_ID,
  CrmMachineAuthError, getCrmMachineBearer, verifyCrmMachineToken, type CrmMachineAuthOptions,
} from "./crm-machine-auth";
import { CrmCommandError, type TenantTransaction } from "./crm-command";
import { queryRows, resolveDatabaseUrl, withPublicSubmissionTransaction } from "./db/client";
import { readKnowledgeJson } from "./knowledge-center/http";
import { studioEnquiryCrmProject, studioEnquiryProject } from "./studio-enquiry-contract";
import { websiteSalesActorId, websiteSalesFormId, websiteSalesWorkspaceId } from "./website-sales-ingestion";
import { isWebsiteSalesPreviewTarget, type WebsiteSalesPreviewTarget } from "./website-sales-preview-auth";

export const studioSourcePath = "/api/integrations/evelyn/studio/source";
export const studioSourcePreviewAudience = `urn:novalure:crm:studio-source:preview:${studioEnquiryProject}`;
const previewSubject = "owner:novalure:project:evelyn:environment:preview";
const scope = { workspaceId: websiteSalesWorkspaceId, actorId: websiteSalesActorId };
const hash = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cursorPattern = /^(0|[1-9][0-9]{0,18})\.[a-f0-9]{64}$/;
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

export type StudioTransferBinding = {
  workspaceId: string;
  crmProjectId: string;
  operationId: string;
  revision: number;
  payloadHash: string;
  leadId: string;
  submissionId: string;
};

export type StudioAcceptedSourceTransfer = StudioTransferBinding & {
  state: "accepted";
  acceptedAt: string;
  syntheticTest: false;
};

type ReaderOptions = CrmMachineAuthOptions & { pool?: NonNullable<Parameters<typeof withPublicSubmissionTransaction>[2]>["pool"] };
type Profile = "preview" | "production";
type Receiver = { profile: Profile; deploymentId: string; revision: string };
type PageRow = { events: unknown; scopeValid: boolean; nextCursor: string | null; hasMore: boolean; sourceGrantId: string };

function denied(): never { throw new CrmMachineAuthError("STUDIO_SOURCE_DENIED", 403); }

function readerReceiver(request: Request, env: NodeJS.ProcessEnv): Receiver {
  const profile = env.VERCEL_ENV;
  const url = new URL(request.url);
  if (request.method !== "POST" || request.headers.has("cookie") || request.headers.has("origin") ||
    url.protocol !== "https:" || url.pathname !== studioSourcePath || url.search || url.hash || url.port ||
    env.VERCEL !== "1" || env.CRM_MACHINE_AUTH_ENABLED !== "1" || env.VERCEL_PROJECT_ID !== studioEnquiryProject ||
    !env.VERCEL_DEPLOYMENT_ID || !/^dpl_[a-zA-Z0-9]+$/.test(env.VERCEL_DEPLOYMENT_ID) ||
    !env.VERCEL_GIT_COMMIT_SHA || !/^[a-f0-9]{40}$/.test(env.VERCEL_GIT_COMMIT_SHA) ||
    (profile !== "production" && profile !== "preview") ||
    (env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== profile)) denied();
  if (profile === "preview") {
    if (env.CRM_STUDIO_SOURCE_PREVIEW_ENABLED !== "1" || env.VERCEL_URL !== url.hostname ||
      !url.hostname.endsWith(".vercel.app")) denied();
    const database = new URL(resolveDatabaseUrl(env));
    if (database.protocol !== "postgresql:" || (database.port && database.port !== "5432") ||
      !/^ep-summer-dew-bht4t903-pooler\.[a-z0-9.-]+\.neon\.tech$/.test(database.hostname) ||
      database.pathname !== "/neondb" || database.username !== "novalure_app" ||
      !["require", "verify-full"].includes(database.searchParams.get("sslmode") ?? "") ||
      database.searchParams.getAll("sslmode").length !== 1 ||
      database.searchParams.getAll("channel_binding").length > 1 ||
      (database.searchParams.has("channel_binding") && database.searchParams.get("channel_binding") !== "require") ||
      [...database.searchParams.keys()].some(key => !["sslmode", "channel_binding"].includes(key))) denied();
  }
  return { profile, deploymentId: env.VERCEL_DEPLOYMENT_ID, revision: env.VERCEL_GIT_COMMIT_SHA };
}

async function verifyPreviewSource(token: string, options: ReaderOptions) {
  const now = options.now ?? new Date();
  const verification = await (options.verifier ?? verifyVercelOidcToken)(token, {
    algorithms: ["RS256"], typ: "JWT", issuer: CRM_MACHINE_ISSUER, audience: studioSourcePreviewAudience,
    ownerId: CRM_MACHINE_OWNER_ID, projectId: CRM_MACHINE_PROJECT_ID, environment: "preview",
    currentDate: now, maxTokenAge: "5m", clockTolerance: 0,
    requiredClaims: ["iss", "aud", "sub", "iat", "nbf", "exp", "jti"],
  }).catch(denied);
  const { payload: p, protectedHeader: h } = verification;
  const time = Math.floor(now.getTime() / 1000);
  if (h.alg !== "RS256" || h.typ !== "JWT" || typeof h.kid !== "string" || !h.kid ||
    p.iss !== CRM_MACHINE_ISSUER || p.aud !== studioSourcePreviewAudience || p.sub !== previewSubject ||
    p.project_id !== CRM_MACHINE_PROJECT_ID || p.owner_id !== CRM_MACHINE_OWNER_ID || p.environment !== "preview" ||
    typeof p.jti !== "string" || !uuid.test(p.jti) || typeof p.iat !== "number" || !Number.isSafeInteger(p.iat) ||
    typeof p.nbf !== "number" || !Number.isSafeInteger(p.nbf) || typeof p.exp !== "number" || !Number.isSafeInteger(p.exp) ||
    p.iat > time || p.iat < time - 300 || p.nbf > time || p.exp <= time || p.exp <= p.iat) denied();
  return p.exp;
}

function bindingIsValid(value: Partial<StudioTransferBinding>): boolean {
  return value.workspaceId === websiteSalesWorkspaceId && value.crmProjectId === studioEnquiryCrmProject &&
    typeof value.operationId === "string" && uuid.test(value.operationId) &&
    typeof value.leadId === "string" && uuid.test(value.leadId) &&
    typeof value.submissionId === "string" && uuid.test(value.submissionId) &&
    typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 1 &&
    typeof value.payloadHash === "string" && hash.test(value.payloadHash);
}

function isAcceptedTransfer(value: unknown): value is StudioAcceptedSourceTransfer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<StudioAcceptedSourceTransfer>;
  return Object.keys(row).length === 10 && bindingIsValid(row) && row.state === "accepted" &&
    row.syntheticTest === false && typeof row.acceptedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.acceptedAt) &&
    Number.isFinite(Date.parse(row.acceptedAt));
}

// Called inside the normal Sales command, after its own current project/write
// authorization. The only cross-actor Studio authority is an exact boolean.
type StudioSalesSourceAuthority = Readonly<(
  { workloadId: string } | { preview: WebsiteSalesPreviewTarget }
) & { sourceGrantId: string }>;
export async function assertStudioAcceptedTransfer(
  tx: TenantTransaction, proof: StudioTransferBinding, authority: StudioSalesSourceAuthority,
) {
  const fail = () => { throw new CrmCommandError("STUDIO_SOURCE_TRANSFER_UNCONFIRMED", "Studio transfer is not confirmed for this project.", 409); };
  if (!bindingIsValid(proof) || !uuid.test(authority.sourceGrantId)) return fail();
  const preview = "preview" in authority;
  if (preview ? !isWebsiteSalesPreviewTarget(authority.preview) : !uuid.test(authority.workloadId)) return fail();
  const ready = await tx.queryOne<{ ready: boolean }>(
    preview
      ? "select to_regprocedure('public.crm_studio_preview_source_transfer_matches(uuid,text,text,uuid,uuid,uuid,integer,text,uuid,uuid)') is not null as ready"
      : "select to_regprocedure('public.crm_studio_source_transfer_matches(uuid,uuid,uuid,uuid,uuid,integer,text,uuid,uuid)') is not null as ready");
  if (!ready?.ready) return fail();
  const binding = [proof.workspaceId, proof.crmProjectId, proof.operationId, proof.revision, proof.payloadHash, proof.leadId,
    proof.submissionId, websiteSalesFormId];
  type Match = { matched: boolean; dealId: string | null; contactId: string | null };
  const result = preview
    ? await tx.queryOne<Match>(
      `select public.crm_studio_preview_source_transfer_matches($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7::integer,$8,$9::uuid,$10::uuid) as matched,
        s.deal_id as "dealId", s.contact_id as "contactId"
        from public.form_submissions s where s.workspace_id = $4::uuid and s.project_id = $5::uuid
          and s.lead_id = $9::uuid and s.id = $10::uuid and s.form_id = $11::uuid and s.mode = 'live'`,
      [authority.sourceGrantId, authority.preview.deploymentId, authority.preview.revision, ...binding])
    : await tx.queryOne<Match>(
      `select public.crm_studio_source_transfer_matches($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::integer,$7,$8::uuid,$9::uuid) as matched,
      s.deal_id as "dealId", s.contact_id as "contactId"
      from public.form_submissions s where s.workspace_id = $3::uuid and s.project_id = $4::uuid
        and s.lead_id = $8::uuid and s.id = $9::uuid and s.form_id = $10::uuid and s.mode = 'live'`,
      [authority.workloadId, authority.sourceGrantId, ...binding]);
  // A confirmed Lead-only intake deliberately has no Deal. Only that exact NULL
  // shape is eligible for creation by the separately authorized READY qualify.
  if (result?.matched !== true || (result.dealId !== null && !uuid.test(result.dealId)) ||
    !result.contactId || !uuid.test(result.contactId)) return fail();
  return { dealId: result.dealId, contactId: result.contactId };
}

const sourceSql = `
  with principal as materialized (
    select id from public.crm_authenticate_autonomous_workload($7,$8,$9,$10,$11,$12::uuid,$13)
    where $1 = 'production' and workspace_id = $12::uuid and identity_id = 'EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY'
    union all select null::uuid where $1 = 'preview'
  ), gate as materialized (
    select p.id, v.grant_id, v.after_seq from principal p
    cross join lateral public.crm_studio_source_position($1,p.id,$2,$3,$4,$5) v
    where clock_timestamp() < to_timestamp($17::double precision)
    and exists (select 1 from public.workspace_users a where a.workspace_id = $12::uuid
      and a.id = $14::uuid and a.status = 'active' and a.role = 'agent' and a.product_role = 'novalure_operator')
    and exists (select 1 from public.forms f where f.workspace_id = $12::uuid
      and f.id = $15::uuid and f.project_id = $16::uuid and f.status = 'aktiv')
  ), candidates as materialized (
    select t.operation_id, t.revision, t.payload_hash, t.workspace_id, t.lead_id, t.submission_id, t.accepted_at, t.source_seq
    from gate g join public.studio_enquiry_transfers t on t.workspace_id = $12::uuid and t.source_seq > g.after_seq
    where t.state = 'accepted' and t.snapshot_text::jsonb->'syntheticTest' = 'false'::jsonb
    order by t.source_seq limit ($6::integer + 1)
  ), page as materialized (
    select c.*, l.id is not null and s.id is not null as scope_valid
    from (select * from candidates order by source_seq limit $6::integer) c
    left join public.leads l on l.workspace_id = c.workspace_id and l.id = c.lead_id and l.project_id = $16::uuid
    left join public.form_submissions s on s.workspace_id = c.workspace_id and s.id = c.submission_id
      and s.lead_id = c.lead_id and s.form_id = $15::uuid and s.project_id = $16::uuid and s.mode = 'live'
  )
  select coalesce((select jsonb_agg(jsonb_build_object(
    'state','accepted', 'operationId',operation_id, 'revision',revision, 'payloadHash',payload_hash,
    'workspaceId',workspace_id, 'crmProjectId',$16::uuid, 'leadId',lead_id, 'submissionId',submission_id,
    'acceptedAt',to_char(accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'syntheticTest',false
  ) order by source_seq) from page), '[]'::jsonb) as events,
  coalesce((select bool_and(scope_valid) from page), true) as "scopeValid",
  (select v.next_cursor from public.crm_studio_source_position($1,g.id,$2,$3,$4,$5,
      (select max(source_seq) from page)) v) as "nextCursor",
  (select count(*) > $6::integer from candidates) as "hasMore", g.grant_id as "sourceGrantId"
  from gate g`;

export async function readStudioSource(request: Request, options: ReaderOptions = {}): Promise<Response> {
  const env = options.env ?? process.env;
  if (env.CRM_STUDIO_SOURCE_ENABLED !== "1") return Response.json({ code: "STUDIO_SOURCE_DISABLED" }, { status: 503, headers });
  try {
    const receiver = readerReceiver(request, env);
    const bearer = getCrmMachineBearer(request.headers);
    const credential = request.headers.get("x-evelyn-studio-source") ?? "";
    if (!bearer || !/^[a-zA-Z0-9_-]{43}$/.test(credential) ||
      Buffer.from(credential, "base64url").toString("base64url") !== credential) denied();
    const claims = receiver.profile === "production" ? await verifyCrmMachineToken(bearer, options) : null;
    if (claims && claims.workspaceId !== scope.workspaceId) denied();
    const expiresAt = claims?.expiresAt ?? await verifyPreviewSource(bearer, options);

    const input = await readKnowledgeJson(request, ["cursor", "limit"], 256).catch(() => null);
    const cursor = input?.cursor;
    const limit = input?.limit;
    if (!input || (cursor !== null && (typeof cursor !== "string" || !cursorPattern.test(cursor))) ||
      typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      return Response.json({ code: "STUDIO_SOURCE_INVALID_PAGE" }, { status: 400, headers });
    }
    const credentialDigest = createHash("sha256").update(credential, "ascii").digest("hex");
    const rows = await withPublicSubmissionTransaction(scope, async () => {
      const [stage] = await queryRows<{ ready: boolean }>(
        "select to_regprocedure('public.crm_studio_source_position(text,uuid,text,text,text,text,bigint)') is not null as ready");
      if (!stage?.ready) throw new Error("STUDIO_SOURCE_STAGE_REQUIRED");
      return queryRows<PageRow>(sourceSql, [
        receiver.profile, receiver.deploymentId, receiver.revision, credentialDigest, cursor, limit,
        claims?.issuer ?? null, claims?.audience ?? null, claims?.projectId ?? null, claims?.ownerId ?? null,
        claims?.subject ?? null, CRM_MACHINE_WORKSPACE_ID, claims?.environment ?? null,
        scope.actorId, websiteSalesFormId, studioEnquiryCrmProject, expiresAt,
      ]);
    }, { readOnly: true, pool: options.pool });
    if (rows.length !== 1) denied();
    const page = rows[0];
    if (!page.scopeValid || !uuid.test(page.sourceGrantId) || !Array.isArray(page.events) || !page.events.every(isAcceptedTransfer) ||
      page.events.length > limit || typeof page.hasMore !== "boolean" ||
      (page.events.length ? typeof page.nextCursor !== "string" || !cursorPattern.test(page.nextCursor) : page.nextCursor !== null)) {
      return Response.json({ code: "STUDIO_SOURCE_PAGE_UNCONFIRMED" }, { status: 409, headers });
    }
    return Response.json({
      events: page.events, nextCursor: page.nextCursor, hasMore: page.hasMore, sourceGrantId: page.sourceGrantId,
      receiverRevision: receiver.revision, receiverDeploymentId: receiver.deploymentId,
    }, { headers });
  } catch (error) {
    const forbidden = error instanceof CrmMachineAuthError;
    return Response.json({ code: forbidden ? "STUDIO_SOURCE_DENIED" : "STUDIO_SOURCE_UNAVAILABLE" },
      { status: forbidden ? error.status : 503, headers });
  }
}
