# CRM form tenant isolation repair

## Scope

Migration `095_form_tenant_isolation` closes the forced RLS omission for `forms` and `form_submissions`. It runs only after `094_website_sales_ingestion`; migration 094 and its checksum are unchanged. The migration removes ambient application and `PUBLIC` table grants, grants only the tenant runtime role, and adds tenant policies with actor and project checks. Published anonymous form lookup uses a narrow SQL projection; internal routing fields are fetched only inside the bound submission transaction. The application commits the idempotency receipt and business writes in that same transaction. Public HTML and JSON receive a view without CRM routing, ownership, campaign, funnel, or performance fields.

Migration 095 is a manual cutover. The migrator requires an explicit `--only=095_form_tenant_isolation --allow-manual-cutover` after the deployment and database preconditions are checked. It must not be applied to Production from this local evidence alone.

## Executed local evidence

All checks below ran on a clean branch from `origin/main` at `20e2f978540aa34288d432d6db63fda1fe23770b`. The database tests use disposable local PostgreSQL 18 clusters with synthetic tenant data. They are not Production-derived evidence.

| Check | Result |
| --- | --- |
| Lint, typecheck, Next.js build | PASS |
| Unit and integration | 235/235 and 17/17 PASS |
| Website Sales signed and anonymous ingestion, including stale session denial | 12/12 PASS |
| Migration 095 isolation and native `pg_dump`/`pg_restore` rehearsal | 1/1 PASS |
| Sales, sales final, and existing 080–083 migration suites | 93/93, 55/55, 15/15 PASS |
| Neon 061 compatibility, G08, D11 migrations | 11/11, 54/54, 1/1 PASS |
| Isolated local sales browser E2E | 20/20 PASS |
| Build metadata, protected preview, U1 C03 manifests | 1/1, 17/17, 2/2 PASS |
| Production dependency audit with system CA | 0 vulnerabilities |

The 095 local matrix checks forced RLS, runtime role attributes, no-context default deny, same-tenant access, cross-tenant denial, published lookup, draft exclusion, table ACL removal, and a native custom-format backup restored into a separate database in the same disposable cluster. It does not model every Production grant or role, which must be checked against the isolated Production-derived branch.

## Open release gates

- Run a Production-derived isolated Neon branch rehearsal with the exact migration and target role inventory. Verify forced RLS, ACLs, anonymous signed and generic forms, cross-tenant denial, and a restore path. Keep synthetic and real-origin data evidence separate.
- Obtain exact-head CI and independent AI-agent review on this Draft PR. Resolve any applicable Critical or High finding and re-run the gates for the new head.
- Before Production migration and deployment, verify target branch, database, runtime role, deployment SHA, migration ledger and checksum, secret boundaries, and the manual cutover plan. Production activation and real CRM/Studio E2E remain pending.

Generic published forms require an active owner or admin in their workspace to derive a server-side public submission actor. A workspace without one returns unavailable until its membership is repaired.
