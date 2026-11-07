# Late property save and CRM scope refresh

Exact parent: `933a54660fa0be1368bd8b32dc077451cdb63bd6`. This follow-up changes only the CRM parent's core refresh/workspace-switch request guards; all Assistant components and the earlier property fixes remain unchanged.

The existing `createCrmCoreRequestGuard` was present but unused. The parent now owns tickets for the displayed workspace and signed-in identity. Refreshes can commit data or error status only while their ticket is current. Switching workspace invalidates old refreshes before loading the new scope; only the current switch can commit its data or failure. Old callback instances are disposed synchronously in layout cleanup at a committed workspace/identity change or unmount. Therefore a confirmed A save can retire its own command without fetching or installing A's data after the UI moves to B. Existing refresh return values and same-workspace switch behavior remain compatible.

Verification uses the actual mounted `CrmWorkspace` and actual `PropertyCommandCenter`, with React StrictMode, on owned loopback HTTP. Unrelated panels, CSS and Next router primitives are stubbed. A test-only observer exposes the existing parent handlers/state for deterministic response ordering; it is injected by the test bundler and is absent from production source.

- Immutable baseline: `CRM_QA_CORE_REFRESH_BASELINE=1 node --import tsx scripts/crm-core-refresh-ui-tests.mjs` loads the parent source directly from commit `933a546` without changing the checkout. It reproduces the actual property-save callback: A save is delayed, B switch and B refresh complete, then A save succeeds. The active workspace remains B, but the old parent sends another A core request and replaces B's project dataset with A's. **One baseline reproduction passed.**
- Fixed source: `node --import tsx scripts/crm-core-refresh-ui-tests.mjs`: **6/6 passed**, no browser errors. Covers the real late A property-save callback after B is active, a separately delayed A core response after B refresh, an older same-workspace 500 after a newer successful refresh, a previous identity's response after the new identity refreshes, recovery after a failed workspace switch, and retirement of the previous identity ticket observed during the new identity's synchronous layout phase.
- `npm run typecheck`: passed.
- `npx eslint src/components/crm-workspace.tsx scripts/crm-core-refresh-ui-tests.mjs --max-warnings=0`: passed.
- `git diff --check`: passed.

Evidence: `baseline-results.json`, `browser-results.json`. Earlier direct-entry/lifecycle checks remain separately recorded (18 browser checks and 15 helper/store/cost checks); they do not count as extra scope-refresh tests.

Bounded independent review found the initial passive-effect cleanup left an identity commit-to-effect timing window. The follow-up uses layout cleanup and the sixth actual-parent check verifies the ticket is already invalid at that synchronous boundary. The precise network microtask window was not separately reproduced; that sub-case is supported by source timing and the guard lifecycle observation.

Local qualification only: no production requests, paid services, database/role acceptance, deployment or migration. This is a bounded scope/race correction and peer review, not a full security audit. It does not replace all application-wide navigation or identity lifecycle testing.
