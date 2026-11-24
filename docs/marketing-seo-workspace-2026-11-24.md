# Project-scoped Marketing SEO workspace

The existing Marketing hub now has an SEO section for project website bindings,
executed audit imports, search-period reporting and evidence-backed action review.
It uses the current CRM membership, analytics module, project grants, command
receipts, audit logs and forced row-level security. It creates no shadow contacts,
leads or sales results and makes no ranking guarantee.

## User flow

1. Open Marketing → SEO and select an authorized concrete project.
2. Register its public HTTPS origin. This is a project binding, not proof of site
   ownership or permission to access a search-engine account.
3. Select that site. “Prepare an audit for this project” offers a copyable Evelyn
   PowerShell audit command containing the real current workspace/project IDs and origin.
   Copying the command does not run it. Execute it only in an authorized Evelyn
   checkout with the appropriate target scope. Hostnames must have valid normalized
   DNS labels and every context argument is explicitly PowerShell single-quoted.
4. Import the resulting `novalure.seo.v1` JSON file or paste its JSON. Tenant,
   concrete project and origin must already match; the CRM never silently rebinds
   a standalone report. No raw HTML, credentials or credential-bearing URLs are
   accepted in the report contract.
5. Open a saved report. Review crawl coverage, original findings, prioritized
   actions and any provided search period. Query, device and country filters
   operate on supplied rows. Clicks, impressions, CTR and weighted positions
   describe those rows, not a complete property's Google dashboard totals.
6. Record action status with an exact comparison revision. “Technically reviewed”
   and “dismissed” require a bounded evidence/reason note of at least ten
   characters. That review says nothing about Google indexing, ranking effect,
   causality, leads or revenue. The source report remains immutable.

The all-project view is read-only and shows only currently accessible projects.
An unavailable schema produces an explicit unavailable state, never sample KPIs.

## Storage and boundaries

`189_marketing_seo_workspace.sql` adds four narrow tables: immutable site bindings,
immutable report snapshots, CAS-versioned action state and append-only action
events. All use existing classification and project isolation. There is no delete
API. An action event must match its current source state and authenticated actor.
Deferred constraints validate sites, reports and action events against the exact
audit/receipt workspace, project, actor, operation and source entity after the
existing command layer inserts its receipt. Report action IDs and state counts
must be complete at commit; SQL imports cannot claim completed actions. Reads
revalidate the report contract/hash and require all original action states.

Imports use the authenticated workspace and an explicitly checked project grant.
Report-provided IDs are data and cannot grant authority. The read and command
paths revalidate current membership and project/module access, including before
idempotent replay. Service identities have no implicit access to this new personal
workspace API. Mutations use the existing endpoint-bound CSRF client and UUID
idempotency/correlation metadata. Unknown save results keep the exact pending
request for retry, without allowing a different mutation to reuse its key.

The body/report limit is 2 MB; contract limits are 500 pages, 2,000 findings,
2,000 actions and 5,000 search rows. Unknown fields, duplicate IDs/dimensions,
unmatched findings/actions, foreign active URLs, inconsistent coverage and
fabricated imported completion statuses are rejected. A canonical URL may be an
observed public HTTP/HTTPS reference, including a wrong origin, so a bad canonical
can be reported; it is never fetched by this CRM feature. Stored origins are
normalized without a trailing slash. Reads expose at most 200 sites and the latest
50 report summaries; a report selection returns its bounded original evidence.

Imports do not attest the named Google/Bing source, account ownership, CSV
completeness or API authorization. Query/page grouping can legitimately differ
from property totals and omit anonymized queries. Missing search data stays
unknown. Imported evidence is rendered as text, without executable HTML.

## Local verification

Dependencies were reused through a local junction only after comparing identical
`package-lock.json` hashes with the existing 34aefa9 checkout. No installation or
new dependency-integrity claim is implied. Read the repository's bundled Next.js
16.4.5 route-handler and server/client guidance before implementing the feature.

Commands:

```text
npm run test:marketing-seo
npm run qa:marketing-seo
npm run test:livelisted
npm run lint
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm run build -- --webpack
```

The SQL suite creates only a disposable loopback PostgreSQL cluster and consumes
no environment DSN. It covers installation readiness, strict import validation,
actual persistence, immutable evidence, source/history linkage, idempotency,
revision conflict, mandatory review evidence, tenant/project isolation, fresh
revocation before replay, search summary semantics and module denial. Its partial
historical baseline deliberately excludes unrelated manual production cutovers
and optional vector support, as described in `scripts/lib/local-sales-db.mjs`.
This is not a full live migration rehearsal.

The browser fixture renders the actual component and Tailwind CSS on loopback.
Its auth, HTTP and persistence are explicitly mocked; SQL behavior is tested
separately. It checks truthful empty state, focused import errors, foreign scope
denial before mutation, copyable scope, JSON upload, escaped hostile text, search
filters, evidence-required review, unchanged retry metadata, keyboard use and
desktop/tablet/390 px layouts. Screenshots/results/logs use the ignored dedicated
`.npm-cache/qa/marketing-seo/` directory. They are synthetic component evidence,
not a live CRM login or provider test.

A real Evelyn-produced `novalurestudio.ie` report with 29 checked pages and ten
findings passed a read-only consumer parse. Its `novalure` / `novalure-studio-ie`
scope remains declared standalone metadata; it was not rebound or imported into
a CRM tenant.

The broad existing unit command was run both on this change and on untouched
34aefa9 sources: both returned 249/260 passing, the same eleven failures. These
cover existing task fallback, booking-schedule/source assertions, localization/KPI
copy, baseline Next versions, write-route source assertions, public landing proof,
LeadInbox layout and security-header source expectations. They are unresolved
baseline checks, not passing evidence and not waived by this feature.

The broad domain run returned 365 passing, three failing and one skipped out of
369 tests. Its three failures were reproduced on untouched 34aefa9 in the exact
affected suites: newsletter cancellation/claim serialization, a property asset
fixture missing `pu.balcony_area_sqm`, and OpenImmo CHANGE/DELETE XSD validation.
The 23-test baseline subset returned 20 passing/three failing. No existing control
or assertion was weakened. The final focused SEO suite has ten tests, including
the additional independent-review security regressions; the browser fixture has
seven checks. Broad results are not represented as an all-green release.

Independent review identified unsafe shell-host interpolation, missing-version
SQL null handling, insufficient audit scope, incomplete raw-SQL report states and
entitlement checks occurring after receipt replay. These were corrected with the
DNS/PowerShell, deferred audit/source, SQL completeness and fresh-authorization
controls described above and covered by the targeted negative tests. No hostile
command was executed.

Final frozen-source local outcomes: focused SQL/domain tests **10/10 PASS**,
component browser checks **7/7 PASS**, full lint with zero warnings **PASS**, and
optimized Next.js webpack build including its TypeScript check **PASS**. The build
produced 192 routes/pages; source guards and the quoted PowerShell interface were
confirmed in its output. Standalone TypeScript validation also passed earlier.
These outcomes do not turn the baseline unit/domain failures above into passes,
nor do they claim hosted CI, a live migration, production login or provider success.

## Remaining release and integration work

- This change does not apply migration 189 or deploy an application. Follow the
  existing target identity, exact-revision review, backup/recovery, migration,
  rollout, monitoring and release gates. Current broad baseline failures remain
  material release limitations until classified and resolved through those gates.
- Google/Bing source labels on imported files are not a verified live adapter.
  Actual account permission, provider data and safe host-side credential paths
  require their own real integration evidence. The producer may use its approved
  read adapters; the CRM stores no OAuth tokens and initiates no provider call.
- This workspace does not fetch sites or publish SEO changes. Actual fixes belong
  in the existing customer website/CMS workflow with tests, versioning and release
  controls. Personal tokenized Exposé pages retain their indexing/privacy boundary.
- Real-user Core Web Vitals, Google rendering/indexing, local Maps visibility,
  browser accessibility and post-change business/ranking effects need separate
  measurements. A successful import or action review cannot substitute for them.
- Reports/history are bounded snapshots. Automated scheduled collection, signed
  producer attestation, richer retention/pagination and direct source-to-CRM
  delivery are separate future integrations, not silently activated here.
