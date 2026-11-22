# Website Sales discovery and CRM matching

`website-sales-discovery-v1` extends the existing Ireland / internal WEB_DESIGN
workbench. Public research candidates need no CRM company/location UUID. The
ordinary session/CSRF endpoint `/api/crm/website-sales/discovery` matches them
against canonical companies, registered branches, public business contacts and
existing project-scoped leads. Domain equality is a candidate signal only.

The primary workbench entry imports a research JSON file (64 KiB maximum).
Advanced text import remains available. Operators review sourced company and
address facts, select existing records or explicitly request new ones, and record
their rationale. The source draft survives a tab reload. The saved result opens
the existing research form; evidence qualification, scoring, Studio generation
and offers remain owned by the existing services.

Registration rechecks the match under a project-scoped transaction lock. Its
exact match digest binds the reviewed canonical record versions and candidate.
Changed state requires another review. Existing command receipts, audit and
domain events preserve the source snapshot and decision; there is no additional
business master table or schema migration. Branch registration delegates to the
existing company/address deduplication. New contacts use the existing contact
repository and never receive outreach consent. A previously unassigned contact
may be attached only through the explicit reviewed decision; existing assigned
contacts are never re-parented.

An unambiguous existing Studio-form lead and deal are reused during ordinary
qualification. Original source, enquiry metadata and commercial state remain
intact. Multiple, changed, terminal or conflicting inbound chains fail closed.
Other branches keep separate registered location identities and workflows.

Unconfirmed writes preserve their original command and block the other Sales
areas. Reconciliation reads that original receipt even after source expiry. A
NOT_FOUND result performs no registration; a separate explicit action may retry
the exact original. Candidate/decision digests, chosen IDs, tenant/project and
correlation bind every accepted browser receipt.

Matching uses the same Unicode normalizer as source facts rather than an
OS-dependent database collation. The bounded catalog allows at most 1,000
companies and 200 candidate-company locations per project lookup. Overflow
requires indexed/manual review and never becomes a false NEW decision.

## Verification

```text
node --conditions=react-server --import tsx --test scripts/website-sales-discovery-tests.ts
node --import tsx --test scripts/website-sales-discovery-client-tests.ts
npm run test:website-sales-complete
```

Connected acceptance requires the actual companion repository source, not a
stand-in client:

```powershell
$env:EVELYN_WEBSITE_DISCOVERY_SOURCE='C:/Projects/evelyn-website-discovery-20261122/src/business-pipelines/website-sales-discovery-client.ts'
node --conditions=react-server --import tsx --test scripts/website-sales-discovery-connected-tests.ts
```

It executes actual companion discovery/client code, loopback HTTP, normal
persisted sessions, CSRF and restricted PostgreSQL with synthetic source/business
data. The fixture seeds its isolated authenticated session; it does not claim a
browser login or real external-provider acceptance.

For rendered browser acceptance, build the actual application with physical
locked dependencies, start the existing owned server with
`--built --design-c --website-sales-workbench`, and execute
`node scripts/qa-website-sales-discovery.mjs`. The runner performs ordinary
password/TOTP UI login, file import, reload, actual post-commit lost response,
pure original reconciliation, viewport/axe checks and role revocation. Results
and screenshots belong in `.npm-cache/qa/website-sales-discovery/`. Its mere
presence is not a browser PASS; the actual run must complete.

These changes activate no production migration, deployment, machine grant,
provider, paid commitment or customer outbound. Unknown-company discovery does
not inherit the existing exact-company Sales machine grants. The final exact
revision and target still require all applicable release gates.
