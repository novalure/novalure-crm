import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { POST as postEvelynContractRoute } from "../src/app/api/crm/evelyn-contracts/route";
import type { AppSession } from "../src/lib/auth/session";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { TenantPool } from "../src/lib/db/tenant-client";
import {
  createEvelynContractAction,
  requestEvelynContractApproval,
  type EvelynContractOptions,
} from "../src/lib/db/evelyn-contract-repositories";
import {
  createEvelynContractActionV2,
  executeEvelynContractActionV2,
  getEvelynContractActionV2,
  requestEvelynContractApprovalV2,
  reviseEvelynContractActionV2,
  verifyEvelynContractApprovalV2,
  type EvelynContractV2Options,
} from "../src/lib/db/evelyn-contract-v2-repositories";
import {
  getOfferFinancialSnapshot,
  registerFinancialPolicyVersion,
  type ContractFinancialPolicySelection,
} from "../src/lib/db/financial-snapshot-repositories";
import {
  executeOfferCommand,
  getOfferWorkflow,
  type OfferCommand,
} from "../src/lib/db/offer-repositories";
import {
  EvelynApprovalError,
  type EvelynApprovalClient,
  type EvelynApprovalV2Client,
  type EvelynCreateApprovalRequest,
  type EvelynCreateApprovalRequestV2,
} from "../src/lib/evelyn-approval-client";
import {
  approvalActionV2Hash,
  financialSnapshotHash,
  v2ThresholdContext,
} from "../src/lib/evelyn-money-tax-v2";
import {
  buildLegacyNeedsReviewSnapshot,
  financialPolicyContentHash,
  type FinancialPolicyPayload,
} from "../src/lib/financial-snapshot";
import { createCsrfToken } from "../src/lib/security/csrf-core";
import { applySalesSchema, startLocalSalesDb } from "./lib/local-sales-db.mjs";

const INSTANT = "2026-09-18T12:00:00.000Z";
const WORKDIR = process.cwd();
const denied = (code: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
  && (error as { code: unknown }).code === code);
const sqlCode = (code: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
  && (error as { code: unknown }).code === code);

type LocalDb = Awaited<ReturnType<typeof startLocalSalesDb>>;
type ApprovalRecord = { reference: string; request: EvelynCreateApprovalRequestV2 };
type RegisteredRequest = EvelynCreateApprovalRequest | EvelynCreateApprovalRequestV2;
type Registration = { reference: string; request: RegisteredRequest };

function approvalHarness() {
  const approvals = new Map<string, ApprovalRecord>();
  const receipts = new Map<string, Registration>();
  const currentByAction = new Map<string, Registration>();
  const valid = new Set<string>();
  const calls = { requests: 0, verifies: 0 };
  let onVerify: (() => Promise<void>) | undefined;
  let requestFailure: string | undefined;
  // Mirror the reviewed Evelyn service.ts origin and contiguous-version guards.
  // This remains a simulated local service, never evidence of a live bridge call.
  function register(request: RegisteredRequest): Registration {
    if (requestFailure) throw new EvelynApprovalError(requestFailure);
    const receipt = receipts.get(request.requestId);
    if (receipt) {
      assert.deepEqual(request, receipt.request, "remote idempotency identity must bind identical bytes");
      return receipt;
    }
    const previous = currentByAction.get(request.action.actionId);
    if (previous) {
      const old = previous.request;
      if (old.contractVersion === "create-approval-request-v2" && request.contractVersion !== old.contractVersion) {
        throw new EvelynApprovalError("CONTRACT_DOWNGRADE_DENIED");
      }
      if (old.action.requestingActorId !== request.action.requestingActorId || old.action.workflowId !== request.action.workflowId
        || old.action.tenantId !== request.action.tenantId) throw new EvelynApprovalError("ACTION_ORIGIN_MISMATCH");
      if (old.action.actionVersion === request.action.actionVersion) {
        if (old.contractVersion !== request.contractVersion || old.actionHash !== request.actionHash
          || old.correlationId !== request.correlationId) throw new EvelynApprovalError("ACTION_VERSION_CONFLICT");
        assert.deepEqual(old.policyEvidence, request.policyEvidence);
        assert.deepEqual(old.policyReferences, request.policyReferences);
        receipts.set(request.requestId, previous);
        return previous;
      }
      if (request.action.actionVersion !== old.action.actionVersion + 1
        || request.action.resourceVersion !== old.action.resourceVersion + 1
        || (old.contractVersion === "create-approval-request-v2" && request.contractVersion === old.contractVersion
          && (old.action.financialSnapshot.snapshotId === request.action.financialSnapshot.snapshotId
            || old.action.financialSnapshotHash === request.action.financialSnapshotHash))) {
        throw new EvelynApprovalError("ACTION_VERSION_CONFLICT");
      }
      valid.delete(previous.reference);
    } else if (request.action.actionVersion !== 1) throw new EvelynApprovalError("ACTION_VERSION_CONFLICT");
    const registration = { reference: randomUUID(), request: structuredClone(request) };
    receipts.set(request.requestId, registration);
    currentByAction.set(request.action.actionId, registration);
    return registration;
  }
  const v1Client: EvelynApprovalClient = {
    async requestApproval(request) {
      calls.requests += 1;
      const registered = register(request);
      const requiredSteps = request.action.amount >= 500_000 ? 2 as const : 1 as const;
      return { contractVersion: "create-approval-request-v1", environment: "preview", approvalReference: registered.reference,
        actionId: request.action.actionId, actionVersion: request.action.actionVersion, actionHash: request.actionHash,
        requiredSteps, status: "PENDING", auditReference: randomUUID(), correlationId: request.correlationId };
    },
    async verifyApproval() { throw new Error("unexpected V1 verify"); },
  };
  const client: EvelynApprovalV2Client = {
    async requestApprovalV2(request) {
      calls.requests += 1;
      const threshold = v2ThresholdContext({ ...request.action, environment: "preview", synthetic: true });
      if (threshold.status === "POLICY_REQUIRED") throw new EvelynApprovalError("POLICY_REQUIRED");
      const requiredSteps = threshold.status === "NEEDS_REVIEW" ? null : threshold.atLeast5000 ? 2
        : request.policyEvidence.standardContract && request.policyEvidence.approvedOffer
          && request.policyEvidence.customerAccepted && request.policyEvidence.approvedTemplate ? 0 : 1;
      const registered = register(request);
      const approval = { reference: registered.reference, request: structuredClone(request) };
      approvals.set(request.requestId, approval);
      return {
        contractVersion: "create-approval-request-v2",
        environment: "preview",
        approvalReference: approval.reference,
        actionId: request.action.actionId,
        actionVersion: request.action.actionVersion,
        actionHash: request.actionHash,
        financialSnapshotHash: request.action.financialSnapshotHash,
        requiredSteps,
        status: requiredSteps === null ? "NEEDS_REVIEW" : requiredSteps === 0 ? "APPROVED" : "PENDING",
        auditReference: randomUUID(),
        correlationId: request.correlationId,
      };
    },
    async verifyApprovalV2(request) {
      calls.verifies += 1;
      await onVerify?.();
      const approval = [...approvals.values()].find(candidate => candidate.reference === request.approvalReference);
      if (!approval) throw new EvelynApprovalError("INVALID");
      if (currentByAction.get(request.actionId)?.reference !== approval.reference) throw new EvelynApprovalError("VERSION_MISMATCH");
      const created = approval.request;
      if (created.action.tenantId !== request.tenantId) throw new EvelynApprovalError("TENANT_MISMATCH");
      if (created.action.actionVersion !== request.actionVersion) throw new EvelynApprovalError("VERSION_MISMATCH");
      if (created.action.actionId !== request.actionId || created.action.resourceId !== request.resourceId
        || created.actionHash !== request.actionHash || created.action.financialSnapshotHash !== request.financialSnapshotHash
        || JSON.stringify(created.action.economicCommitment) !== JSON.stringify(request.economicCommitment)) {
        throw new EvelynApprovalError("ACTION_MISMATCH");
      }
      if (!valid.has(approval.reference)) throw new EvelynApprovalError("PENDING");
      return {
        contractVersion: "approval-bridge-v2",
        environment: "preview",
        status: "VALID",
        approvalReference: request.approvalReference,
        correlationId: request.correlationId,
      };
    },
  };
  return {
    client,
    v1Client,
    calls,
    approvals,
    approve(reference: string) { valid.add(reference); },
    onVerify(callback: (() => Promise<void>) | undefined) { onVerify = callback; },
    failRequests(code: string | undefined) { requestFailure = code; },
  };
}

function currencyPolicy(code = "EUR") {
  return {
    policySchemaVersion: "crm-currency-policy-v1" as const,
    kind: "CURRENCY" as const,
    standard: "ISO-4217" as const,
    code,
    minorUnitExponent: 2,
    verifiedAt: INSTANT,
  };
}

function roundingPolicy(mode: "HALF_EVEN" | "HALF_UP" = "HALF_EVEN") {
  return {
    policySchemaVersion: "crm-rounding-policy-v1" as const,
    kind: "ROUNDING" as const,
    mode,
    currencyExponent: 2,
    scope: "TAX_COMPONENT" as const,
  };
}

function taxPolicy(name: string, version: string, numerator: string, denominator: string) {
  return {
    policySchemaVersion: "crm-tax-policy-v1" as const,
    kind: "TAX" as const,
    jurisdiction: "AT:BUSINESS",
    treatment: `SYNTHETIC:${name}:treatment`,
    category: `SYNTHETIC:${name}:category`,
    rate: { basis: "NET" as const, numerator, denominator },
    sourceProvenance: {
      authority: "SYNTHETIC policy authority",
      sourceReference: `SYNTHETIC:${name}:source`,
      jurisdiction: "AT:BUSINESS",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      policyVersion: version,
      verifiedAt: INSTANT,
    },
  };
}

async function registerPolicy(
  db: LocalDb,
  session: AppSession,
  projectId: string,
  policyId: string,
  policyVersion: string,
  payload: FinancialPolicyPayload,
) {
  const result = await registerFinancialPolicyVersion(session, {
    projectId,
    policyId,
    policyVersion,
    payload,
    sourceReference: payload.kind === "TAX" ? payload.sourceProvenance.sourceReference
      : `SYNTHETIC source for ${policyId} ${policyVersion}`,
    verifiedAt: INSTANT,
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
  }, { pool: db.pool as unknown as TenantPool });
  assert.equal(result.data.contentHash, financialPolicyContentHash(payload));
  return { id: policyId, version: policyVersion };
}

async function fixture(db: LocalDb, options: {
  currency?: string;
  items?: Array<{ description: string; quantity: number; unitNetCents: number }>;
} = {}) {
  const workspaceId = randomUUID(), userId = randomUUID(), projectId = randomUUID();
  const organizationId = randomUUID(), contactId = randomUUID(), leadId = randomUUID(), dealId = randomUUID();
  const authSessionId = randomUUID(), correlationId = randomUUID();
  const sessionCookie = `v2.${randomBytes(32).toString("base64url")}`;
  await db.admin.query(
    "insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC G27 QA','novalure_internal','novalure_internal',$2::jsonb)",
    [workspaceId, JSON.stringify({ salesApprovalUserId: userId })],
  );
  const user = await db.admin.query(
    "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC G27 owner',$3,'owner','novalureAdmin','active') returning auth_identity_id",
    [userId, workspaceId, `${userId}@example.invalid`],
  );
  const authIdentityId = user.rows[0].auth_identity_id;
  await db.admin.query(
    "update auth_identities set credential_state='active',password_hash='SYNTHETIC G27 TEST ONLY',password_changed_at=now() where id=$1",
    [authIdentityId],
  );
  await db.admin.query(
    "insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '2 hours')",
    [authSessionId, createHash("sha256").update(sessionCookie).digest("hex"), authIdentityId, userId, workspaceId],
  );
  await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC G27 project','Service')", [projectId, workspaceId]);
  await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC company','Unternehmen')", [organizationId, workspaceId, projectId]);
  await db.admin.query(
    "insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,role,email,consent_label) values($1,$2,$3,$4,$5,'SYNTHETIC Buyer','Kunde','buyer@example.invalid','Opt-in')",
    [contactId, workspaceId, projectId, organizationId, userId],
  );
  await db.admin.query(
    "insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status) values($1,$2,$3,$4,$5,'Manual','Käufer','Neu')",
    [leadId, workspaceId, projectId, contactId, userId],
  );
  await db.admin.query(
    "insert into deals(id,workspace_id,project_id,contact_id,organization_id,lead_id,owner_user_id,name,stage,value_cents) values($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC G27 deal','Qualifizieren',1)",
    [dealId, workspaceId, projectId, contactId, organizationId, leadId, userId],
  );
  await db.admin.query("insert into crm_evelyn_preview_targets(workspace_id,project_id,evelyn_tenant_id) values($1,$2,$1)", [workspaceId, projectId]);
  const session = {
    authenticated: true,
    userId,
    workspaceId,
    workspaceName: "SYNTHETIC G27 QA",
    email: `${userId}@example.invalid`,
    name: "SYNTHETIC owner",
    role: "owner",
    permissions: ["crm:read", "crm:write"],
    productRole: "novalureAdmin",
    productPermissions: ["pipeline:write", "settings:manage", "novalure:internal"],
    source: "database",
    authIdentityId,
    authSessionId,
    sessionCreatedAt: new Date(),
  } as AppSession;
  const pool = { pool: db.pool as unknown as TenantPool };
  const offerCommand = async (operation: OfferCommand["operation"], payload: Record<string, unknown> = {}) => {
    const view = await getOfferWorkflow(session, dealId, pool);
    return executeOfferCommand(session, {
      operation,
      projectId,
      dealId,
      offerId: view.offer?.id,
      expectedVersion: view.offer?.version ?? view.dealVersion,
      payload,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    }, pool);
  };
  await offerCommand("create", { leadId, content: {
    subject: "SYNTHETIC G27 standard-value proposal",
    recipientName: "SYNTHETIC Buyer",
    recipientEmail: "buyer@example.invalid",
    terms: "SYNTHETIC scope; no real contract delivery",
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    currency: "EUR",
    taxBasis: "NET",
    items: options.items ?? [
      { description: "Setup", quantity: 1, unitNetCents: 990_000 },
      { description: "Monthly", quantity: 3, unitNetCents: 349_000 },
    ],
  } });
  let offer = (await getOfferWorkflow(session, dealId, pool)).offer!;
  await offerCommand("approve", { revision: offer.revision, contentDigest: offer.contentDigest,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  await offerCommand("queue_send");
  await db.admin.query("select pg_sleep(0.005)");
  await offerCommand("record_sent", { revision: offer.revision, contentDigest: offer.contentDigest,
    recipientEmail: offer.content.recipientEmail, reference: "SYNTHETIC manual receipt", sentAt: new Date().toISOString() });
  await offerCommand("accept", { revision: offer.revision, contentDigest: offer.contentDigest,
    reference: "SYNTHETIC customer accepted" });
  offer = (await getOfferWorkflow(session, dealId, pool)).offer!;

  const currency = await registerPolicy(db, session, projectId, `SYNTHETIC:currency:${options.currency ?? "EUR"}`, "1", currencyPolicy(options.currency));
  const rounding = await registerPolicy(db, session, projectId, "SYNTHETIC:rounding", "1", roundingPolicy());
  const primaryTax = await registerPolicy(db, session, projectId, "SYNTHETIC:tax:primary", "1", taxPolicy("primary", "1", "1", "5"));
  const surchargeTax = await registerPolicy(db, session, projectId, "SYNTHETIC:tax:surcharge", "1", taxPolicy("surcharge", "1", "1", "10"));
  const policySelection: ContractFinancialPolicySelection = {
    jurisdiction: "AT:BUSINESS",
    currencyPolicy: currency,
    roundingPolicy: rounding,
    taxPolicies: [
      { componentId: "primary", policy: primaryTax },
      { componentId: "surcharge", policy: surchargeTax },
    ],
  };
  const remote = approvalHarness();
  const v2Options: EvelynContractV2Options = {
    ...pool,
    testOnly: { target: { workspaceId, projectId, tenantId: workspaceId }, client: remote.client },
  };
  const v1Options: EvelynContractOptions = {
    ...pool,
    testOnly: { target: { workspaceId, projectId, tenantId: workspaceId }, client: remote.v1Client },
  };
  const createInput = {
    operation: "create" as const,
    approvalContractVersion: "v2" as const,
    projectId,
    offerId: offer.id,
    expectedOfferVersion: offer.version,
    policySelection,
    idempotencyKey: randomUUID(),
    correlationId,
  };
  return { db, workspaceId, userId, projectId, organizationId, contactId, leadId, dealId,
    session, sessionCookie, pool, offer, remote, v2Options, v1Options, policySelection, createInput };
}

function actionInput(created: { data: { actionId: string; actionVersion: number } }, correlationId: string) {
  return {
    actionId: created.data.actionId,
    expectedVersion: created.data.actionVersion,
    idempotencyKey: randomUUID(),
    correlationId,
  };
}

async function additionalEditor(db: LocalDb, session: AppSession): Promise<AppSession> {
  const userId = randomUUID(), authSessionId = randomUUID();
  const email = `${userId}@example.invalid`;
  const member = await db.admin.query(
    "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC second editor',$3,'owner','novalureAdmin','active') returning auth_identity_id",
    [userId, session.workspaceId, email],
  );
  const authIdentityId = member.rows[0].auth_identity_id;
  await db.admin.query(
    "update auth_identities set credential_state='active',password_hash='SYNTHETIC G27 TEST ONLY',password_changed_at=now() where id=$1",
    [authIdentityId],
  );
  await db.admin.query(
    "insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '2 hours')",
    [authSessionId, createHash("sha256").update(randomBytes(32)).digest("hex"), authIdentityId, userId, session.workspaceId],
  );
  return { ...session, userId, email, authIdentityId, authSessionId, name: "SYNTHETIC second editor" };
}

async function assertLineage(db: LocalDb, workspaceId: string, actionId: string, version: number,
  snapshots: number, absentCommandKey?: string) {
  assert.deepEqual((await db.admin.query(`
    select a.version,(select count(*)::int from crm_evelyn_contract_revisions r
      where r.workspace_id=a.workspace_id and r.action_id=a.id) as revisions,
      (select count(*)::int from crm_financial_snapshots s where s.workspace_id=a.workspace_id
        and s.resource_type='CONTRACT' and s.resource_id=a.id) as snapshots
    from crm_evelyn_contract_actions a where a.workspace_id=$1 and a.id=$2
  `, [workspaceId, actionId])).rows[0], { version, revisions: version, snapshots });
  if (absentCommandKey) assert.equal((await db.admin.query(
    "select count(*)::int count from crm_command_receipts where workspace_id=$1 and idempotency_key=$2",
    [workspaceId, absentCommandKey],
  )).rows[0].count, 0);
}

test("G27 Evelyn V2 workflow against real isolated PostgreSQL", { timeout: 300_000 }, async t => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousVercel = process.env.VERCEL;
  const previousVercelEnv = process.env.VERCEL_ENV;
  const previousVercelUrl = process.env.VERCEL_URL;
  Object.assign(process.env, { NODE_ENV: "test" });
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  const db = await startLocalSalesDb();
  try {
    const migrations = await applySalesSchema(db);
    assert.equal(migrations.at(-1), "087_crm_financial_snapshots.sql");

    await t.test("explicit policy authority builds 20,370 EUR complete snapshot with two tax components and hash parity", async () => {
      const f = await fixture(db);
      const forged = {
        ...f.createInput,
        amount: "1",
        totals: { net: "1", tax: "0", gross: "1" },
        taxMinorUnits: "0",
      };
      const created = await createEvelynContractActionV2(f.session, forged, f.v2Options);
      assert.equal(created.data.economicCommitment.amount?.minorUnits, "2037000");
      assert.equal(created.data.approvalContractVersion, "v2");
      const documentSnapshot = await getOfferFinancialSnapshot(f.session, f.offer.id, f.pool);
      assert.equal(documentSnapshot?.id, created.data.financialSnapshotId);
      assert.equal(documentSnapshot?.resourceType, "CONTRACT");
      assert.equal(documentSnapshot?.reviewState, "VERIFIED");
      const row = (await db.admin.query(`
        select r.action,r.action_hash,r.financial_snapshot_hash,s.canonical_snapshot,s.snapshot_hash,
          crm_financial_snapshot_hash(s.canonical_snapshot) as database_hash,s.review_state,
          s.supersedes_snapshot_id
        from crm_evelyn_contract_revisions r
        join crm_financial_snapshots s on s.workspace_id=r.workspace_id and s.id=r.financial_snapshot_id
        where r.workspace_id=$1 and r.action_id=$2 and r.version=1
      `, [f.workspaceId, created.data.actionId])).rows[0];
      assert.equal(row.review_state, "VERIFIED");
      assert.equal(row.canonical_snapshot.reviewState, "COMPLETE");
      assert.equal(row.canonical_snapshot.currency, "EUR");
      assert.equal(row.canonical_snapshot.totals.net.minorUnits, "2037000");
      assert.equal(row.canonical_snapshot.totals.tax.minorUnits, "611100");
      assert.equal(row.canonical_snapshot.totals.gross.minorUnits, "2648100");
      assert.ok(row.canonical_snapshot.components.every((component: { taxComponents: unknown[] }) => component.taxComponents.length === 2));
      assert.deepEqual(row.canonical_snapshot.components.map((component: { taxComponents: { componentId: string }[] }) =>
        component.taxComponents.map(tax => tax.componentId)), [
        ["line:001:tax:primary", "line:001:tax:surcharge"],
        ["line:002:tax:primary", "line:002:tax:surcharge"],
      ]);
      assert.equal(row.snapshot_hash, financialSnapshotHash(row.canonical_snapshot));
      assert.equal(row.snapshot_hash, row.database_hash);
      assert.equal(row.action_hash, approvalActionV2Hash({ ...row.action, environment: "preview", synthetic: true }));
      assert.equal(row.action.financialSnapshotHash, row.snapshot_hash);
      assert.deepEqual(row.action.financialSnapshot, row.canonical_snapshot);
      assert.equal(row.financial_snapshot_hash, row.snapshot_hash);
      assert.equal(row.supersedes_snapshot_id, null);
      const policyRows = (await db.admin.query(
        "select policy_kind,contract_payload,content_hash,crm_financial_policy_hash(contract_payload) database_hash from crm_financial_policy_versions where workspace_id=$1 order by policy_kind,policy_id",
        [f.workspaceId],
      )).rows;
      assert.equal(policyRows.length, 4);
      assert.deepEqual(new Set(policyRows.map(row => row.policy_kind)), new Set(["CURRENCY", "ROUNDING", "TAX"]));
      assert.ok(policyRows.every(row => row.content_hash === financialPolicyContentHash(row.contract_payload)
        && row.content_hash === row.database_hash));
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_events where workspace_id=$1 and snapshot_id=$2 and event_type='POLICY_BOUND'",
        [f.workspaceId, created.data.financialSnapshotId],
      )).rows[0].count, 4);
    });

    await t.test("strict HTTP source boundary excludes browser money and internal extras cannot override the locked offer", async () => {
      const route = readFileSync(`${WORKDIR}/src/app/api/crm/evelyn-contracts/route.ts`, "utf8");
      const repository = readFileSync(`${WORKDIR}/src/lib/db/evelyn-contract-v2-repositories.ts`, "utf8");
      const financialRepository = readFileSync(`${WORKDIR}/src/lib/db/financial-snapshot-repositories.ts`, "utf8");
      assert.match(route, /assertCrmFields\(input, fields\)/);
      assert.match(route, /approvalContractVersion === "v2" && \(operation === "create" \|\| operation === "revise"\)/);
      assert.doesNotMatch(route.match(/if \(operation === "create"\)[\s\S]*?assertCrmFields\(input, fields\)/)?.[0] ?? "", /amount|totals|taxMinorUnits|grossMinorUnits/);
      assert.match(financialRepository, /every amount comes from the locked server source/);
      assert.match(financialRepository, /calculatedNet !== input\.source\.totalNetMinorUnits/);
      assert.match(financialRepository, /jsonb_to_recordset\(\$3::jsonb\)/);
      assert.doesNotMatch(
        financialRepository.match(/async function resolvePolicySelection[\s\S]*?function mapSnapshotRow/)?.[0] ?? "",
        /limit 500/,
      );
      assert.match(repository, /totalNetMinorUnits: row\.total/);
      const f = await fixture(db);
      const created = await createEvelynContractActionV2(f.session, {
        ...f.createInput,
        amount: "999999999999999999",
        financialSnapshot: { totals: { net: { minorUnits: "1" } } },
      } as typeof f.createInput, f.v2Options);
      assert.equal(created.data.economicCommitment.amount?.minorUnits, "2037000");
    });

    await t.test("actual HTTP boundary rejects forged net, tax and gross before any durable V2 write", async () => {
      const f = await fixture(db);
      const keys = ["DATABASE_URL", "CRM_LOCAL_TEST_DATABASE", "NOVALURE_SESSION_SECRET", "NOVALURE_APP_ORIGIN",
        "NOVALURE_AUTH_STRICT", "NOVALURE_AUTH_ENCRYPTION_KEY", "NOVALURE_AUTH_RATE_LIMIT_SECRET", "VERCEL",
        "VERCEL_ENV", "VERCEL_TARGET_ENV", "VERCEL_PROJECT_ID"] as const;
      const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      const origin = "http://127.0.0.1:3000";
      const secret = randomBytes(48).toString("base64url");
      try {
        Object.assign(process.env, {
          DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`,
          CRM_LOCAL_TEST_DATABASE: "1",
          NOVALURE_SESSION_SECRET: secret,
          NOVALURE_APP_ORIGIN: origin,
          NOVALURE_AUTH_STRICT: "1",
          NOVALURE_AUTH_ENCRYPTION_KEY: randomBytes(40).toString("hex"),
          NOVALURE_AUTH_RATE_LIMIT_SECRET: randomBytes(40).toString("hex"),
        });
        delete process.env.VERCEL;
        delete process.env.VERCEL_ENV;
        delete process.env.VERCEL_TARGET_ENV;
        delete process.env.VERCEL_PROJECT_ID;
        const path = "/api/crm/evelyn-contracts";
        const csrf = createCsrfToken({ method: "POST", pathname: path, secret, sessionCookie: f.sessionCookie });
        assert.ok(csrf);
        const response = await postEvelynContractRoute(new Request(origin + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `novalure_session=${f.sessionCookie}`,
            origin,
            "sec-fetch-site": "same-origin",
            "x-novalure-csrf-token": csrf.token,
            "idempotency-key": f.createInput.idempotencyKey,
            "x-correlation-id": f.createInput.correlationId,
          },
          body: JSON.stringify({
            ...f.createInput,
            netMinorUnits: "1",
            taxMinorUnits: "0",
            grossMinorUnits: "1",
          }),
        }));
        assert.equal(response.status, 400, await response.clone().text());
        assert.equal((await response.json()).code, "UNKNOWN_FIELD");
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_evelyn_contract_actions where workspace_id=$1",
          [f.workspaceId],
        )).rows[0].count, 0);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and resource_type='CONTRACT'",
          [f.workspaceId],
        )).rows[0].count, 0);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_command_receipts where workspace_id=$1 and operation='evelyn.contract.v2.create'",
          [f.workspaceId],
        )).rows[0].count, 0);
      } finally {
        await closeLocalTestPool();
        for (const key of keys) {
          if (original[key] === undefined) delete process.env[key];
          else process.env[key] = original[key];
        }
      }
    });

    await t.test("two-step request, fresh verify and concurrent execute commit exactly one synthetic effect", async () => {
      const f = await fixture(db);
      const created = await createEvelynContractActionV2(f.session, f.createInput, f.v2Options);
      const base = actionInput(created, f.createInput.correlationId);
      const requested = await requestEvelynContractApprovalV2(f.session, base, f.v2Options);
      assert.equal(requested.data.requiredSteps, 2);
      assert.equal(requested.data.status, "PENDING");
      assert.equal(f.remote.calls.requests, 1);
      const approvalReference = requested.data.approvalReference;
      await assert.rejects(verifyEvelynContractApprovalV2(f.session, {
        ...base, idempotencyKey: randomUUID(), approvalReference,
      }, f.v2Options), denied("PENDING"));
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_executions where workspace_id=$1 and action_id=$2",
        [f.workspaceId, created.data.actionId],
      )).rows[0].count, 0);
      f.remote.approve(approvalReference);
      const verifyInput = {
        ...base, idempotencyKey: randomUUID(), approvalReference,
      };
      const verified = await verifyEvelynContractApprovalV2(f.session, verifyInput, f.v2Options);
      assert.equal(verified.status, "VALID");
      assert.equal(verified.financialSnapshotHash, created.data.financialSnapshotHash);
      assert.equal(verified.replayed, false);
      const verifyCallsAfterCommit = f.remote.calls.verifies;
      const verifyReplay = await verifyEvelynContractApprovalV2(f.session, verifyInput, f.v2Options);
      assert.equal(verifyReplay.status, "VALID");
      assert.equal(verifyReplay.replayed, true);
      assert.equal(f.remote.calls.verifies, verifyCallsAfterCommit,
        "a committed verify receipt must replay without another Evelyn Verify");
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_events where workspace_id=$1 and action_id=$2 and stage='VERIFY' and result_code='VALID'",
        [f.workspaceId, created.data.actionId],
      )).rows[0].count, 1);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_events where workspace_id=$1 and snapshot_id=$2 and event_type='APPROVAL_VERIFIED'",
        [f.workspaceId, created.data.financialSnapshotId],
      )).rows[0].count, 1);
      const executeInput = { ...base, idempotencyKey: randomUUID(), approvalReference };
      const results = await Promise.all([
        executeEvelynContractActionV2(f.session, executeInput, f.v2Options),
        executeEvelynContractActionV2(f.session, executeInput, f.v2Options),
      ]) as { replayed: boolean; data: { externalEffect: boolean; contractDelivered: boolean } }[];
      assert.equal(results.filter(result => result.replayed).length, 1);
      assert.ok(results.every(result => result.data.externalEffect === false && result.data.contractDelivered === false));
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_executions where workspace_id=$1 and action_id=$2",
        [f.workspaceId, created.data.actionId],
      )).rows[0].count, 1);
      const stages = (await db.admin.query(
        "select stage,result_code from crm_evelyn_contract_events where workspace_id=$1 and action_id=$2 order by created_at,id",
        [f.workspaceId, created.data.actionId],
      )).rows;
      assert.ok(stages.some(row => row.stage === "REQUEST" && row.result_code === "PENDING"));
      assert.ok(stages.some(row => row.stage === "VERIFY" && row.result_code === "VALID"));
      assert.ok(stages.some(row => row.stage === "EXECUTE" && row.result_code === "VALID"));
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_events where workspace_id=$1 and snapshot_id=$2 and event_type in('APPROVAL_REQUESTED','APPROVAL_VERIFIED')",
        [f.workspaceId, created.data.financialSnapshotId],
      )).rows[0].count, 2);
    });

    await t.test("creator revision preserves origin and supersedes approval; another editor remains atomically denied", async () => {
      const f = await fixture(db);
      const editor = await additionalEditor(db, f.session);
      const created = await createEvelynContractActionV2(f.session, f.createInput, f.v2Options);
      const firstInput = actionInput(created, f.createInput.correlationId);
      const requested = await requestEvelynContractApprovalV2(f.session, firstInput, f.v2Options);
      f.remote.approve(requested.data.approvalReference);
      const remoteCalls = f.remote.calls.verifies;
      const primaryV2 = await registerPolicy(db, f.session, f.projectId,
        "SYNTHETIC:tax:primary", "2", taxPolicy("primary", "2", "21", "100"));
      const revisedSelection: ContractFinancialPolicySelection = {
        ...f.policySelection,
        taxPolicies: f.policySelection.taxPolicies.map(item => item.componentId === "primary"
          ? { ...item, policy: primaryV2 } : item),
      };
      const revisionInput = {
        operation: "revise" as const,
        approvalContractVersion: "v2" as const,
        projectId: f.projectId,
        actionId: created.data.actionId,
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        correlationId: f.createInput.correlationId,
        policySelection: revisedSelection,
      };
      await assert.rejects(reviseEvelynContractActionV2(editor, revisionInput, f.v2Options), sqlCode("42501"));
      await assertLineage(db, f.workspaceId, created.data.actionId, 1, 1, revisionInput.idempotencyKey);
      const revised = await reviseEvelynContractActionV2(f.session, revisionInput, f.v2Options) as {
        data: { actionVersion: number; financialSnapshotHash: string; actionHash: string };
      };
      assert.equal(revised.data.actionVersion, 2);
      assert.notEqual(revised.data.financialSnapshotHash, created.data.financialSnapshotHash);
      assert.notEqual(revised.data.actionHash, created.data.actionHash);
      const snapshots = (await db.admin.query(
        "select id,business_version,snapshot_hash,supersedes_snapshot_id,canonical_snapshot from crm_financial_snapshots where workspace_id=$1 and resource_type='CONTRACT' and resource_id=$2 order by business_version",
        [f.workspaceId, created.data.actionId],
      )).rows;
      assert.equal(snapshots.length, 2);
      assert.equal(snapshots[1].supersedes_snapshot_id, snapshots[0].id);
      assert.equal(snapshots[0].canonical_snapshot.totals.tax.minorUnits, "611100");
      assert.equal(snapshots[1].canonical_snapshot.totals.tax.minorUnits, "631470");
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_events where workspace_id=$1 and snapshot_id=$2 and event_type='SUPERSEDED' and related_snapshot_id=$3",
        [f.workspaceId, snapshots[1].id, snapshots[0].id],
      )).rows[0].count, 1);
      await assert.rejects(verifyEvelynContractApprovalV2(f.session, {
        ...firstInput, idempotencyKey: randomUUID(), approvalReference: requested.data.approvalReference,
      }, f.v2Options), denied("VERSION_MISMATCH"));
      await assert.rejects(executeEvelynContractActionV2(f.session, {
        ...firstInput, idempotencyKey: randomUUID(), approvalReference: requested.data.approvalReference,
      }, f.v2Options), denied("VERSION_MISMATCH"));
      assert.equal(f.remote.calls.verifies, remoteCalls, "stale revision must fail before remote verification");
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_executions where workspace_id=$1 and action_id=$2",
        [f.workspaceId, created.data.actionId],
      )).rows[0].count, 0);
      const secondInput = { ...firstInput, expectedVersion: 2, idempotencyKey: randomUUID() };
      const second = await requestEvelynContractApprovalV2(f.session, secondInput, f.v2Options);
      const sent = f.remote.approvals.get(secondInput.idempotencyKey)!.request.action;
      assert.equal(sent.requestingActorId, f.userId);
      assert.equal(sent.workflowId, created.data.actionId);
      assert.equal(sent.resourceVersion, 2);
      assert.notEqual(second.data.approvalReference, requested.data.approvalReference);
      assert.equal((await db.admin.query(
        "select created_by from crm_evelyn_contract_revisions where workspace_id=$1 and action_id=$2 and version=2",
        [f.workspaceId, created.data.actionId],
      )).rows[0].created_by, f.userId);
      assert.equal((await db.admin.query(
        "select actor_user_id from audit_logs where workspace_id=$1 and entity_id=$2 and action='evelyn.contract.v2.revise'",
        [f.workspaceId, created.data.actionId],
      )).rows[0].actor_user_id, f.userId);
    });

    await t.test("V1 to V2 upgrade is additive while V2 to V1 downgrade is rejected", async () => {
      const upgrade = await fixture(db);
      const v1 = await createEvelynContractAction(upgrade.session, {
        projectId: upgrade.projectId,
        offerId: upgrade.offer.id,
        expectedOfferVersion: upgrade.offer.version,
        idempotencyKey: randomUUID(),
        correlationId: upgrade.createInput.correlationId,
      }, upgrade.v1Options);
      assert.equal(v1.data.actionVersion, 1);
      const editor = await additionalEditor(db, upgrade.session);
      await assert.rejects(createEvelynContractActionV2(editor, upgrade.createInput, upgrade.v2Options),
        denied("EVELYN_REGISTRATION_REQUIRED"));
      await assertLineage(db, upgrade.workspaceId, v1.data.actionId, 1, 0, upgrade.createInput.idempotencyKey);
      assert.equal(upgrade.remote.calls.requests, 0);
      await requestEvelynContractApproval(upgrade.session,
        actionInput(v1, upgrade.createInput.correlationId), upgrade.v1Options);
      await assert.rejects(createEvelynContractActionV2(editor, upgrade.createInput, upgrade.v2Options), sqlCode("42501"));
      await assertLineage(db, upgrade.workspaceId, v1.data.actionId, 1, 0, upgrade.createInput.idempotencyKey);
      const v2 = await createEvelynContractActionV2(upgrade.session, upgrade.createInput, upgrade.v2Options);
      assert.equal(v2.data.actionId, v1.data.actionId);
      assert.equal(v2.data.actionVersion, 2);
      assert.deepEqual((await db.admin.query(
        "select version,approval_contract_version from crm_evelyn_contract_revisions where workspace_id=$1 and action_id=$2 order by version",
        [upgrade.workspaceId, v1.data.actionId],
      )).rows, [
        { version: 1, approval_contract_version: "v1" },
        { version: 2, approval_contract_version: "v2" },
      ]);
      const v2Request = actionInput(v2, upgrade.createInput.correlationId);
      const requested = await requestEvelynContractApprovalV2(upgrade.session, v2Request, upgrade.v2Options);
      assert.equal(requested.data.actionVersion, 2);
      const sent = upgrade.remote.approvals.get(v2Request.idempotencyKey)!.request.action;
      assert.equal(sent.requestingActorId, upgrade.userId);
      assert.equal(sent.workflowId, v1.data.actionId);
      assert.equal(sent.resourceVersion, 2);
      assert.equal((await db.admin.query(
        "select created_by from crm_evelyn_contract_revisions where workspace_id=$1 and action_id=$2 and version=2",
        [upgrade.workspaceId, v1.data.actionId],
      )).rows[0].created_by, upgrade.userId);
      assert.equal((await db.admin.query(
        "select actor_user_id from audit_logs where workspace_id=$1 and entity_id=$2 and action='evelyn.contract.v2.create'",
        [upgrade.workspaceId, upgrade.offer.id],
      )).rows[0].actor_user_id, upgrade.userId);

      const downgrade = await fixture(db);
      const first = await createEvelynContractActionV2(downgrade.session, downgrade.createInput, downgrade.v2Options);
      await assert.rejects(createEvelynContractAction(downgrade.session, {
        projectId: downgrade.projectId,
        offerId: downgrade.offer.id,
        expectedOfferVersion: downgrade.offer.version,
        idempotencyKey: randomUUID(),
        correlationId: downgrade.createInput.correlationId,
      }, downgrade.v1Options), error => sqlCode("23505")(error) || denied("EVELYN_CONTRACT_VERSION_MISMATCH")(error));
      assert.deepEqual((await db.admin.query(
        "select version,approval_contract_version from crm_evelyn_contract_revisions where workspace_id=$1 and action_id=$2 order by version",
        [downgrade.workspaceId, first.data.actionId],
      )).rows, [{ version: 1, approval_contract_version: "v2" }]);
    });

    await t.test("unregistered revisions and failed requests cannot advance the lineage; ordered retries recover", async () => {
      const f = await fixture(db);
      const created = await createEvelynContractActionV2(f.session, f.createInput, f.v2Options);
      const revise = {
        operation: "revise" as const, approvalContractVersion: "v2" as const, projectId: f.projectId,
        ...actionInput(created, f.createInput.correlationId), policySelection: f.policySelection,
      };
      await assert.rejects(reviseEvelynContractActionV2(f.session, revise, f.v2Options), denied("EVELYN_REGISTRATION_REQUIRED"));
      await assertLineage(db, f.workspaceId, created.data.actionId, 1, 1, revise.idempotencyKey);
      const request = actionInput(created, f.createInput.correlationId);
      for (const code of ["TIMEOUT", "SERVICE_UNAVAILABLE"]) {
        f.remote.failRequests(code);
        await assert.rejects(requestEvelynContractApprovalV2(f.session, request, f.v2Options), denied(code));
        await assert.rejects(reviseEvelynContractActionV2(f.session, revise, f.v2Options), denied("EVELYN_REGISTRATION_REQUIRED"));
        await assertLineage(db, f.workspaceId, created.data.actionId, 1, 1, revise.idempotencyKey);
      }
      f.remote.failRequests(undefined);
      await requestEvelynContractApprovalV2(f.session, request, f.v2Options);
      const second = await reviseEvelynContractActionV2(f.session, revise, f.v2Options) as {
        data: { actionId: string; actionVersion: number };
      };
      assert.equal(second.data.actionVersion, 2);
      const thirdInput = { ...revise, expectedVersion: 2, idempotencyKey: randomUUID() };
      await assert.rejects(reviseEvelynContractActionV2(f.session, thirdInput, f.v2Options), denied("EVELYN_REGISTRATION_REQUIRED"));
      await assertLineage(db, f.workspaceId, created.data.actionId, 2, 2, thirdInput.idempotencyKey);
      await requestEvelynContractApprovalV2(f.session,
        actionInput(second, f.createInput.correlationId), f.v2Options);
      const third = await reviseEvelynContractActionV2(f.session, thirdInput, f.v2Options) as {
        data: { actionId: string; actionVersion: number };
      };
      assert.equal(third.data.actionVersion, 3);
      assert.equal((await requestEvelynContractApprovalV2(f.session,
        actionInput(third, f.createInput.correlationId), f.v2Options)).data.actionVersion, 3);
      await assertLineage(db, f.workspaceId, created.data.actionId, 3, 3);
    });

    await t.test("non-EUR policy cannot reinterpret the EUR source and fails POLICY_REQUIRED before persistence or remote", async () => {
      const f = await fixture(db, { currency: "USD" });
      await assert.rejects(
        createEvelynContractActionV2(f.session, f.createInput, f.v2Options),
        denied("POLICY_REQUIRED"),
      );
      assert.equal(f.remote.calls.requests, 0);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_actions where workspace_id=$1",
        [f.workspaceId],
      )).rows[0].count, 0);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and resource_type='CONTRACT'",
        [f.workspaceId],
      )).rows[0].count, 0);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_command_receipts where workspace_id=$1 and operation like 'evelyn.contract.v2.%'",
        [f.workspaceId],
      )).rows[0].count, 0);
    });

    await t.test("oversized exact V2 request rolls the snapshot and action back before any durable write", async () => {
      const items = Array.from({ length: 100 }, (_, index) => ({
        description: `SYNTHETIC line ${index.toString().padStart(3, "0")} ${"x".repeat(900)}`,
        quantity: 1,
        unitNetCents: 1_000,
      }));
      const f = await fixture(db, { items });
      await assert.rejects(
        createEvelynContractActionV2(f.session, f.createInput, f.v2Options),
        denied("REQUEST_TOO_LARGE"),
      );
      assert.equal(f.remote.calls.requests, 0);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_actions where workspace_id=$1",
        [f.workspaceId],
      )).rows[0].count, 0);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and resource_type='CONTRACT'",
        [f.workspaceId],
      )).rows[0].count, 0);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_command_receipts where workspace_id=$1 and operation='evelyn.contract.v2.create'",
        [f.workspaceId],
      )).rows[0].count, 0);
    });

    await t.test("parallel duplicates and idempotency conflicts preserve one action and one approval binding", async () => {
      const same = await fixture(db);
      const sameResults = await Promise.all([
        createEvelynContractActionV2(same.session, same.createInput, same.v2Options),
        createEvelynContractActionV2(same.session, same.createInput, same.v2Options),
      ]);
      assert.equal(sameResults.filter(result => result.replayed).length, 1);
      assert.equal(sameResults[0].data.actionId, sameResults[1].data.actionId);
      await assert.rejects(createEvelynContractActionV2(same.session, {
        ...same.createInput,
        policySelection: { ...same.policySelection, taxPolicies: [...same.policySelection.taxPolicies].reverse() },
      }, same.v2Options), denied("IDEMPOTENCY_CONFLICT"));

      const competing = await fixture(db);
      const createResults = await Promise.allSettled([
        createEvelynContractActionV2(competing.session, competing.createInput, competing.v2Options),
        createEvelynContractActionV2(competing.session, { ...competing.createInput, idempotencyKey: randomUUID() }, competing.v2Options),
      ]);
      assert.equal(createResults.filter(result => result.status === "fulfilled").length, 1);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_actions where workspace_id=$1 and offer_id=$2",
        [competing.workspaceId, competing.offer.id],
      )).rows[0].count, 1);

      const requestFixture = await fixture(db);
      const created = await createEvelynContractActionV2(requestFixture.session, requestFixture.createInput, requestFixture.v2Options);
      const request = actionInput(created, requestFixture.createInput.correlationId);
      const requests = await Promise.all([
        requestEvelynContractApprovalV2(requestFixture.session, request, requestFixture.v2Options),
        requestEvelynContractApprovalV2(requestFixture.session, request, requestFixture.v2Options),
      ]);
      assert.equal(requests.filter(result => result.replayed).length, 1);
      assert.equal(requests[0].data.approvalReference, requests[1].data.approvalReference);
      const requestCallsAfterCommit = requestFixture.remote.calls.requests;
      requestFixture.remote.failRequests("SERVICE_UNAVAILABLE");
      try {
        const committedReplay = await requestEvelynContractApprovalV2(
          requestFixture.session,
          request,
          requestFixture.v2Options,
        );
        assert.equal(committedReplay.replayed, true);
        assert.equal(committedReplay.data.approvalReference, requests[0].data.approvalReference);
        assert.equal(requestFixture.remote.calls.requests, requestCallsAfterCommit,
          "a committed local receipt must replay without another Evelyn request");
      } finally {
        requestFixture.remote.failRequests(undefined);
      }
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_approvals where workspace_id=$1 and action_id=$2",
        [requestFixture.workspaceId, created.data.actionId],
      )).rows[0].count, 1);
    });

    await t.test("cross-tenant repository access and unscoped tenant role reads are denied", async () => {
      const owner = await fixture(db);
      const foreign = await fixture(db);
      const created = await createEvelynContractActionV2(owner.session, owner.createInput, owner.v2Options);
      await assert.rejects(getEvelynContractActionV2(foreign.session, created.data.actionId, owner.v2Options),
        error => denied("EVELYN_ACTION_NOT_ACCESSIBLE")(error) || denied("EVELYN_QA_SCOPE_DENIED")(error));
      assert.equal(owner.remote.calls.requests, 0);
      assert.equal((await db.pool.query(
        "select count(*)::int count from crm_financial_snapshots where workspace_id=$1",
        [owner.workspaceId],
      )).rows[0].count, 0);
    });

    await t.test("injected snapshot and V2 binding failures roll back every partial action write", async () => {
      const snapshotFailure = await fixture(db);
      await db.admin.query(`
        create function qa_g27_fail_snapshot() returns trigger language plpgsql as $$
        begin raise exception 'INJECTED_G27_SNAPSHOT_FAILURE'; end $$
      `);
      await db.admin.query("create trigger qa_g27_fail_snapshot before insert on crm_financial_snapshots for each row execute function qa_g27_fail_snapshot()");
      try {
        await assert.rejects(createEvelynContractActionV2(snapshotFailure.session,
          snapshotFailure.createInput, snapshotFailure.v2Options), /INJECTED_G27_SNAPSHOT_FAILURE/);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_evelyn_contract_actions where workspace_id=$1 and offer_id=$2",
          [snapshotFailure.workspaceId, snapshotFailure.offer.id],
        )).rows[0].count, 0);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and resource_type='CONTRACT'",
          [snapshotFailure.workspaceId],
        )).rows[0].count, 0);
      } finally {
        await db.admin.query("drop trigger if exists qa_g27_fail_snapshot on crm_financial_snapshots");
        await db.admin.query("drop function if exists qa_g27_fail_snapshot()");
      }
      assert.equal((await createEvelynContractActionV2(snapshotFailure.session,
        snapshotFailure.createInput, snapshotFailure.v2Options)).data.actionVersion, 1);

      const bindingFailure = await fixture(db);
      await db.admin.query(`
        create function qa_g27_fail_binding() returns trigger language plpgsql as $$
        begin if new.approval_contract_version='v2' then raise exception 'INJECTED_G27_BINDING_FAILURE'; end if; return new; end $$
      `);
      await db.admin.query("create trigger qa_g27_fail_binding before insert on crm_evelyn_contract_revisions for each row execute function qa_g27_fail_binding()");
      try {
        await assert.rejects(createEvelynContractActionV2(bindingFailure.session,
          bindingFailure.createInput, bindingFailure.v2Options), /INJECTED_G27_BINDING_FAILURE/);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_evelyn_contract_actions where workspace_id=$1 and offer_id=$2",
          [bindingFailure.workspaceId, bindingFailure.offer.id],
        )).rows[0].count, 0);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and resource_type='CONTRACT'",
          [bindingFailure.workspaceId],
        )).rows[0].count, 0);
      } finally {
        await db.admin.query("drop trigger if exists qa_g27_fail_binding on crm_evelyn_contract_revisions");
        await db.admin.query("drop function if exists qa_g27_fail_binding()");
      }
      assert.equal((await createEvelynContractActionV2(bindingFailure.session,
        bindingFailure.createInput, bindingFailure.v2Options)).data.actionVersion, 1);
    });

    await t.test("injected financial audit failure rolls approval persistence back and retry is safe", async () => {
      const f = await fixture(db);
      const created = await createEvelynContractActionV2(f.session, f.createInput, f.v2Options);
      const request = actionInput(created, f.createInput.correlationId);
      const revise = { operation: "revise" as const, approvalContractVersion: "v2" as const,
        projectId: f.projectId, ...actionInput(created, f.createInput.correlationId), policySelection: f.policySelection };
      await db.admin.query(`
        create function qa_g27_fail_approval_event() returns trigger language plpgsql as $$
        begin if new.event_type='APPROVAL_REQUESTED' then raise exception 'INJECTED_G27_AUDIT_FAILURE'; end if; return new; end $$
      `);
      await db.admin.query("create trigger qa_g27_fail_approval_event before insert on crm_financial_events for each row execute function qa_g27_fail_approval_event()");
      try {
        await assert.rejects(requestEvelynContractApprovalV2(f.session, request, f.v2Options), /INJECTED_G27_AUDIT_FAILURE/);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_evelyn_contract_approvals where workspace_id=$1 and action_id=$2",
          [f.workspaceId, created.data.actionId],
        )).rows[0].count, 0);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_financial_events where workspace_id=$1 and snapshot_id=$2 and event_type='APPROVAL_REQUESTED'",
          [f.workspaceId, created.data.financialSnapshotId],
        )).rows[0].count, 0);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_command_receipts where workspace_id=$1 and idempotency_key=$2",
          [f.workspaceId, request.idempotencyKey],
        )).rows[0].count, 0);
        assert.equal(f.remote.calls.requests, 1);
        assert.equal(f.remote.approvals.size, 1, "the simulated remote registration succeeded before the local rollback");
        await assert.rejects(reviseEvelynContractActionV2(f.session, revise, f.v2Options), denied("EVELYN_REGISTRATION_REQUIRED"));
        await assertLineage(db, f.workspaceId, created.data.actionId, 1, 1, revise.idempotencyKey);
      } finally {
        await db.admin.query("drop trigger if exists qa_g27_fail_approval_event on crm_financial_events");
        await db.admin.query("drop function if exists qa_g27_fail_approval_event()");
      }
      const retried = await requestEvelynContractApprovalV2(f.session, request, f.v2Options);
      assert.equal(retried.data.requiredSteps, 2);
      assert.equal(f.remote.calls.requests, 2,
        "a missing local receipt must recover the idempotent Evelyn registration");
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_approvals where workspace_id=$1 and action_id=$2",
        [f.workspaceId, created.data.actionId],
      )).rows[0].count, 1);
      assert.equal(f.remote.approvals.size, 1, "same request safely recovers the original remote registration");
      const second = await reviseEvelynContractActionV2(f.session, revise, f.v2Options) as {
        data: { actionId: string; actionVersion: number };
      };
      assert.equal((await requestEvelynContractApprovalV2(f.session,
        actionInput(second, f.createInput.correlationId), f.v2Options)).data.actionVersion, 2);
    });

    await t.test("NEEDS_REVIEW V2 binding cannot verify or execute and never reaches remote", async () => {
      const f = await fixture(db);
      const actionId = randomUUID(), snapshotId = randomUUID(), correlationId = randomUUID();
      const source = (await db.admin.query(`
        select o.version,o.revision,o.contact_id,o.approval_id,r.content_digest,r.created_by
        from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision
        where o.workspace_id=$1 and o.id=$2
      `, [f.workspaceId, f.offer.id])).rows[0];
      const built = buildLegacyNeedsReviewSnapshot({
        snapshotId,
        businessVersion: 1,
        tenantId: f.workspaceId,
        resourceId: actionId,
        knownNet: { minorUnits: "2037000", currency: "EUR", minorUnitExponent: 2 },
        knownCurrency: { currency: "EUR", minorUnitExponent: 2 },
      });
      const action = {
        actionContractVersion: "approval-action-v2" as const,
        actionId,
        workflowId: actionId,
        tenantId: f.workspaceId,
        requestingActorId: f.userId,
        correlationId,
        actionType: "contract.send" as const,
        resourceType: "Contract" as const,
        resourceId: actionId,
        actionVersion: 1,
        resourceVersion: 1,
        payload: {
          recipient: { id: f.contactId, email: "buyer@example.invalid" },
          contract: { id: actionId, version: 1, content: "SYNTHETIC legacy review contract" },
          scope: { projectId: f.projectId, description: "SYNTHETIC review-only scope" },
        },
        financialSnapshot: built.snapshot,
        financialSnapshotHash: built.snapshotHash,
        economicCommitment: { basis: "NET" as const, amount: built.snapshot.totals.net },
      };
      const actionHash = approvalActionV2Hash({ ...action, environment: "preview", synthetic: true });
      await db.admin.query(`
        insert into crm_financial_snapshots(
          id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,
          canonical_snapshot,snapshot_hash,created_by,correlation_id
        ) values($1,$2,$3,'CONTRACT',$4,1,'NEEDS_REVIEW',$5::jsonb,$6,$7,$8)
      `, [snapshotId, f.workspaceId, f.projectId, actionId, JSON.stringify(built.snapshot), built.snapshotHash, f.userId, correlationId]);
      await db.admin.query(`
        insert into crm_evelyn_contract_actions(
          id,workspace_id,project_id,offer_id,created_by,correlation_id,version,offer_version,offer_revision,
          source_approval_id,source_content_digest
        ) values($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)
      `, [actionId, f.workspaceId, f.projectId, f.offer.id, f.userId, correlationId,
        source.version, source.revision, source.approval_id, source.content_digest]);
      const fixtureClient = await db.admin.connect();
      try {
        await fixtureClient.query("begin");
        // Deliberately bypass the SQL V2 guard in this disposable fixture so the
        // application boundary independently proves its explicit review denial.
        await fixtureClient.query("set local session_replication_role=replica");
        await fixtureClient.query(`
          insert into crm_evelyn_contract_revisions(
            workspace_id,project_id,action_id,version,created_by,action,action_hash,
            approval_contract_version,financial_snapshot_id,financial_snapshot_hash,data_classification,data_purpose
          ) values($1,$2,$3,1,$4,$5::jsonb,$6,'v2',$7,$8,'NOVALURE_INTERNAL','crm_sales')
        `, [f.workspaceId, f.projectId, actionId, f.userId, JSON.stringify(action), actionHash, snapshotId, built.snapshotHash]);
        await fixtureClient.query("commit");
      } catch (error) {
        await fixtureClient.query("rollback");
        throw error;
      } finally {
        fixtureClient.release();
      }
      await assert.rejects(executeEvelynContractActionV2(f.session, {
        actionId,
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        correlationId,
        approvalReference: randomUUID(),
      }, f.v2Options), denied("FINANCIAL_SNAPSHOT_NEEDS_REVIEW"));
      assert.equal(f.remote.calls.verifies, 0);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_executions where workspace_id=$1 and action_id=$2",
        [f.workspaceId, actionId],
      )).rows[0].count, 0);
    });

    await t.test("self-hashed false registry, offer net and resource bindings fail before every remote call", async () => {
      const f = await fixture(db);
      const created = await createEvelynContractActionV2(f.session, f.createInput, f.v2Options);
      const stored = (await db.admin.query(`
        select s.canonical_snapshot,r.action
        from crm_evelyn_contract_revisions r
        join crm_financial_snapshots s on s.workspace_id=r.workspace_id and s.id=r.financial_snapshot_id
        where r.workspace_id=$1 and r.action_id=$2 and r.version=1
      `, [f.workspaceId, created.data.actionId])).rows[0];
      const pristineSnapshot = structuredClone(stored.canonical_snapshot);
      const pristineAction = structuredClone(stored.action);
      const forgedReference = (name: string) => ({
        id: `SYNTHETIC:forged:${name}`,
        version: "999",
        contentHash: createHash("sha256").update(`SYNTHETIC forged ${name}`).digest("hex"),
      });
      const attempts = [
        {
          name: "currency registry",
          resourceType: "CONTRACT",
          mutate(snapshot: typeof pristineSnapshot) {
            snapshot.currencyDefinition.registryReference = forgedReference("currency");
          },
        },
        {
          name: "rounding registry",
          resourceType: "CONTRACT",
          mutate(snapshot: typeof pristineSnapshot) {
            snapshot.roundingPolicy = forgedReference("rounding");
          },
        },
        {
          name: "tax registry and provenance",
          resourceType: "CONTRACT",
          mutate(snapshot: typeof pristineSnapshot) {
            const policy = snapshot.components[0].taxComponents[0].policy;
            policy.reference = forgedReference("tax");
            policy.sourceProvenance.policyVersion = "999";
            policy.sourceProvenance.sourceReference = "SYNTHETIC forged tax source";
          },
        },
        {
          name: "accepted offer net",
          resourceType: "CONTRACT",
          mutate(snapshot: typeof pristineSnapshot) {
            const component = snapshot.components[0];
            component.net.minorUnits = (BigInt(component.net.minorUnits) + BigInt(1)).toString();
            component.gross.minorUnits = (BigInt(component.gross.minorUnits) + BigInt(1)).toString();
            snapshot.totals.net.minorUnits = (BigInt(snapshot.totals.net.minorUnits) + BigInt(1)).toString();
            snapshot.totals.gross.minorUnits = (BigInt(snapshot.totals.gross.minorUnits) + BigInt(1)).toString();
          },
        },
        {
          name: "financial resource type",
          resourceType: "PROPERTY_COST_MATRIX",
          mutate(snapshot: typeof pristineSnapshot) { void snapshot; },
        },
        {
          name: "registered rounding policy outside effective window",
          resourceType: "CONTRACT",
          expireRoundingRegistry: true,
          mutate(snapshot: typeof pristineSnapshot) { void snapshot; },
        },
      ];

      for (const attempt of attempts) {
        const snapshot = structuredClone(pristineSnapshot);
        attempt.mutate(snapshot);
        const snapshotHash = financialSnapshotHash(snapshot);
        const action = structuredClone(pristineAction);
        action.financialSnapshot = snapshot;
        action.financialSnapshotHash = snapshotHash;
        action.economicCommitment = { basis: "NET", amount: snapshot.totals.net };
        const actionHash = approvalActionV2Hash({ ...action, environment: "preview", synthetic: true });
        const client = await db.admin.connect();
        try {
          await client.query("begin");
          // Simulate a compromised legacy writer even after the SQL guard lands;
          // the application read boundary must independently deny these rows.
          await client.query("set local session_replication_role=replica");
          if ("expireRoundingRegistry" in attempt && attempt.expireRoundingRegistry) {
            await client.query(`
              update crm_financial_policy_versions set effective_from='2099-01-01T00:00:00.000Z'::timestamptz
              where workspace_id=$1 and project_id=$2 and policy_kind='ROUNDING'
                and policy_id=$3 and policy_version=$4
            `, [f.workspaceId, f.projectId, pristineSnapshot.roundingPolicy.id,
              pristineSnapshot.roundingPolicy.version]);
          }
          await client.query(`
            update crm_financial_snapshots
            set resource_type=$3,canonical_snapshot=$4::jsonb,snapshot_hash=$5
            where workspace_id=$1 and id=$2
          `, [f.workspaceId, created.data.financialSnapshotId, attempt.resourceType,
            JSON.stringify(snapshot), snapshotHash]);
          await client.query(`
            update crm_evelyn_contract_revisions
            set action=$4::jsonb,action_hash=$5,financial_snapshot_hash=$6
            where workspace_id=$1 and action_id=$2 and version=$3
          `, [f.workspaceId, created.data.actionId, 1, JSON.stringify(action), actionHash, snapshotHash]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
        await assert.rejects(requestEvelynContractApprovalV2(f.session, {
          ...actionInput(created, f.createInput.correlationId),
          idempotencyKey: randomUUID(),
        }, f.v2Options), denied("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED"), attempt.name);
        assert.equal(f.remote.calls.requests, 0, `${attempt.name} must fail before Evelyn request`);
      }
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_approvals where workspace_id=$1 and action_id=$2",
        [f.workspaceId, created.data.actionId],
      )).rows[0].count, 0);
    });

    await t.test("immutable evidence and V2 snapshot FK/binding guards reject tampering", async () => {
      const f = await fixture(db);
      const created = await createEvelynContractActionV2(f.session, f.createInput, f.v2Options);
      const row = (await db.admin.query(
        "select action,financial_snapshot_id from crm_evelyn_contract_revisions where workspace_id=$1 and action_id=$2 and version=1",
        [f.workspaceId, created.data.actionId],
      )).rows[0];
      for (const query of [
        ["update crm_financial_policy_versions set source_reference='changed' where workspace_id=$1", [f.workspaceId]],
        ["update crm_financial_snapshots set snapshot_hash=$2 where workspace_id=$1 and id=$3", [f.workspaceId, "0".repeat(64), row.financial_snapshot_id]],
        ["delete from crm_financial_events where workspace_id=$1", [f.workspaceId]],
        ["update crm_evelyn_contract_revisions set action_hash=$2 where workspace_id=$1 and action_id=$3", [f.workspaceId, "0".repeat(64), created.data.actionId]],
      ] as [string, unknown[]][]) {
        await assert.rejects(db.admin.query(query[0], query[1]), error => sqlCode("55000")(error) || /immutable/i.test(String(error)));
      }
      const forgedAction = structuredClone(row.action);
      forgedAction.actionVersion = 2;
      forgedAction.financialSnapshotHash = "0".repeat(64);
      await assert.rejects(db.admin.query(`
        insert into crm_evelyn_contract_revisions(
          workspace_id,project_id,action_id,version,created_by,action,action_hash,
          approval_contract_version,financial_snapshot_id,financial_snapshot_hash
        ) values($1,$2,$3,2,$4,$5::jsonb,$6,'v2',$7,$8)
      `, [f.workspaceId, f.projectId, created.data.actionId, f.userId, JSON.stringify(forgedAction),
        "a".repeat(64), row.financial_snapshot_id, "0".repeat(64)]), sqlCode("23514"));
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_evelyn_contract_revisions where workspace_id=$1 and action_id=$2",
        [f.workspaceId, created.data.actionId],
      )).rows[0].count, 1);
      const fk = (await db.admin.query(`
        select pg_get_constraintdef(oid) definition from pg_constraint
        where conname='crm_evelyn_contract_revision_financial_snapshot_fk'
      `)).rows[0]?.definition;
      assert.match(fk, /FOREIGN KEY \(workspace_id, project_id, financial_snapshot_id\).*crm_financial_snapshots/i);
    });
  } finally {
    await closeLocalTestPool();
    await db.stop();
    const mutableEnv = process.env as Record<string, string | undefined>;
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV; else mutableEnv.NODE_ENV = previousNodeEnv;
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
    if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previousVercelEnv;
    if (previousVercelUrl === undefined) delete process.env.VERCEL_URL; else process.env.VERCEL_URL = previousVercelUrl;
  }
});
