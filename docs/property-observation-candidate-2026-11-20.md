# Property observation — guarded CRM candidate

This source candidate adds a default-disabled, read-only endpoint at `POST /api/integrations/evelyn/property/observation` and a staged database-grant candidate. It does not seed an identity or grant, run a migration, change the existing synthetic machine principal, publish a deployment, or prove access to actual customer data. The intended receiver is an internal Evelyn workload, never an end user or model directly.

The request is exactly `{workspaceId, projectId, unitId, fields}`. A caller cannot select an actor, purpose, CRM origin, SQL, or a write operation. A separately verified Vercel OIDC token must carry the dedicated `urn:novalure:crm:property-read-v1` audience and match an explicitly configured property workload identity. A different audience, wrong workload, missing feature switch, or expired identity is denied. The actor is resolved from a separate stored exact-scope grant bound to the dedicated database `session_user`; ambiguous actor bindings are denied. Active membership, CRM project access, classification/purpose, object scope, requested fields, identity, grant expiry, revocation, and kill switch are checked within the read transaction. Grants, memberships, project access and the selected property row are locked through the read, token JTI is consumed transactionally, and DB-derived remaining lifetime is rechecked after the read, after asynchronous commit and immediately before response construction. Actual delivery over the network is not atomic with a subsequent revocation. Credentials and token material are never returned.

The response is the versioned `crm-property-observation-v1` contract agreed with Evelyn: scope, authenticated actor, exact build revision and deployment, object version/time, and requested fields. A raw zero stays zero, an explicit null stays unknown, a field not selected by this implementation is `NOT_EXPOSED`, and an unfamiliar status is `UNKNOWN`. The candidate projects the four base fields plus balcony, terrace and garden area and underground parking, carport and outdoor parking counts, only when each is requested and covered by the exact grant. Detail fields follow the explicit nullable semantics of source migration 186; the staged candidate rejects missing or mismatched detail columns before installing its tables or functions. This structural check is not proof that a real target ran the migration or that its data and source history are trustworthy. Existing legacy database defaults may have already turned an unknown into zero or `available`; the response therefore explicitly says `authority=NOT_ESTABLISHED` and `sourceApproval=NOT_EXPOSED`. A successful response is not a verified property fact or a license to communicate it externally.

The migration at `migrations/staged/property_observation_grants_candidate.sql` is deliberately outside the normal forward-migration selection and creates no principal or grant. It adds forced-RLS grant and append-only authorization-check audit tables, and narrowly scoped database functions. The new dedicated DB login does not inherit `novalure_tenant_app`, cannot read/write business tables or call unrelated SECURITY-DEFINER functions, and uses only exact-scope functions. Direct runtime-role grant table access and shared-tenant-role function execution are denied. Identity claims are cryptographically verified in the server; database `session_user` must independently match the stored grant, so SQL claims or caller-set GUCs alone do not select a different grant. The audit records an allowed grant check within the transaction, not proof of a customer-facing statement. Denied-request observability and owner-authorized grant provisioning/audit need integration before production.

Before any real connection: independently review the candidate and migration, reconcile migration numbering and schema against the actual CRM target (which differs from `main`), verify a new dedicated OIDC audience can be issued to the intended workload, establish the server-side identity and narrowly scoped property grant through the approved control path, prove current source/build/deployment, database/branch/endpoint/TLS identity and credential boundaries, and run applicable isolated integration, security, backup, rollback and monitoring checks. The production property pool is intentionally hard closed until the target-binding implementation exists; it never falls back to the ordinary CRM pool. No grant, project, unit or field may be guessed or inferred from this document. The staged migration is not authority for production execution.

`npm run test:crm-property-observation` covers the contract, signature-verifier boundary with an injected local verifier, a synthetic HTTP handler and a disposable PostgreSQL database. The test does not call Vercel OIDC or a live CRM, and therefore does not prove that the provider issues the configured audience or that any real identity or rights exist.

The disposable test schema applies the local sales helper's compatible migrations through 188. That helper intentionally omits some migrations and pgvector, so this is a partial synthetic schema, not evidence of a full upgrade or compatibility with any live database.

`FOR SHARE` on the selected property and project serializes same-row updates
and deletes through transaction commit, regardless of which compliant writer
issues them. The staged `BEFORE UPDATE` trigger advances the unit's `version`
exactly once for legacy writes, UPSERT updates and writers already setting
`version + 1`; jumps, regressions and numeric overflow fail closed. Unit ID,
workspace and project are immutable under this staged policy. This impacts
all existing unit writers and must be compatibility-tested before migration.
The reader intentionally does not interpret `projects.status`: other CRM
paths exclude archived projects from creation, but a general prohibition on
historical reads is not established. An explicit permitted-status policy and
actual CRM semantics must be resolved separately.

Local concurrent database tests cover writer-first and reader-first updates,
project-grant revocation, member revocation, project status changes and unit
deletion while a read holds locks, plus legacy UPDATE/UPSERT, existing CAS,
version jumps and overflow. The deletion test rolls back; immutable dependent
CRM receipts may themselves reject a delete. The trigger does **not** prevent
deletion and later reuse of the same unit ID, protect already published old
versions before installation, attest complete source history, or prove that
all authorization sources or downstream effects participate. In particular,
delivery or an action after COMMIT is not serialized against a later source,
grant, membership, project or object change. Reused IDs and pre-install
observations must remain blocked by a separately reviewed generation or
non-reuse protocol before the version can be a real effect fence. None of
these tests proves the live target has the staged schema or the right owner,
role, RLS and protected trigger configuration.
