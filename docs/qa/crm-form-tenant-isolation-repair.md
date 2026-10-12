# CRM form tenant isolation repair

> Superseded runtime note: migration 095 and its RLS evidence remain historical and authoritative, but its dedicated public lookup login is not the runtime architecture after migration 096. The canonical successor is the [External Integration Gateway](../security/external-integration-gateway.md). Migration 096 disables `novalure_public_form_lookup`, revokes the old functions, and removes the separate lookup URL/password requirement.

## Scope

Migration `095_form_tenant_isolation` closes the forced RLS omission for `forms` and `form_submissions`. It runs only after `094_website_sales_ingestion`; migration 094 and its checksum are unchanged. The migration removes ambient application and `PUBLIC` table grants, grants only the tenant runtime role, and adds tenant policies with actor and project checks. It creates a separate `novalure_public_form_lookup` login role with no password, table grants, or tenant-role membership. Only that role can execute the published render lookup and submission-scope functions. The render lookup excludes workspace and actor IDs; the server resolves those through the separate scope function only after checking the form proof. The application commits the idempotency receipt and business writes in one tenant transaction. Public HTML and JSON omit CRM routing, ownership, campaign, funnel, and performance fields.

Migration 095 is a manual cutover. The migrator requires an explicit `--only=095_form_tenant_isolation --allow-manual-cutover` after the deployment and database preconditions are checked. It must not be applied to Production from this local evidence alone.

## Executed local evidence

All checks below ran on a clean branch from `origin/main` at `20e2f978540aa34288d432d6db63fda1fe23770b`. The database tests use disposable local PostgreSQL 18 clusters with synthetic tenant data. They are not Production-derived evidence.

| Check | Result |
| --- | --- |
| Lint, typecheck, Next.js build | PASS |
| Unit and integration | 235/235 and 17/17 PASS |
| Website Sales signed and anonymous ingestion, including stale session denial and missing lookup credential | 13/13 PASS |
| Migration 095 isolation and native `pg_dump`/`pg_restore` rehearsal | 1/1 PASS |
| Sales, sales final, and existing 080–083 migration suites | 93/93, 55/55, 15/15 PASS |
| Neon 061 compatibility, G08, D11 migrations | 11/11, 54/54, 1/1 PASS |
| Isolated local sales browser E2E | 20/20 PASS |
| Build metadata, protected preview, U1 C03 manifests | 1/1, 17/17, 2/2 PASS |
| Production dependency audit with system CA | 0 vulnerabilities |

The 095 local matrix checks forced RLS, runtime role attributes, no-context default deny, same-tenant access, cross-tenant denial, published lookup, draft exclusion, table ACL removal, dedicated lookup-role access, runtime denial for both lookup functions, and a native custom-format backup restored into a separate database in the same disposable cluster. It does not model every Production grant or role, which must be checked against the isolated Production-derived branch.

## Coordinated cutover

The release is now a single governed 094 → 095 → 096 sequence followed by deployment of the exact reviewed gateway revision. Migration 096 must immediately follow 095 in the same maintenance window; it seeds compatibility registry records, grants only the new narrow functions to `novalure_app`, and makes the lookup role unusable. No lookup password or separate database URL is created or bound. Follow the [gateway cutover runbook](../go-live/external-integration-gateway-cutover.md). If migration or deployment fails, keep public integration traffic unavailable and forward-fix or execute the approved database/deployment recovery plan; never disable forced RLS.

## Open release gates

- Run a Production-derived isolated Neon branch rehearsal with 094, 095, and 096 plus the exact target role inventory. Verify forced RLS, ACLs, anonymous signed and gateway forms, the disabled lookup login, cross-tenant denial, and a restore path. Keep synthetic and real-origin data evidence separate.
- Obtain exact-head CI and independent AI-agent review on this Draft PR. Resolve any applicable Critical or High finding and re-run the gates for the new head.
- Before Production migration and deployment, verify target branch, database, runtime role, deployment SHA, migration ledger and checksum, secret boundaries, and the manual cutover plan. Production activation and real CRM/Studio E2E remain pending.

Generic published forms require an active owner or admin in their workspace to derive a server-side public submission actor. A workspace without one returns unavailable until its membership is repaired.
