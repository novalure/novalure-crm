import { createHash } from "node:crypto";
import { get, issueSignedToken, presignUrl } from "@vercel/blob";
import { queryOne, queryRows, resolveDatabaseUrl, withPublicSubmissionTransaction } from "@/lib/db/client";
import { persistWebsiteFormSubmission } from "@/lib/db/form-repositories";
import { hasExpectedMediaMagicBytes } from "@/lib/media-security";
import { workspaceImageQuotaBytes } from "@/lib/media-store";
import { websiteSalesActorId, websiteSalesFormId, websiteSalesWorkspaceId } from "@/lib/website-sales-ingestion";
import { StudioEnquiryError, studioEnquiryBranch, studioEnquiryHash, studioEnquiryProject,
  studioEnquiryProductionOrigin, studioEnquiryStudioOrigin, studioEnquiryStudioProject, studioEnquiryCrmProject,
  type StudioEnquiryFile, type StudioEnquiryRequest, type StudioEnquirySnapshot } from "@/lib/studio-enquiry-contract";

export type EnquiryTarget = { sourceId: string; variant: "original" | "analysis"; assetId: string; sha256: string; pathname: string; mime: string; bytes: number; name: string };
type Transfer = {
  operationId: string; revision: number; payloadHash: string; snapshotText: string; targets: EnquiryTarget[];
  state: "reserved" | "accepted"; reference: string; leadId: string | null; submissionId: string | null;
};
export type EnquiryPrivateStore = {
  read(target: EnquiryTarget): Promise<{ data: Buffer; contentType: string } | null>;
  grant(target: EnquiryTarget): Promise<{ url: string; headers: Record<string, string> }>;
};
const scope = { workspaceId: websiteSalesWorkspaceId, actorId: websiteSalesActorId };
const selection = `operation_id as "operationId", revision, payload_hash as "payloadHash", snapshot_text as "snapshotText",
  targets, state, reference, lead_id as "leadId", submission_id as "submissionId"`;

/** Trusted operator configuration, never a request-selected database or tenant. */
export function studioEnquiryProductionBinding(env: NodeJS.ProcessEnv = process.env) {
  if (env.VERCEL !== "1" || env.VERCEL_ENV !== "production" || env.VERCEL_PROJECT_ID !== studioEnquiryProject ||
      env.STUDIO_PUBLIC_ENQUIRY_ENABLED !== "1" || !env.STUDIO_PUBLIC_ENQUIRY_APPROVAL_ID?.trim() ||
      env.STUDIO_PUBLIC_ENQUIRY_CRM_PROJECT_ID !== studioEnquiryProject ||
      env.STUDIO_PUBLIC_ENQUIRY_CRM_ORIGIN !== studioEnquiryProductionOrigin ||
      env.STUDIO_PUBLIC_ENQUIRY_STUDIO_PROJECT_ID !== studioEnquiryStudioProject ||
      env.STUDIO_PUBLIC_ENQUIRY_STUDIO_ORIGIN !== studioEnquiryStudioOrigin ||
      !/^[a-f0-9]{40}$/.test(env.STUDIO_PUBLIC_ENQUIRY_RELEASE_SHA || "") ||
      env.STUDIO_PUBLIC_ENQUIRY_RELEASE_SHA !== env.VERCEL_GIT_COMMIT_SHA ||
      !env.STUDIO_ENQUIRY_SIGNING_SECRET || Buffer.byteLength(env.STUDIO_ENQUIRY_SIGNING_SECRET) < 32) return null;
  const host = env.STUDIO_PUBLIC_ENQUIRY_DATABASE_HOST?.trim().toLowerCase();
  const name = env.STUDIO_PUBLIC_ENQUIRY_DATABASE_NAME?.trim(), role = env.STUDIO_PUBLIC_ENQUIRY_DATABASE_ROLE?.trim();
  const project = env.STUDIO_PUBLIC_ENQUIRY_NEON_PROJECT_ID?.trim(), branch = env.STUDIO_PUBLIC_ENQUIRY_NEON_BRANCH_ID?.trim();
  const store = env.STUDIO_PUBLIC_ENQUIRY_BLOB_STORE_ID?.trim();
  const credential = privateTokenOrEmpty(env);
  if (!env.DATABASE_URL || !host || !host.includes("-pooler.") || !name || !role || !project || !branch ||
      !store || !/^store_[A-Za-z0-9]+$/.test(store) || store !== env.NOVALURE_PRIVATE_BLOB_STORE_ID?.trim() ||
      !credential.startsWith("vercel_blob_rw_") || credential.split("_")[3] !== store.slice(6)) return null;
  try {
    const url = new URL(resolveDatabaseUrl(env));
    if (!/^postgres(?:ql)?:$/.test(url.protocol) || url.hostname.toLowerCase() !== host ||
        (url.port && url.port !== "5432") || [...url.searchParams.keys()].some(key =>
          ["host", "hostaddr", "port", "user", "dbname", "database"].includes(key.toLowerCase())) ||
        decodeURIComponent(url.pathname.slice(1)) !== name || decodeURIComponent(url.username) !== role) return null;
  } catch { return null; }
  return { host, name, role, project, branch, store };
}
async function studioEnquiryProductionTargetVerified(env: NodeJS.ProcessEnv) {
  const binding = studioEnquiryProductionBinding(env); if (!binding) return false;
  try {
    const actual = await withPublicSubmissionTransaction(scope, () => queryOne<{ project: string; branch: string; name: string; role: string; ready: boolean }>(
      `select current_setting('neon.project_id',true) as project, current_setting('neon.branch_id',true) as branch,
        current_database() as name, current_user as role,
        (exists(select 1 from pg_constraint where conrelid=to_regclass('public.studio_enquiry_transfers')
          and conname='studio_enquiry_snapshot_synthetic_marker_boolean' and convalidated)
         and (select count(*)=2 from pg_class where oid in (to_regclass('public.studio_enquiry_transfers'),to_regclass('public.studio_enquiry_assets'))
           and relrowsecurity and relforcerowsecurity)
         and exists(select 1 from workspace_users where id=$1::uuid and workspace_id=$2::uuid
           and status='active' and role='agent' and product_role='novalure_operator')
         and exists(select 1 from forms where id=$3::uuid and workspace_id=$2::uuid and project_id=$4::uuid and status='aktiv')) as ready`,
      [websiteSalesActorId, websiteSalesWorkspaceId, websiteSalesFormId, studioEnquiryCrmProject]), { readOnly: true });
    return actual?.project === binding.project && actual.branch === binding.branch && actual.name === binding.name &&
      actual.role === binding.role && actual.ready === true;
  } catch { return false; }
}
/** Preview retains its original isolated target guard; Production has a separate exact binding. */
export async function studioEnquiryTargetVerified(env: NodeJS.ProcessEnv = process.env) {
  if (env.VERCEL_ENV === "production") return studioEnquiryProductionTargetVerified(env);
  if (env.VERCEL !== "1" || env.VERCEL_ENV !== "preview" || env.VERCEL_PROJECT_ID !== studioEnquiryProject ||
      env.STUDIO_ENQUIRY_QA_CRM_PROJECT_ID !== studioEnquiryProject || env.VERCEL_GIT_COMMIT_REF !== studioEnquiryBranch ||
      env.STUDIO_ENQUIRY_QA_ENABLED !== "1" || !env.STUDIO_ENQUIRY_QA_APPROVAL_ID?.trim()) return false;
  const configured = resolveDatabaseUrl(env);
  const qa = env.NOVALURE_QA_DATABASE_URL?.trim().replace(/^['"]|['"]$/g, "");
  const host = env.NOVALURE_QA_DATABASE_HOST?.trim().toLowerCase();
  const production = env.NOVALURE_PRODUCTION_DATABASE_HOST?.trim().toLowerCase();
  const project = env.NOVALURE_QA_PROJECT_ID?.trim(), branch = env.NOVALURE_QA_BRANCH_ID?.trim();
  const name = env.NOVALURE_QA_DATABASE_NAME?.trim(), role = env.NOVALURE_QA_DATABASE_ROLE?.trim();
  if (!env.DATABASE_URL || !configured || configured !== qa || !host || !production || host === production ||
      !project || !branch || !name || !role) return false;
  try {
    const u = new URL(configured);
    if (!/^postgres(?:ql)?:$/.test(u.protocol) || u.hostname.toLowerCase() !== host || !host.includes("-pooler.") ||
        decodeURIComponent(u.pathname.slice(1)) !== name || decodeURIComponent(u.username) !== role) return false;
    const actual = await withPublicSubmissionTransaction(scope, () => queryOne<{ project: string; branch: string; name: string; role: string; ready: boolean }>(
      `select current_setting('neon.project_id',true) as project, current_setting('neon.branch_id',true) as branch,
        current_database() as name, current_user as role,
        (to_regclass('public.studio_enquiry_transfers') is not null and to_regclass('public.studio_enquiry_assets') is not null
         and exists(select 1 from workspace_users where id=$1::uuid and workspace_id=$2::uuid
           and status='active' and role='agent' and product_role='novalure_operator')) as ready`,
      [websiteSalesActorId, websiteSalesWorkspaceId]), { readOnly: true });
    return actual?.project === project && actual.branch === branch && actual.name === name && actual.role === role && actual.ready === true;
  } catch { return false; }
}

function deterministicUuid(value: string) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function studioEnquiryTargets(request: StudioEnquiryRequest): EnquiryTarget[] {
  return request.snapshot.files.flatMap(file => (["original", "analysis"] as const).map(variant => {
    const content = variant === "original" ? file.original : file;
    // Identical PDF/original bytes share an object; both immutable source roles remain explicit.
    const assetId = deterministicUuid(`studio-enquiry-asset-v1/${websiteSalesWorkspaceId}/${request.operationId.toLowerCase()}/${file.id.toLowerCase()}/${content.mime}/${content.bytes}/${content.sha256}`);
    const extensions: Record<string,string> = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
    return { sourceId: file.id, variant, assetId, sha256: content.sha256, mime: content.mime, bytes: content.bytes, name: file.name,
      pathname: `${websiteSalesWorkspaceId}/studio-enquiries/${request.operationId.toLowerCase()}/${assetId}${extensions[content.mime]}` };
  }));
}
function privateTokenOrEmpty(env: NodeJS.ProcessEnv) {
  return env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN?.trim() || env.BLOB_PRIVATE_READ_WRITE_TOKEN?.trim() || "";
}
function privateToken(env: NodeJS.ProcessEnv) {
  const token = privateTokenOrEmpty(env);
  if (!token) throw new StudioEnquiryError("private_storage_unavailable", 503);
  return token;
}
export function studioEnquiryPrivateStore(env: NodeJS.ProcessEnv = process.env,
  { readBlob = get, issue = issueSignedToken, sign = presignUrl }: {
    readBlob?: typeof get; issue?: typeof issueSignedToken; sign?: typeof presignUrl;
  } = {}): EnquiryPrivateStore {
  const token = privateToken(env);
  const configuredStore = env.NOVALURE_PRIVATE_BLOB_STORE_ID?.trim();
  if (!configuredStore || !/^store_[A-Za-z0-9]+$/.test(configuredStore) ||
      !token.startsWith("vercel_blob_rw_") || token.split("_")[3] !== configuredStore.slice(6)) {
    throw new StudioEnquiryError("private_storage_unavailable", 503);
  }
  return {
    async read(target) {
      const blob = await readBlob(target.pathname, { token, storeId: configuredStore, access: "private", useCache: false,
        headers: { "accept-encoding": "identity" }, abortSignal: AbortSignal.timeout(15_000) });
      if (!blob || blob.statusCode !== 200) return null;
      const chunks: Buffer[] = []; let length = 0;
      const reader = blob.stream.getReader();
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          length += next.value.length;
          if (length > target.bytes || length > 10_000_000) { await reader.cancel(); throw new StudioEnquiryError("copied_file_mismatch", 409); }
          chunks.push(Buffer.from(next.value));
        }
      } finally { reader.releaseLock(); }
      return { data: Buffer.concat(chunks), contentType: blob.blob.contentType };
    },
    async grant(target) {
      const validUntil = Date.now() + 120_000;
      const signed = await issue({ token, storeId: configuredStore, pathname: target.pathname, operations: ["put"], validUntil,
        allowedContentTypes: [target.mime], maximumSizeInBytes: target.bytes });
      const payload: unknown = JSON.parse(Buffer.from(signed.delegationToken.split(".")[0], "base64url").toString("utf8"));
      const storeId = payload && typeof payload === "object" && "storeId" in payload && typeof payload.storeId === "string"
        ? payload.storeId.replace(/^store_/, "") : "";
      if (!/^[A-Za-z0-9]+$/.test(storeId) || storeId !== configuredStore.slice(6)) throw new StudioEnquiryError("private_storage_unavailable", 503);
      const result = await sign(signed, { access: "private", operation: "put", pathname: target.pathname,
        validUntil, allowedContentTypes: [target.mime], maximumSizeInBytes: target.bytes,
        addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 60 });
      const u = new URL(result.presignedUrl);
      if (u.protocol !== "https:" || u.hostname !== "vercel.com" || u.port || u.username || u.password ||
          u.pathname !== "/api/blob/" || u.searchParams.get("pathname") !== target.pathname) {
        throw new StudioEnquiryError("private_storage_unavailable", 503);
      }
      return { url: result.presignedUrl, headers: { "Content-Type": target.mime, "x-content-type": target.mime,
        "x-content-length": String(target.bytes), "x-vercel-blob-access": "private", "x-vercel-blob-store-id": storeId,
        "x-api-version": "13" } };
    },
  };
}
async function lockedTransfer(request: StudioEnquiryRequest, create = false) {
  await queryRows("select pg_advisory_xact_lock(hashtextextended($1,0))", [`studio-enquiry:${websiteSalesWorkspaceId}:${request.operationId.toLowerCase()}`]);
  let row = await queryOne<Transfer>(`select ${selection} from studio_enquiry_transfers
    where workspace_id=$1::uuid and operation_id=$2::uuid for update`, [websiteSalesWorkspaceId, request.operationId]);
  const snapshotText = JSON.stringify(request.snapshot);
  if (!row && create) {
    row = await queryOne<Transfer>(`insert into studio_enquiry_transfers
      (operation_id,workspace_id,revision,payload_hash,snapshot_text,targets,reference)
      values($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7) returning ${selection}`,
      [request.operationId, websiteSalesWorkspaceId, request.revision, request.payloadHash, snapshotText,
        JSON.stringify(studioEnquiryTargets(request)), `NL-${studioEnquiryHash(request.operationId.toLowerCase()).slice(0,8).toUpperCase()}`]);
  }
  if (!row) throw new StudioEnquiryError("enquiry_not_reserved", 404);
  if (row.payloadHash !== request.payloadHash || row.revision !== request.revision || row.snapshotText !== snapshotText) {
    throw new StudioEnquiryError("enquiry_conflict", 409);
  }
  return row;
}
async function loadTransfer(request: StudioEnquiryRequest, create = false) {
  return withPublicSubmissionTransaction(scope, () => lockedTransfer(request, create));
}
export function verifyStudioCopiedFile(target: EnquiryTarget, entry: { data: Buffer; contentType: string } | null) {
  if (!entry) throw new StudioEnquiryError("files_not_copied", 409);
  if (entry.data.length !== target.bytes || studioEnquiryHash(entry.data) !== target.sha256 ||
      entry.contentType.split(";")[0].trim().toLowerCase() !== target.mime ||
      !hasExpectedMediaMagicBytes(entry.data.subarray(0, 64), target.mime)) throw new StudioEnquiryError("copied_file_mismatch", 409);
}
function receipt(row: Transfer) {
  if (row.state !== "accepted" || !row.leadId || !row.submissionId) throw new StudioEnquiryError("enquiry_not_confirmed", 503);
  return { accepted: true, reference: row.reference, crmLeadId: row.leadId, formSubmissionId: row.submissionId,
    workspaceId: websiteSalesWorkspaceId, operationId: row.operationId, revision: row.revision, payloadHash: row.payloadHash,
    attachments: row.targets.map(t => ({ sourceId: t.sourceId, variant: t.variant, assetId: t.assetId, sha256: t.sha256 })) };
}
const transmitted = (row: Transfer) => ({ status: "transmitted" as const, operationId: row.operationId,
  revision: row.revision, payloadHash: row.payloadHash, targets: [], receipt: receipt(row) });
function formInput(snapshot: StudioEnquirySnapshot) {
  const values = snapshot.brief.values, form = new FormData();
  const fields: Record<string, string> = { name: values.name || "", email: values.email || "", phone: values.phone || "",
    company: values.company || "", message: snapshot.brief.summary, package_interest: "UNDECIDED",
    current_website_url: values.existingUrl || "", privacy: "true", synthetic_test: String(snapshot.syntheticTest) };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}
async function persistTarget(target: EnquiryTarget, file: StudioEnquiryFile, request: StudioEnquiryRequest, stored: Set<string>) {
  if (!stored.has(target.assetId)) await queryRows(`insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,
    relative_path,storage_provider,storage_access,alt,is_public,public_token,studio_enquiry_operation_id)
    values($1::uuid,$2,$3,$3,$4,$5,$6,$7,$8,'vercel-blob','private',$3,false,null,$9::uuid)`,
    [target.assetId, websiteSalesWorkspaceId, target.name, `studio-enquiries/${request.operationId.toLowerCase()}`,
      target.mime, target.bytes, `/api/media/files/${target.assetId}`, target.pathname, request.operationId]);
  stored.add(target.assetId);
  await queryRows(`insert into studio_enquiry_assets(operation_id,workspace_id,source_id,variant,media_asset_id,sha256,original_sha256)
    values($1::uuid,$2,$3::uuid,$4,$5::uuid,$6,$7)`,
    [request.operationId, websiteSalesWorkspaceId, target.sourceId, target.variant, target.assetId, target.sha256, file.originalSha256]);
}
/** Only server-owned validated requests enter here; material text never selects actions or scope. */
export async function executeStudioEnquiry(request: StudioEnquiryRequest, { store = studioEnquiryPrivateStore() }: { store?: EnquiryPrivateStore } = {}) {
  const row = await loadTransfer(request, request.action === "reserve");
  if (row.state === "accepted") return transmitted(row);
  if (request.action !== "finalize") {
    const targets = [], inspected = new Map<string, { existing: boolean; put?: { url: string; headers: Record<string,string> } }>();
    for (const target of row.targets) {
      let checked = inspected.get(target.pathname);
      if (!checked) {
        const existing = await store.read(target);
        if (existing) verifyStudioCopiedFile(target, existing);
        checked = { existing: Boolean(existing), ...(!existing && request.action === "reserve" ? { put: await store.grant(target) } : {}) };
        inspected.set(target.pathname, checked);
      }
      targets.push({ sourceId: target.sourceId, variant: target.variant, assetId: target.assetId, sha256: target.sha256, pathname: target.pathname,
        status: checked.existing ? "copied" as const : "upload_required" as const, ...(checked.put ? { put: checked.put } : {}) });
    }
    return { status: "reserved" as const, operationId: row.operationId, revision: row.revision, payloadHash: row.payloadHash, targets };
  }
  const checkedPaths = new Set<string>();
  for (const target of row.targets) if (!checkedPaths.has(target.pathname)) {
    verifyStudioCopiedFile(target, await store.read(target)); checkedPaths.add(target.pathname);
  }
  // Object writes are immutable. DB publication is a separate all-or-nothing transaction.
  // A failed or uncertain COMMIT leaves the reserved objects for same-key reconciliation.
  try {
    const completed = await withPublicSubmissionTransaction(scope, async () => {
      const current = await lockedTransfer(request);
      if (current.state === "accepted") return current;
      await queryRows("select pg_advisory_xact_lock(hashtextextended($1,0))", [`studio-enquiry-media-quota:${websiteSalesWorkspaceId}`]);
      const usage = await queryOne<{ bytes: string }>("select coalesce(sum(size_bytes),0)::text as bytes from media_assets where workspace_id=$1", [websiteSalesWorkspaceId]);
      const uniqueTargets = [...new Map(current.targets.map(t => [t.assetId,t])).values()];
      if (Number(usage?.bytes || 0) + uniqueTargets.reduce((n, t) => n + t.bytes, 0) > workspaceImageQuotaBytes) {
        throw new StudioEnquiryError("workspace_storage_limit", 409);
      }
      const persisted = await persistWebsiteFormSubmission({ actorUserId: websiteSalesActorId, formKey: websiteSalesFormId,
        formData: formInput(request.snapshot), requestUrl: "https://novalurestudio.ie/", preserveProvidedIdentity: true,
        studioSyntheticTest: request.snapshot.syntheticTest });
      if (!persisted.persisted || !persisted.ids?.leadId || !persisted.ids.submissionId) throw new StudioEnquiryError("crm_persistence_unconfirmed", 503);
      const stored = new Set<string>();
      for (const target of current.targets) {
        const source = request.snapshot.files.find(f => f.id === target.sourceId);
        if (!source) throw new StudioEnquiryError("enquiry_conflict", 409);
        await persistTarget(target, source, request, stored);
      }
      const confirmation = { operationId: request.operationId, revision: request.revision, payloadHash: request.payloadHash,
        snapshot: request.snapshot, attachments: current.targets.map(t => ({ sourceId: t.sourceId, variant: t.variant, assetId: t.assetId, sha256: t.sha256 })) };
      const lead = await queryOne<{ id: string }>(`update leads set metadata=metadata || jsonb_build_object('studioEnquiry',$3::jsonb)
        where workspace_id=$1::uuid and id=$2::uuid returning id`, [websiteSalesWorkspaceId, persisted.ids.leadId, JSON.stringify(confirmation)]);
      if (!lead) throw new StudioEnquiryError("crm_persistence_unconfirmed", 503);
      const accepted = await queryOne<Transfer>(`update studio_enquiry_transfers set state='accepted',lead_id=$3::uuid,
        submission_id=$4::uuid,accepted_at=now() where workspace_id=$1::uuid and operation_id=$2::uuid returning ${selection}`,
        [websiteSalesWorkspaceId, request.operationId, persisted.ids.leadId, persisted.ids.submissionId]);
      if (!accepted) throw new StudioEnquiryError("crm_persistence_unconfirmed", 503);
      return accepted;
    });
    return transmitted(completed);
  } catch (error) {
    // A timeout after COMMIT never causes a second Lead or new object path.
    try { const actual = await loadTransfer(request); if (actual.state === "accepted") return transmitted(actual); } catch { /* Fail closed below. */ }
    throw error;
  }
}
