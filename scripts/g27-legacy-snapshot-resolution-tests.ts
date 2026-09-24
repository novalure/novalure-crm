import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { POST as postFinancialSnapshotRoute } from "../src/app/api/crm/financial-snapshots/route";
import type { AppSession } from "../src/lib/auth/session";
import { CrmCommandError } from "../src/lib/crm-command";
import { closeLocalTestPool } from "../src/lib/db/local-test-transport";
import type { TenantPool, TenantTransaction } from "../src/lib/db/tenant-client";
import {
  getFinancialSnapshot,
  listFinancialReviewQueue,
  recordFinancialApprovalEventInTransaction,
  registerFinancialPolicyVersion,
  resolveLegacyFinancialSnapshot,
  type ContractFinancialPolicySelection,
  type FinancialResourceType,
  type LegacyFinancialSnapshotResolutionInput,
} from "../src/lib/db/financial-snapshot-repositories";
import {
  financialSnapshotHash,
  normalizeFinancialSnapshotV1,
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
const denied = (code: string) => (error: unknown) => Boolean(error && typeof error === "object"
  && "code" in error && (error as { code: unknown }).code === code);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type LocalDb = Awaited<ReturnType<typeof startLocalSalesDb>>;

function currencyPolicy() {
  return {
    policySchemaVersion: "crm-currency-policy-v1" as const,
    kind: "CURRENCY" as const,
    standard: "ISO-4217" as const,
    code: "EUR",
    minorUnitExponent: 2,
    verifiedAt: INSTANT,
  };
}

function roundingPolicy() {
  return {
    policySchemaVersion: "crm-rounding-policy-v1" as const,
    kind: "ROUNDING" as const,
    mode: "HALF_EVEN" as const,
    currencyExponent: 2,
    scope: "TAX_COMPONENT" as const,
  };
}

function taxPolicy() {
  return {
    policySchemaVersion: "crm-tax-policy-v1" as const,
    kind: "TAX" as const,
    jurisdiction: "AT:BUSINESS",
    treatment: "SYNTHETIC:standard-vat",
    category: "SYNTHETIC:standard",
    rate: { basis: "NET" as const, numerator: "1", denominator: "5" },
    sourceProvenance: {
      authority: "SYNTHETIC policy authority",
      sourceReference: "SYNTHETIC:tax-source",
      jurisdiction: "AT:BUSINESS",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      policyVersion: "1",
      verifiedAt: INSTANT,
    },
  };
}

async function registerPolicy(
  db: LocalDb,
  session: AppSession,
  projectId: string,
  policyId: string,
  payload: FinancialPolicyPayload,
) {
  const result = await registerFinancialPolicyVersion(session, {
    projectId,
    policyId,
    policyVersion: "1",
    payload,
    sourceReference: payload.kind === "TAX"
      ? payload.sourceProvenance.sourceReference
      : `SYNTHETIC source ${policyId}`,
    verifiedAt: INSTANT,
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
  }, { pool: db.pool as unknown as TenantPool });
  assert.equal(result.data.contentHash, financialPolicyContentHash(payload));
  return { id: policyId, version: "1" };
}

async function fixture(db: LocalDb) {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const limitedUserId = randomUUID();
  const projectId = randomUUID();
  const organizationId = randomUUID();
  const contactId = randomUUID();
  const leadId = randomUUID();
  const salesAuthorityId = randomUUID();
  const authSessionId = randomUUID();
  const sessionCookie = `v2.${randomBytes(32).toString("base64url")}`;
  await db.admin.query(
    "insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC G27 review','novalure_internal','novalure_internal','{}'::jsonb)",
    [workspaceId],
  );
  const owner = await db.admin.query(
    "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC owner',$3,'owner','novalureAdmin','active') returning auth_identity_id",
    [userId, workspaceId, `${userId}@example.invalid`],
  );
  const authIdentityId = owner.rows[0].auth_identity_id as string;
  await db.admin.query(
    "update auth_identities set credential_state='active',password_hash='SYNTHETIC G27 TEST ONLY',password_changed_at=now() where id=$1",
    [authIdentityId],
  );
  await db.admin.query(
    "insert into auth_sessions(id,token_hash,auth_identity_id,workspace_user_id,workspace_id,mfa_verified_at,expires_at) values($1,$2,$3,$4,$5,now(),now()+interval '2 hours')",
    [authSessionId, createHash("sha256").update(sessionCookie).digest("hex"), authIdentityId, userId, workspaceId],
  );
  const limitedUser = await db.admin.query(
    "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC reviewer without settings',$3,'admin','novalure_sales','active') returning auth_identity_id",
    [limitedUserId, workspaceId, `${limitedUserId}@example.invalid`],
  );
  const limitedAuthIdentityId = limitedUser.rows[0].auth_identity_id as string;
  await db.admin.query(
    "insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC review project','Service')",
    [projectId, workspaceId],
  );
  await db.admin.query(
    "insert into organizations(id,workspace_id,project_id,owner_user_id,name,type) values($1,$2,$3,$4,'SYNTHETIC review organization','Developer')",
    [organizationId, workspaceId, projectId, userId],
  );
  await db.admin.query("update projects set developer_organization_id=$2 where id=$1", [projectId, organizationId]);
  await db.admin.query(
    "insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,role,email) values($1,$2,$3,$4,$5,'SYNTHETIC review buyer','Buyer',$6)",
    [contactId, workspaceId, projectId, organizationId, userId, `${contactId}@example.invalid`],
  );
  await db.admin.query(
    "insert into leads(id,workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status) values($1,$2,$3,$4,$5,'SYNTHETIC','Buyer','Qualified')",
    [leadId, workspaceId, projectId, contactId, userId],
  );
  await db.admin.query(`
    insert into crm_project_sales_authorities(
      id,workspace_id,project_id,user_id,developer_organization_id,contact_id,
      can_confirm_price,can_confirm_reservation,can_confirm_sale,assignment_source,assigned_by
    ) values($1,$2,$3,$4,$5,$6,true,true,true,'SYNTHETIC review authority',$4)
  `, [salesAuthorityId, workspaceId, projectId, userId, organizationId, contactId]);
  const session = {
    authenticated: true,
    userId,
    workspaceId,
    workspaceName: "SYNTHETIC G27 review",
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
  const limitedSession = {
    ...session,
    userId: limitedUserId,
    email: `${limitedUserId}@example.invalid`,
    name: "SYNTHETIC reviewer without settings",
    role: "admin",
    productRole: "novalure_sales",
    productPermissions: ["pipeline:write", "novalure:internal"],
    authIdentityId: limitedAuthIdentityId,
    authSessionId: undefined,
  } as AppSession;
  const currency = await registerPolicy(db, session, projectId, "SYNTHETIC:currency:EUR", currencyPolicy());
  const rounding = await registerPolicy(db, session, projectId, "SYNTHETIC:rounding", roundingPolicy());
  const tax = await registerPolicy(db, session, projectId, "SYNTHETIC:tax:standard", taxPolicy());
  const policySelection: ContractFinancialPolicySelection = {
    jurisdiction: "AT:BUSINESS",
    currencyPolicy: currency,
    roundingPolicy: rounding,
    taxPolicies: [{ componentId: "standard", policy: tax }],
  };
  return {
    workspaceId,
    userId,
    projectId,
    organizationId,
    contactId,
    leadId,
    salesAuthorityId,
    session,
    sessionCookie,
    limitedSession,
    policySelection,
    options: { pool: db.pool as unknown as TenantPool },
  };
}

async function insertLegacySnapshot(db: LocalDb, f: Awaited<ReturnType<typeof fixture>>,
  resourceType: FinancialResourceType, businessVersion = 1, classification: "B" | "C" = "B",
  scope: { projectId?: string | null; resourceId?: string } = {}) {
  const id = randomUUID();
  const resourceId = scope.resourceId ?? randomUUID();
  const projectId = scope.projectId === undefined ? f.projectId : scope.projectId;
  const correlationId = randomUUID();

  if (projectId !== null && resourceType === "DEAL") {
    await db.admin.query(`
      insert into deals(id,workspace_id,project_id,owner_user_id,name,stage,value_cents,version)
      values($1,$2,$3,$4,'SYNTHETIC legacy review source','Verhandlung',777777,$5)
      on conflict(id) do nothing
    `, [resourceId, f.workspaceId, projectId, f.userId, businessVersion]);
  } else if (projectId !== null && resourceType === "PROPERTY_COST_MATRIX") {
    await db.admin.query(`
      insert into seller_listings(
        id,workspace_id,project_id,seller_lead_id,title,address,region,object_type,area_sqm,
        market_value_cents,target_price_cents
      ) values($1,$2,$3,$4,'SYNTHETIC legacy cost source','SYNTHETIC address','Wien','apartment',50,0,0)
      on conflict(id) do nothing
    `, [resourceId, f.workspaceId, projectId, f.leadId]);
  } else if (projectId !== null && resourceType === "PROPERTY_SALE") {
    const unitId = randomUUID();
    const reservationId = randomUUID();
    await db.admin.query(`
      insert into property_units(
        id,workspace_id,project_id,unit_number,status,price_cents,version,buyer_contact_id
      ) values($1,$2,$3,$4,'sold',10000,$5,$6)
    `, [unitId, f.workspaceId, projectId, `SYN-${unitId}`, businessVersion, f.contactId]);
    await db.admin.query(`
      insert into property_reservations(
        id,workspace_id,project_id,unit_id,contact_id,status,expires_at,buyer_lead_id,version,confirmation
      ) values($1,$2,$3,$4,$5,'converted','2027-01-01T00:00:00Z',$6,1,'{}'::jsonb)
    `, [reservationId, f.workspaceId, projectId, unitId, f.contactId, f.leadId]);
    const admin = await db.admin.connect();
    try {
      await admin.query("begin");
      await admin.query("set local session_replication_role=replica");
      await admin.query(`
        insert into property_sales(
          id,workspace_id,project_id,unit_id,reservation_id,buyer_lead_id,contact_id,
          authority_id,confirmed_by,source_reference,confirmed_at,unit_version,
          data_classification,data_purpose
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'SYNTHETIC immutable sale source',$10,$11,
          'NOVALURE_INTERNAL','crm_sales')
      `, [resourceId, f.workspaceId, projectId, unitId, reservationId, f.leadId, f.contactId,
        f.salesAuthorityId, f.userId, INSTANT, businessVersion]);
      await admin.query("commit");
    } catch (error) {
      await admin.query("rollback");
      throw error;
    } finally {
      admin.release();
    }
  }
  const evidencedNet = classification === "B" && resourceType === "DEAL";
  const base = buildLegacyNeedsReviewSnapshot({
    snapshotId: id,
    businessVersion,
    tenantId: f.workspaceId,
    resourceId,
    knownNet: evidencedNet ? { minorUnits: "10000", currency: "EUR", minorUnitExponent: 2 } : null,
    knownCurrency: evidencedNet ? { currency: "EUR", minorUnitExponent: 2 } : null,
  });
  const evidenceHash = digest(`SYNTHETIC locked legacy evidence ${resourceType} ${resourceId}`);
  const legacyEvidence = classification === "C"
    ? { source: "won-deal-without-bound-economic-evidence", mutableValueExcluded: true }
    : resourceType === "DEAL"
      ? { source: "won-deal-bound-accepted-offer", offerId: randomUUID(), mutableDealValueExcluded: true }
      : resourceType === "PROPERTY_SALE"
        ? { source: "property-sale-bound-unit-audit", saleTimePriceMinorUnits: "10000", evidenceHash }
        : resourceType === "PROPERTY_COST_MATRIX"
          ? {
              source: "legacy-property-cost-items",
              exactStoredIntegerStrings: true,
              items: [{ sourceRecordId: randomUUID(), monthlyNetMinorUnits: "10000", oneTimeNetMinorUnits: "0" }],
            }
          : { source: "SYNTHETIC unsupported legacy resource" };
  const hasBoundEvidence = classification === "B";
  const effectiveAt = hasBoundEvidence && resourceType !== "PROPERTY_COST_MATRIX" ? INSTANT : null;
  const snapshot = normalizeFinancialSnapshotV1({
    ...base.snapshot,
    effectiveAt,
    pricingReference: hasBoundEvidence ? { id: resourceId, version: String(businessVersion), contentHash: evidenceHash } : null,
    provenance: hasBoundEvidence ? {
      sourceSystem: "novalure-crm",
      sourceRecordId: resourceId,
      sourceVersion: String(businessVersion),
      sourceHash: evidenceHash,
      recordedAt: INSTANT,
      recordedBy: f.userId,
    } : null,
    missingFields: base.snapshot.missingFields.filter(field => !(
      (effectiveAt !== null && field === "effectiveAt")
      || (hasBoundEvidence && (field === "pricingReference" || field === "provenance"))
    )),
  });
  if (snapshot.reviewState !== "NEEDS_REVIEW") throw new Error("SYNTHETIC legacy fixture must need review");
  const snapshotHash = financialSnapshotHash(snapshot);
  await db.admin.query(`
    insert into crm_financial_snapshots(
      id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,
      canonical_snapshot,snapshot_hash,legacy_classification,legacy_evidence,created_by,correlation_id
    ) values($1,$2,$3,$4,$5,$6,'NEEDS_REVIEW',$7::jsonb,$8,$9,$10::jsonb,$11,$12)
  `, [id, f.workspaceId, projectId,
    resourceType, resourceId, businessVersion,
    JSON.stringify(snapshot), snapshotHash, classification, JSON.stringify(legacyEvidence),
    f.userId, correlationId]);
  return { id, resourceId, businessVersion, snapshotHash };
}

function resolutionInput(f: Awaited<ReturnType<typeof fixture>>,
  prior: Awaited<ReturnType<typeof insertLegacySnapshot>>): LegacyFinancialSnapshotResolutionInput {
  return {
    projectId: f.projectId,
    priorSnapshotId: prior.id,
    expectedPriorSnapshotHash: prior.snapshotHash,
    policySelection: f.policySelection,
    reviewDecision: "VERIFY_EVIDENCED_NET",
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
  };
}

test("G27 general legacy financial snapshot resolution", { timeout: 300_000 }, async t => {
  const previousNodeEnv = process.env.NODE_ENV;
  Object.assign(process.env, { NODE_ENV: "test" });
  const db = await startLocalSalesDb();
  try {
    const migrations = await applySalesSchema(db);
    assert.equal(migrations.at(-1), "087_crm_financial_snapshots.sql");
    const f = await fixture(db);

    await t.test("invalid financial policy schema input is a controlled 400 command error", async () => {
      const policyId = "SYNTHETIC:invalid-currency";
      await assert.rejects(registerFinancialPolicyVersion(f.session, {
        projectId: f.projectId,
        policyId,
        policyVersion: "1",
        payload: { ...currencyPolicy(), code: "EURO" },
        sourceReference: "SYNTHETIC invalid policy source",
        verifiedAt: INSTANT,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      } as unknown as Parameters<typeof registerFinancialPolicyVersion>[1], f.options), error => (
        error instanceof CrmCommandError
        && error.code === "INVALID_FINANCIAL_POLICY"
        && error.status === 400
      ));
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_policy_versions where workspace_id=$1 and policy_id=$2",
        [f.workspaceId, policyId],
      )).rows[0].count, 0);
    });

    await t.test("TAX wrapper source reference must equal the signed payload provenance", async () => {
      const policyId = "SYNTHETIC:tax:forged-wrapper";
      await assert.rejects(registerFinancialPolicyVersion(f.session, {
        projectId: f.projectId,
        policyId,
        policyVersion: "1",
        payload: taxPolicy(),
        sourceReference: "SYNTHETIC:different-outer-source",
        verifiedAt: INSTANT,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      }, f.options), error => (
        error instanceof CrmCommandError
        && error.code === "FINANCIAL_POLICY_METADATA_MISMATCH"
        && error.status === 400
      ));
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_policy_versions where workspace_id=$1 and policy_id=$2",
        [f.workspaceId, policyId],
      )).rows[0].count, 0);
    });

    await t.test("strict HTTP boundary rejects forged net, pricing reference and effective time", async () => {
      const source = readFileSync(`${WORKDIR}/src/app/api/crm/financial-snapshots/route.ts`, "utf8");
      assert.match(source, /permission:\s*"crm:write"/);
      assert.match(source, /capability:\s*"settings:manage"/);
      assert.match(source, /readBoundedCrmJson\(request\)/);
      assert.doesNotMatch(source, /request\.(?:text|json)\(/);
      assert.match(source, /"expectedPriorSnapshotHash"/);
      assert.match(source, /"reviewDecision"/);
      assert.doesNotMatch(source, /"(?:effectiveAt|pricingReference|authoritativeNetComponents|net|tax|gross|totals|businessVersion|snapshotId)"\s*,/);

      const prior = await insertLegacySnapshot(db, f, "DEAL");
      const input = resolutionInput(f, prior);
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
        const path = "/api/crm/financial-snapshots";
        const csrf = createCsrfToken({ method: "POST", pathname: path, secret, sessionCookie: f.sessionCookie });
        assert.ok(csrf);
        const response = await postFinancialSnapshotRoute(new Request(origin + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `novalure_session=${f.sessionCookie}`,
            origin,
            "sec-fetch-site": "same-origin",
            "x-novalure-csrf-token": csrf.token,
            "idempotency-key": input.idempotencyKey,
            "x-correlation-id": input.correlationId,
          },
          body: JSON.stringify({
            ...input,
            effectiveAt: "2099-01-01T00:00:00.000Z",
            pricingReference: {
              id: "SYNTHETIC:forged-browser-reference",
              version: "999",
              contentHash: "f".repeat(64),
            },
            authoritativeNetComponents: [{
              componentId: "forged:browser-line",
              kind: "LINE",
              netMinorUnits: "999999999999999999",
              pricingReference: {
                id: "SYNTHETIC:forged-browser-reference",
                version: "999",
                contentHash: "f".repeat(64),
              },
              taxComponents: [],
            }],
          }),
        }));
        assert.equal(response.status, 400, await response.clone().text());
        assert.equal((await response.json()).code, "UNKNOWN_FIELD");
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and supersedes_snapshot_id=$2",
          [f.workspaceId, prior.id],
        )).rows[0].count, 0);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_command_receipts where workspace_id=$1 and resource_id=$2 and operation='financial.snapshot.resolve_legacy'",
          [f.workspaceId, prior.id],
        )).rows[0].count, 0);
      } finally {
        await closeLocalTestPool();
        for (const key of keys) {
          if (original[key] === undefined) delete process.env[key];
          else process.env[key] = original[key];
        }
      }
    });

    await t.test("DEAL, PROPERTY_SALE and PROPERTY_COST_MATRIX get server-computed COMPLETE successors", async () => {
      for (const resourceType of ["DEAL", "PROPERTY_SALE", "PROPERTY_COST_MATRIX"] as const) {
        const prior = await insertLegacySnapshot(db, f, resourceType, resourceType === "DEAL" ? 4 : 1);
        const before = await listFinancialReviewQueue(f.session, f.projectId, f.options);
        assert(before.some(snapshot => snapshot.id === prior.id));
        const input = resolutionInput(f, prior);
        const result = await resolveLegacyFinancialSnapshot(f.session, input, f.options);
        assert.equal(result.replayed, false);
        assert.equal(result.data.resourceType, resourceType);
        assert.equal(result.data.resourceId, prior.resourceId);
        assert.equal(result.data.businessVersion, prior.businessVersion + 1);
        assert.equal(result.data.reviewState, "VERIFIED");
        assert.equal(result.data.supersedesSnapshotId, prior.id);
        assert.equal(result.data.snapshot.reviewState, "COMPLETE");
        assert.equal(result.data.snapshot.totals.net.minorUnits, "10000");
        assert.equal(result.data.snapshot.totals.tax.minorUnits, "2000");
        assert.equal(result.data.snapshot.totals.gross.minorUnits, "12000");
        assert.equal(result.data.snapshot.currency, "EUR");
        assert.equal(result.data.snapshot.provenance.sourceSystem, "novalure-crm-financial-review");
        assert.equal(result.data.snapshot.pricingReference.id, prior.id);
        assert.equal(result.data.snapshot.pricingReference.version, String(prior.businessVersion));
        assert.equal(result.data.snapshot.pricingReference.contentHash, result.data.snapshot.provenance.sourceHash);
        assert.equal(result.data.snapshot.provenance.sourceRecordId, prior.id);
        const database = (await db.admin.query(`
          select snapshot_hash,crm_financial_snapshot_hash(canonical_snapshot) database_hash
          from crm_financial_snapshots where workspace_id=$1 and id=$2
        `, [f.workspaceId, result.data.id])).rows[0];
        assert.equal(database.snapshot_hash, database.database_hash);
        const events = (await db.admin.query(`
          select event_type,count(*)::int count from crm_financial_events
          where workspace_id=$1 and snapshot_id=$2 group by event_type order by event_type
        `, [f.workspaceId, result.data.id])).rows;
        assert.deepEqual(events, [
          { event_type: "POLICY_BOUND", count: 3 },
          { event_type: "REVIEW_VERIFIED", count: 1 },
          { event_type: "SNAPSHOT_RECORDED", count: 1 },
          { event_type: "SUPERSEDED", count: 1 },
        ]);
        const after = await listFinancialReviewQueue(f.session, f.projectId, f.options);
        assert(!after.some(snapshot => snapshot.id === prior.id));
        const unchanged = await getFinancialSnapshot(f.session, prior.id, f.options);
        assert.equal(unchanged.reviewState, "NEEDS_REVIEW");
        assert.equal(unchanged.snapshotHash, prior.snapshotHash);
      }
    });

    await t.test("projectless DEAL stays owner-readable but fail-closed outside the review queue", async () => {
      const dealId = randomUUID();
      const admin = await db.admin.connect();
      try {
        await admin.query("begin");
        await admin.query("select set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [f.workspaceId, f.userId]);
        await admin.query(
          "insert into deals(id,workspace_id,project_id,owner_user_id,name,stage,value_cents,version) values($1,$2,null,$3,'SYNTHETIC owner projectless review','Verhandlung',777777,4)",
          [dealId, f.workspaceId, f.userId],
        );
        await admin.query("commit");
      } catch (error) {
        await admin.query("rollback");
        throw error;
      } finally {
        admin.release();
      }
      const prior = await insertLegacySnapshot(db, f, "DEAL", 4, "B", {
        projectId: null,
        resourceId: dealId,
      });
      const otherUserId = randomUUID();
      const other = await db.admin.query(
        "insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC other owner',$3,'owner','novalureAdmin','active') returning auth_identity_id",
        [otherUserId, f.workspaceId, `${otherUserId}@example.invalid`],
      );
      const otherSession = {
        ...f.session,
        userId: otherUserId,
        email: `${otherUserId}@example.invalid`,
        name: "SYNTHETIC other owner",
        authIdentityId: other.rows[0].auth_identity_id as string,
        authSessionId: undefined,
      } as AppSession;

      assert.equal((await getFinancialSnapshot(f.session, prior.id, f.options)).id, prior.id);
      const ownerQueue = await listFinancialReviewQueue(f.session, f.projectId, f.options);
      assert(!ownerQueue.some(snapshot => snapshot.id === prior.id));
      const otherQueue = await listFinancialReviewQueue(otherSession, f.projectId, f.options);
      assert(!otherQueue.some(snapshot => snapshot.id === prior.id));
      await assert.rejects(getFinancialSnapshot(otherSession, prior.id, f.options),
        denied("FINANCIAL_SNAPSHOT_NOT_ACCESSIBLE"));
      const input = resolutionInput(f, prior);
      await assert.rejects(resolveLegacyFinancialSnapshot(
        f.session,
        input,
        f.options,
      ), denied("FINANCIAL_PROJECTLESS_REVIEW_UNSUPPORTED"));
      await assert.rejects(resolveLegacyFinancialSnapshot(
        otherSession,
        { ...input, idempotencyKey: randomUUID() },
        f.options,
      ), denied("FINANCIAL_SNAPSHOT_NOT_ACCESSIBLE"));
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and supersedes_snapshot_id=$2",
        [f.workspaceId, prior.id],
      )).rows[0].count, 0);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_command_receipts where workspace_id=$1 and resource_id=$2 and operation='financial.snapshot.resolve_legacy'",
        [f.workspaceId, prior.id],
      )).rows[0].count, 0);
    });

    await t.test("same request replays while competing reviews create exactly one successor", async () => {
      const replayPrior = await insertLegacySnapshot(db, f, "DEAL");
      const replayInput = resolutionInput(f, replayPrior);
      const first = await resolveLegacyFinancialSnapshot(f.session, replayInput, f.options);
      const replay = await resolveLegacyFinancialSnapshot(f.session, replayInput, f.options);
      assert.equal(replay.replayed, true);
      assert.equal(replay.data.id, first.data.id);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and supersedes_snapshot_id=$2",
        [f.workspaceId, replayPrior.id],
      )).rows[0].count, 1);

      const racingPrior = await insertLegacySnapshot(db, f, "PROPERTY_SALE");
      const racingInput = resolutionInput(f, racingPrior);
      const results = await Promise.allSettled([
        resolveLegacyFinancialSnapshot(f.session, racingInput, f.options),
        resolveLegacyFinancialSnapshot(f.session, { ...racingInput, idempotencyKey: randomUUID() }, f.options),
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
      assert(denied("FINANCIAL_SNAPSHOT_ALREADY_RESOLVED")(rejected.reason));
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and supersedes_snapshot_id=$2",
        [f.workspaceId, racingPrior.id],
      )).rows[0].count, 1);
    });

    await t.test("an event failure rolls the successor and receipt back atomically", async () => {
      const prior = await insertLegacySnapshot(db, f, "DEAL");
      const input = resolutionInput(f, prior);
      await db.admin.query(`
        create function qa_g27_fail_review_verified() returns trigger language plpgsql as $$
        begin
          if new.event_type='REVIEW_VERIFIED' then raise exception 'INJECTED_REVIEW_EVENT_FAILURE'; end if;
          return new;
        end $$
      `);
      await db.admin.query(`
        create trigger qa_g27_fail_review_verified before insert on crm_financial_events
        for each row execute function qa_g27_fail_review_verified()
      `);
      try {
        await assert.rejects(resolveLegacyFinancialSnapshot(f.session, input, f.options),
          /INJECTED_REVIEW_EVENT_FAILURE/);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and supersedes_snapshot_id=$2",
          [f.workspaceId, prior.id],
        )).rows[0].count, 0);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_financial_events where workspace_id=$1 and related_snapshot_id=$2",
          [f.workspaceId, prior.id],
        )).rows[0].count, 0);
        assert.equal((await db.admin.query(
          "select count(*)::int count from crm_command_receipts where workspace_id=$1 and idempotency_key=$2",
          [f.workspaceId, input.idempotencyKey],
        )).rows[0].count, 0);
      } finally {
        await db.admin.query("drop trigger if exists qa_g27_fail_review_verified on crm_financial_events");
        await db.admin.query("drop function if exists qa_g27_fail_review_verified()");
      }
      const retried = await resolveLegacyFinancialSnapshot(f.session, input, f.options);
      assert.equal(retried.replayed, false);
      assert.equal(retried.data.supersedesSnapshotId, prior.id);
    });

    await t.test("expected hash, evidence class, review decision and settings capability fail before persistence", async () => {
      const prior = await insertLegacySnapshot(db, f, "PROPERTY_COST_MATRIX");
      const input = resolutionInput(f, prior);
      await assert.rejects(resolveLegacyFinancialSnapshot(f.session, {
        ...input,
        expectedPriorSnapshotHash: "0".repeat(64),
      }, f.options), denied("FINANCIAL_SNAPSHOT_HASH_MISMATCH"));
      await assert.rejects(resolveLegacyFinancialSnapshot(f.limitedSession, {
        ...input,
        idempotencyKey: randomUUID(),
      }, f.options), denied("FORBIDDEN"));
      await assert.rejects(resolveLegacyFinancialSnapshot(f.session, {
        ...input,
        idempotencyKey: randomUUID(),
        reviewDecision: "ACCEPT_BROWSER_AMOUNT",
      } as unknown as LegacyFinancialSnapshotResolutionInput, f.options), denied("INVALID_FINANCIAL_REVIEW"));
      const unevidenced = await insertLegacySnapshot(db, f, "DEAL", 1, "C");
      await assert.rejects(resolveLegacyFinancialSnapshot(f.session, resolutionInput(f, unevidenced), f.options),
        denied("FINANCIAL_EVIDENCE_REQUIRED"));
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_financial_snapshots where workspace_id=$1 and supersedes_snapshot_id=$2",
        [f.workspaceId, prior.id],
      )).rows[0].count, 0);
      assert.equal((await db.admin.query(
        "select count(*)::int count from crm_command_receipts where workspace_id=$1 and resource_id=$2 and operation='financial.snapshot.resolve_legacy'",
        [f.workspaceId, prior.id],
      )).rows[0].count, 0);
    });

    await t.test("unresolved predecessor stays blocked from financial approval events", async () => {
      const prior = await insertLegacySnapshot(db, f, "DEAL");
      const snapshot = await getFinancialSnapshot(f.session, prior.id, f.options);
      await assert.rejects(recordFinancialApprovalEventInTransaction({} as TenantTransaction, {
        session: f.session,
        snapshot,
        correlationId: randomUUID(),
        stage: "REQUESTED",
        actionHash: digest("SYNTHETIC blocked action"),
      }), denied("FINANCIAL_SNAPSHOT_NEEDS_REVIEW"));
    });
  } finally {
    await db.stop();
    const mutableEnv = process.env as Record<string, string | undefined>;
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = previousNodeEnv;
  }
});
