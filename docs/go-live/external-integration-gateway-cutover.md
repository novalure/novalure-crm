# External Integration Gateway production cutover

This runbook supplements the repository production policy. Every check is bound to the exact reviewed commit and exact Neon/Vercel targets. Local or synthetic evidence is not Production evidence.

## Preconditions

1. Exact-head repository checks and the trusted independent review pass with no applicable Critical, High, or governance-blocking Medium finding.
2. Record the Production Neon project, branch, database, migration identity, runtime identity, ledger, and current deployment SHA. Confirm the runtime is not owner, superuser, or `BYPASSRLS`.
3. Verify an accepted pre-cutover recovery point and restore procedure, current monitoring, abort criteria, and the rollback deployment.
4. Rehearse the checksummed 094 → 095 → 096 plan on a Production-derived isolated branch. Candidate QA must prove registry routing, wrong-origin/form/project denial, RLS and FORCE RLS, generic public form lookup/submission, training chat, and the independent Website Sales flow.
5. Drain public form writes and start the approved maintenance window. Do not create or reset a lookup-role password.

## Database sequence

For each migration, generate and inspect the guarded dry-run plan token, apply only that exact migration, then verify its ledger checksum and expected objects before continuing:

1. `094_website_sales_ingestion`
2. `095_form_tenant_isolation`
3. `096_public_integration_gateway`

After 095, continue directly to 096; do not reopen customer traffic in the intermediate state. Abort on a target fingerprint, checksum, lock, schema, permission, role, or runtime identity mismatch. Do not edit historical migration files or disable RLS to proceed.

## Post-migration security checks

- `forms` and `form_submissions`: RLS enabled and FORCE RLS enabled.
- All five gateway tables: RLS enabled and FORCE RLS enabled.
- `novalure_app`: non-owner, non-superuser, no `BYPASSRLS`, no broad public table bypass.
- `novalure_public_form_lookup`: `NOLOGIN`, password null, no schema usage, and no executable functions.
- Only `novalure_app` can execute the four migration-096 gateway functions and the three compatibility-named `crm_public_form_*` wrappers that delegate to them.
- No public table grants; no customer database URL or credential; no lookup connection variable is required or present in the deployment.
- `CRM_PUBLIC_FORM_LOOKUP_DATABASE_URL` is explicitly forbidden for Preview and Production, and the Candidate runtime sees zero CRM or gateway rows without server-established tenant context.

## Deployment and acceptance

Deploy the exact reviewed commit to protected Preview/internal scope, verify the immutable commit metadata, then run bounded synthetic tests for valid and invalid form lookup, submission replay, wrong origin, wrong form/project, forged tenant/actor inputs, Website Sales signature/replay, and training chat start/message/context. Confirm synthetic records are flagged and excluded from KPIs.

Only after all database and Preview gates pass, manually promote that exact deployment according to repository policy. Keep automatic customer-domain assignment and unreviewed Git promotion disabled where required. Verify live aliases, application boot, authentication, tenant context, gateway registry, form lookup/submission, Website Sales, training chat, RLS/ACLs, logs, latency, error rate, and the rollback target.

Remove the maintenance window only when all checks pass. If a check fails, stop traffic and forward-fix. Use database restore or deployment rollback only through the approved recovery path and only when schema compatibility has been established.
