# Website Sales workbench

The internal CRM now exposes Website Sales at `/?projectId=<authorized-project>#website-sales`.
It follows the November masterplan's Ireland-first website-sales slice and uses
the existing CRM records and offer service. It changes no Teams or A1 runtime.

The workbench lists accessible internal WEB_DESIGN projects, canonical companies,
contacts and Irish company locations. Its separate bounded read contract is
`website-sales-workbench-v1` at `/api/crm/website-sales/workbench`, with five views,
UUID cursors and at most 50 rows per request. Reads use current membership and
project grants without invoking the core loader, creating defaults or repairing
business records. An authorized workspace switch retains its existing mandatory
security audit.

Operators can register a sourced location, record the three research paths,
qualify current evidence into a linked lead/deal/task, prepare a canonical offer
draft, and explicitly confirm a terminal stop. Stored facts load from the CRM
after a reload. List statuses are historical summaries; current detail and the
existing command service determine readiness, write permission and stop reasons.

The browser uses the existing session and one-time CSRF transport. Uncertain
writes retain the original actor/workspace-bound body, idempotency key and
correlation in bounded session storage, without credentials or CSRF headers.
Reload and component remount preserve recovery. A current scoped read and an
explicit reconciliation are required before another action; reconciliation
resends the original bytes. Invalid recovery state blocks writes. This recovery
record is scoped to that browser tab's session; the CRM remains authoritative.

The UI uses the current components, typography and colors, with German and
English copy and an explicit English fallback for Spanish. It provides labelled
fields, focused error summaries, keyboard controls and large touch targets. It
loads on demand in the browser so recovery state is not prerendered on the server.

## Reproduce verification

```text
npm run test:website-sales-workbench
npm run test:website-sales-workbench-client
npm run build
npm run qa:sales:server -- --built --design-c --website-sales-workbench
```

While the owned local server is running, use a second terminal:

```text
npm run qa:website-sales-workbench
```

The browser fixture composes the unchanged historical application manifest with
the exact pinned migration 202. It uses a disposable loopback database and test
accounts. The browser exercises the optimized application, ordinary password and
MFA enrollment, real CSRF/HTTP/RLS, and independent database readback. Desktop,
tablet, phone, reduced-motion and axe evidence is written only to
`.npm-cache/qa/website-sales-workbench/`. This authenticated internal tool is not
given a public-site jury score. Automated accessibility checks do not constitute
a full WCAG certification.

This implementation does not activate Production, customer communication, a
paid provider, a demo publication or offer delivery. The exact-revision release
gates, including genuine Trusted App attestation, remain applicable.
