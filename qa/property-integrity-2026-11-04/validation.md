# Property creation and numeric integrity — local verification

Base: `11c4384c0c5a360e448f441c822edc1057d9fe17`. Branch: `fix/qa-property-integrity-20261104`.

This is local correction evidence. No production data, deployment, provider action, paid call or live acceptance was performed.

## Changes

- SRC-09: creation validates supplied areas, room precision, years, money, classifications, reference identifiers, dates and bounded text before coercion. Invalid input returns a 400 and creates no listing or default unit.
- SRC-05: direct HTTP creation uses the existing CRM command receipt with the caller's stable idempotency and correlation identifiers. The same command returns the original `{data, persisted:true}` shape with `replayed`; altered payload/correlation conflicts. Current role and project authority are checked before receipt lookup. The direct-entry UI must retain both headers and the frozen request across uncertain retries.
- SRC-06: new server writes record `canonicalPayload.coreNumericState` with `version:1` and `areaSqm`/`price` each `known` or `unknown`. Existing scalar columns and consumer types remain numeric. Unversioned historical zero values keep their unknown meaning. A new explicitly entered zero remains known; blank guided inputs remain unknown. `propertyCoreNumberIsKnown` is the shared read boundary. Public-output consumers are integrated separately by the output owner.
- SRC-07: full editing sends explicit null for cleared optional rooms, year and public price, and the locked update persists those nulls. Missing fields in legacy partial commands keep their previous semantics. Full clear of area/asking price updates its knownness atomically and retains the independent internal valuation. Descriptive details and source snapshots retain their existing optimistic conflict protection.

No database migration is required for these changes. Migration 190 is reserved by the separate public-output patch.

## Verification

The final targeted run in `targeted-tests.txt` passed **32 tests** across six suites/files:

```
node --conditions=react-server --import tsx --test scripts/property-create-route-integrity-tests.ts scripts/property-core-number-state-tests.ts scripts/property-create-validation-tests.ts scripts/property-create-draft-tests.ts scripts/property-completeness-tests.ts scripts/property-country-db-tests.ts
```

The new route suite uses real cookie and one-use CSRF handling against a newly initialized loopback PostgreSQL cluster with the existing tenant runtime and RLS. It covers unsigned/CSRF/metadata denial, malformed requests, simultaneous same-key creates, one listing/default unit/receipt, replay and conflicting reuse, fresh role/project denial, explicit null versus zero after reload, stale full edits and injected audit failure rollback. Guided creation also persists distinct blank/zero states and checks all four countries, revocation and rollback. The 125-field and country suites cover preservation and optimistic updates.

TypeScript, focused ESLint with zero warnings, and `git diff --check` passed on the final source. No mounted browser test of the full editor was performed in this subtask. The separate coordinator owns direct-entry UI behavior tests.

The historical sales fixture omits the portable runtime's unavailable optional vector extension and separately managed unrelated manual cutovers as documented in `scripts/lib/local-sales-db.mjs`; this is not a production schema rehearsal. All credentials, rows and fault injections are synthetic and confined to the disposable local clusters. No production security rule was weakened.

## Deliberate compatibility

Legacy matching continues treating non-positive monetary values and zero primary area as unknown; this correction preserves new input meaning without changing commercial matching rules. Percentage purchase-cost calculation still requires a known purchase price; use the existing manual/unknown cost mode before clearing that price. Existing public price is independently nullable: an explicitly known public price must not be suppressed solely because asking price is unknown.
