# Studio SOURCE reader

`POST /api/integrations/evelyn/studio/source` reads already accepted Studio transfers for the fixed Studio workspace and Eigenakquise CRM project. It does not finalize transfers or write CRM records. The endpoint is off unless `CRM_STUDIO_SOURCE_ENABLED=1` and `CRM_MACHINE_AUTH_ENABLED=1`. The intake works without this optional stage.

## Request and durable position

Send a verified Evelyn OIDC bearer and the separate `x-evelyn-studio-source` capability. The capability is a random 32-byte, unpadded base64url value. JSON has exactly `cursor` (`null` or the last acknowledged cursor) and `limit` (integer 1–25). Evelyn uses 1 so it can persist each position after the corresponding A1 promotion. The response envelope contains `events`, `nextCursor`, `hasMore`, `sourceGrantId`, `receiverDeploymentId` and `receiverRevision`. Each event contains exactly `state`, `operationId`, `revision`, `payloadHash`, `workspaceId`, `crmProjectId`, `leadId`, `submissionId`, `acceptedAt` and `syntheticTest: false`. UUIDs are canonical lowercase and the timestamp is UTC to milliseconds. Customer content and contact details stay in CRM.

Evelyn derives the stable event and mission IDs with its existing `a1-studio-source.ts` contract. Replaying an unacknowledged cursor returns the same immutable transfer and ID. Persist `nextCursor` only after the A1 event has been durably promoted. An empty page has `nextCursor:null`; keep the previous position. Use `cursor:null` only for the initial consumer position, never to recover from a rejected or missing saved position. A scope inconsistency yields a held page with no advance.

The stage assigns a `CACHE 1` sequence at each accepted transition under the existing Studio workspace media lock. The activation trigger uses that same lock to freeze one exclusive starting position. Pre-stage rows have no sequence. Earlier sequenced rows stay below the activation boundary. A later commit cannot appear behind an already returned position. UTC display timestamps do not participate in ordering.

## Stage and registration

Apply `migrations/staged/evelyn_studio_source.sql` only in the protected migration transaction. The existing bounded NOLOGIN installer needs scoped ownership of `studio_enquiry_transfers`, plus its installation-time schema create authority. It must not have superuser, BYPASSRLS or runtime membership. The stage leaves the existing Studio row policy in place, adds one bounded installer-only read policy for exact Sales receipt checks, and grants only execution of the two narrowly scoped runtime functions. The database migration does not register a consumer or activate the feed.

Once the exact Vercel deployment ID and Git SHA have been read back from the native platform and the target has passed its gates, register its SOURCE grant under the existing operator authority. Store SHA-256 of the **ASCII base64url capability** in the registry. Keep the capability itself only in the authorized Evelyn sender. Production grants bind the already registered active Evelyn autonomous CRM workload UUID, the server-fixed Studio workspace/project, the registered Vercel deployment and revision, an authority reference and an expiry. Production uses the existing Production OIDC claims and the native Misty main runtime. Install the single activation row under the explicit profile at the agreed boundary. The trigger records the verified target and cutoff. Keep the activation record and key immutable.

Register a new deployment or credential as another grant for the **same profile and workload** and revoke the old grant as required. The cursor signature is tied to the durable activation, profile and workload rather than to a deployment or credential. A previous position remains usable after a gated release or rotation. A changed workload or target requires a separately verified migration of the saved position. It does not trigger a new activation or a return to the initial cursor.

Before a planned revocation, reconcile promoted A1 tasks that still carry the prior grant. Emergency revocation holds their new Sales effects. Their existing receipts and event identities remain available for authorized recovery.

The protected Sales command provides the signed `sourceGrantId` with its already authenticated and locked workload UUID. The DB checks that grant under a shared lock and verifies the exact post-activation accepted transfer while the regular Sales actor and project/write checks remain in force. Revocation prevents a new effect. Recovery of an already applied Sales receipt follows the separate current Sales authorization path.

## Protected Preview

Preview additionally requires `CRM_STUDIO_SOURCE_PREVIEW_ENABLED=1`, the unique native CRM deployment hostname and a separately registered exact Preview deployment/SHA with a separate capability. The sender uses its real Evelyn Vercel Preview OIDC identity with audience `urn:novalure:crm:studio-source:preview:prj_R32Okl6AHijTohvuKmryuTLjWMsk`. The receiver checks the Long Fog pooled endpoint and the native database project `long-fog-84900593`, branch `br-summer-mountain-bh7w67e3`, database `neondb`, and `novalure_app`. Preview cannot use a Production grant or authorize a Production Sales effect.

Use protected synthetic data only. Record the isolated creation and cleanup of a production-shaped accepted fixture separately. Its false flag is the protocol shape under test and does not establish a production customer transfer. A genuine Preview intake keeps its true synthetic marker and must be excluded from the feed. Keep fixed scope negatives, grant revocation, ordered completion around activation, restart on a saved cursor and exact projected values in the affected evidence. Keep the native Preview and production readbacks separate.

## Retiring an owned Preview fixture

`migrations/staged/evelyn_studio_source_qa_retirement.sql` is a separate additive,
LongFog-only stage. The previous eight stages remain unchanged. Its installer
must be the existing non-login, non-privileged SOURCE metadata owner; it rejects
a changed original matcher or a second wrapping. It preserves the old Preview
matcher as an owner-only implementation. The public matcher retains the original
authentication and grant locks, then rejects an exactly retired tuple.

The normal Preview SOURCE reader requires this stage and fails closed without
it. Retirement is considered before ordered candidate selection and its limit.
Production uses its unchanged SQL and does not require the QA-only schema.
Activation, sequence and signed cursor functions are unchanged. An empty page
still returns `nextCursor:null`; keep the existing saved position.

There is no runtime write route or runtime table access. The existing direct
database operator may call `crm_retire_studio_source_qa(plan)` only as the real
`neondb_owner` session and role on native LongFog. Its existing SELECT and audit
INSERT authority is checked; no human identity, cookie or MFA session is assumed.
It binds only the fixed tenant locally for the existing SOURCE-owner receipt
policy; it does not install or impersonate an application actor.
The stage grants only that operator EXECUTE for this write and the tenant runtime
EXECUTE for a narrow boolean retirement predicate.

The strict plan contains `tuple` (operationId, workspaceId, crmProjectId, revision,
payloadHash, leadId, submissionId, sourceSeq as a decimal string, acceptedAt at
the original database precision), `originalGrant` (id, deploymentId, revision),
`qaRunPrefix`, `provenanceSha256`, `authoritySha256`, `hostScopeDecisionSha256`,
`hostScopeDecision: "RETIRE_OWN_QA_NO_PENDING_PROMOTION"`, and `receiver`
(the admitted deploymentId and revision). Root must verify those referenced
source/host/scope decisions and the native receiver before submitting a plan.
Hashes or a literal decision alone do not prove a host position. An UNKNOWN
host position does not authorize executing retirement.

The operator call uses the existing shared QA/media locks and locks the grant
registry against concurrent registration. All active SOURCE grants must be gone.
The exact accepted tuple, its revoked original Preview grant and matching owned
QA markers in the original Lead and Submission are checked. Customer records
without this independently verified fixture lineage cannot use this path.

One statement atomically appends an `audit_logs` action with `actor_user_id=NULL`
and server-derived DATABASE_OPERATOR identity, followed by an immutable retirement
record. The insert guard checks the audit's current transaction as well as its
exact action, tuple and plan. An identical plan returns the original audit UUID;
a changed plan holds. UPDATE, DELETE and TRUNCATE are forbidden, including for
the metadata owner. Original transfer, snapshot, Lead, Submission, grant and
existing audit records are preserved.

Install the additive schema before binding the new Preview build. Applying the
stage creates no retirement, grant or activation. A rollback retains its ledger;
before returning to a reader without retirement support, revoke the owned active
QA SOURCE grants and stop that consumer. Do not re-enable the old reader against
retired events with a new grant, erase history, or reset flags, cutoff or cursor.
