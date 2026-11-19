# Direct numeric helper: component integration

Dependencies in this branch: root UI `2a7ac7f2943fad98b8de510cb33914fcb0edf682`, lifecycle fix `0eafd70`, and helper cherry-pick `6bca6f8` (original independently tested helper commit `6330b44923906d2bf8acd9f9b00a8e04bd33af9e`). The backend validation/idempotency dependencies recorded in `qa/property-direct-create-2026-11-04/validation.md` remain required.

The direct form normalizes a copy of native number-control strings before generating property details, cost rows, the serialized body and public-price fallback. Original input strings remain in the in-memory draft for correction and exact submitted-value comparison. A retry sends the frozen original body and identifiers without recomputing projections. Exponents, disallowed precision, negative and unsafe amounts fail locally before an attempt is created; a localized message leaves inputs editable. The German/locale EUR text parser and guided/text editors are unchanged.

Final checks:

- `node --import tsx scripts/property-direct-create-ui-tests.mjs`: **18/18 passed**, no browser errors, on the loopback server with real components under React StrictMode and synthetic HTTP. New integration proof enters native price `1.000`, area `80.1000`, rooms `2.500`, year `2000.000`, and cost `1.010`; the outgoing body contains `1`, `80.1`, `2.5`, `2000` and `1.01`. The public-price fallback and duplicated purchase-price detail also contain `1`. The actual server EUR parser reads the request price as 100 cents and cost as 101 cents. A network failure and real section unmount preserve raw UI strings and replay the exact normalized request. Native-valid `1e3` produces no request and leaves the draft editable.
- `node --import tsx --test scripts/property-direct-numeric-tests.ts scripts/property-direct-numeric-browser-tests.ts scripts/property-create-lifecycle-tests.ts scripts/property-cost-draft-tests.ts`: **15/15 passed**. Includes native DOM, exact safe-cent limits, all six cost amounts, blank versus explicit zero, existing cost drafts, and stale receipt/lock guards.
- `npm run typecheck`: passed.
- Focused ESLint across all changed source/tests with `--max-warnings=0`: passed.
- `git diff --check`: passed.

Evidence: `component-browser-results.json`, plus the independent helper evidence `validation.json`. These are local UI/helper/store checks, not production or database/role acceptance. No paid calls, live writes, deployment, migration or customer data were used.
