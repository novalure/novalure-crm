# CRM baseline regression repair

This local candidate builds on the property-detail branch whose CRM live-source
base was `fbc5ee7b`. It does not deploy, connect Evelyn, change a real database,
activate a worker, or contact a customer. The property database pool remains
blocked and the staged property migration remains unapplied.

The previously recorded general unit run was 249/260. One genuine UI boundary
issue was repaired: the task view now uses the explicitly supplied workspace
and does not infer a tenant from the first project or task. With no workspace,
the resulting empty workspace parameter is rejected by the existing server-side
workspace resolver. The daily-work queue now localizes known system lead intent
and next-action text at display time while preserving original stored data.

Other failures reflected intentional changes since older smoke tests. Updated
checks retain the actual guarantees: all current cron routes and schedules are
explicitly pinned and their delegated handlers checked for shared auth, pause,
and run creation; newsletter's legacy endpoint must delegate to the saved
mailing route, and approval, send and test-send must enforce existing sender
permissions and project scope. An isolated PostgreSQL test additionally checks
that a project-sales member cannot approve or dispatch, with synthetic provider
and transport. Existing consent-withdrawal and cross-project denial tests run.
Header verification uses the effective configured global and route-specific
headers; protected CRM/login retain frame denial while embedded routes do not
gain a framing restriction. Current fictional landing data, responsive layout,
language labels and framework version are checked against the existing design.

Local checks: the general unit suite passed 260/260; affected tests passed
52/52; newsletter tests passed 10/10 against a temporary PostgreSQL instance
with a synthetic provider and transport; the property observation suite passed
23/23 with its explicitly partial synthetic schema. Typecheck, lint, a webpack
production build, and full/production dependency audits passed. A final
standalone effective-header check passed after the header assertions were
strengthened. These local checks are not production-schema validation,
exact-revision CI or a trusted-App review; no production authority is inferred.
