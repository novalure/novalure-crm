# Property reader: remaining activation gaps

Status: local staged preparation only. This file is an inventory of examined
paths, not proof that every live writer or authorization source was found. The
property pool remains hard-closed and no migration, principal, secret, grant,
network connection, deployment or real customer action was created.

1. **Target and credentials.** `propertyObservationPool()` always throws
   `CRM_PROPERTY_DB_TARGET_BINDING_REQUIRED`. A replacement must bind the
   real database account, branch, endpoint, TLS peer and dedicated login to
   independently verified provider metadata, not merely a connection string or
   application-set field. Its actual environment and current schema history
   must be verified separately; no secret should appear in logs or model output.
2. **OIDC and receiver identity.** The receiver accepts only the separate
   `urn:novalure:crm:property-read-v1` audience and a verified workload tuple.
   The installed Vercel SDK exposes custom-audience token exchange, but this
   does not prove the intended workload can obtain it, the provider's actual
   `jti` format satisfies this receiver, or current account/project/issuer and
   environment configuration. Verify those via a protected host without
   disclosing a token, and prove the sender pins the provider-verified unique
   CRM deployment URL and refuses redirects across credential acquisition and
   dispatch. Build metadata supplied by a process is not build attestation.
3. **Migration and grants.** The SQL candidate lives under `migrations/staged/`.
   No durable reader principal or scope was provisioned. Before use, reconcile
   full live migrations and dependent roles, function ownership and forced RLS,
   trigger compatibility, exact grant revocation, single-use token storage,
   backup/recovery, monitoring and audited grant administration. The local
   migration test intentionally uses only a partial synthetic schema through
   compatible migration 188. Do not infer production compatibility from it.
4. **Mutation and revocation fence.** The staged function locks membership,
   workspace, project, exact project grant, property grant and unit row until
   COMMIT. The staged trigger covers version progression for SQL UPDATE and
   UPSERT on the unit row, including old writers that omit a version increment.
   Examples in this source tree include inventory/detail updates in
   `src/lib/db/property-inventory-repositories.ts`, default-unit writes in
   `src/lib/db/property-department-repositories.ts`, reservation release and
   synchronization in `src/lib/db/reservation-repositories.ts`, and price,
   reservation and sale mutations in `src/lib/db/property-sales-repositories.ts`.
   Membership and project-access examples include
   `src/lib/db/customer-access-repositories.ts` and
   `src/lib/db/settings-access-repositories.ts`. Direct SQL, other stored
   routines, administrative writers, background jobs and deployment changes
   still need a complete target-specific inventory and independent tests.
   Trigger-owner rights and disabled/bypassed triggers are separate checks.
5. **Deletion and later effect.** UPDATE locking/versioning does not establish
   unique unit identity across DELETE followed by re-INSERT with the same ID,
   nor validate observations made before installation. Establish a reviewed
   non-reuse or durable incarnation/generation protocol before any prior
   object version is accepted for an effect. Grants/membership may change
   after the database COMMIT; HTTP delivery and downstream storage are not
   atomic with that revocation. Property response explicitly has
   `authority=NOT_ESTABLISHED` and `sourceApproval=NOT_EXPOSED`. A real action
   requires its own transactional authority and revocation receiver.
6. **Project status and release gates.** The codebase distinguishes `Aktiv`,
   `Skaliert`, `Review`, and `Archiviert`, and some creation paths exclude
   archived projects. That does not establish whether historical reads should
   be denied. The staged reader locks the project row but does not invent an
   archived-read policy. Resolve the actual product contract; then run exact
   revision CI, independent review, and all applicable target-specific
   identity, quality, isolation, credential, restore, rollout, monitoring and
   cost gates before enabling anything. OpenAI is not used by this candidate.
