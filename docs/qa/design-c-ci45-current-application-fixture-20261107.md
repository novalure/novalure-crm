# Design C CI45 current-application fixture (7 November 2026)

The native PR132 quality job for `f0e2c2a3be5eaf242dd76c550027c2a8507b78a6`
passed mandatory steps 1–44, then failed the integrated Design C suite in step45.
Its predecessor fixture stopped at106 plus booking108/109, language110 and unit186;
the running application also reads later notification, billing, integration,
exposé, assistant, media and project-wizard contracts. A partial schema must not
be presented as an application failure or made successful by hiding HTTP503s.

The explicit `--design-c` server now selects the checked-in 124-entry application
manifest through201. Each listed migration is checksummed against its unchanged
committed original file. The canonical runner's planning, predecessor validation
and reviewed dual108 contract are reused. Missing original manual prerequisites
are explicitly applied in order, transactionally, with actual ledger readback.
The existing staged087 backfill/Contract bootstrap remains in place.

The historical portable001 vector substitution and manual062 exclusion remain
unchanged. Unused preview097–099 cutovers remain excluded. This fixture is a
fresh loopback synthetic application fixture, not the native125 QA migration
proof, a source-faithful restore, or production acceptance. Default predecessor
fixtures retain their previous schema and mode; current mode requires the actual
booking and account-language predecessors. Original186 moves into its proper
manifest order only in current mode.

Original114 grants the tenant role to its constrained provisioning helper. The
fresh local installer therefore receives ADMIN on that existing role with
INHERIT and SET false. This is confined to disposable neondb_owner. The runtime
remains NOSUPER/NOBYPASS, has no ADMIN memberships and owns no FORCE-RLS table.
Original SQL, policies, application source, workflow and package files are
unchanged. The audit append-only trigger stays enabled throughout.

The browser expectations follow the current product source. The authenticated
blue rail (#1e4fc2), grouped menus and AI/Bots shared section already exist in
starting commit200654c. The positive blue theme assertion checks both its token
and rendered RGB value. Shell readiness also waits for the actual project scope
and selected authorized navigation target. Bots workflows choose the real Bots
tab; the fallback case names its Dashboard target. Search still requires the
real native modal, own persisted contact and foreign-record denial. Fallback,
unknown metrics, responsive layout, login/MFA/CSRF, role/tenant and business
assertions are retained.

Each observed same-origin API request and successful JSON body inspection is
drained before a document navigation, reload or form/link transition. This
prevents destruction of a response body before its existing leak check finishes.
The wait is finite; incomplete traffic and body-inspection errors fail acceptance.
HTTP500, foreign sentinels, browser exceptions and outbound requests are not
filtered. The final assertions now explicitly require zero body-inspection errors.

The later step45 children were inspected at their actual entry points:
`qa-knowledge-browser.mjs` uses the valid direct Knowledge route and current
Knowledge form selectors; `qa-package4-integration.mjs` uses that same route and
forms. Their schema comes from the same completed server fixture. Only the
package4 fixture-mode assertion and controller evidence label required rebinding.
There are no further functional mandatory steps after package4 in this quality
job; the final whitespace gate remains unchanged.

Local verification is deliberately nonbrowser:

- The real disposable PostgreSQL fixture builds all124 checksummed ledger entries,
  seeds the normal synthetic accounts, and exercises the actual Core loader.
  Every module has database provenance, with no moduleErrors; own contact/project
  and foreign-contact exclusion are checked. New relation RLS/FORCE protections,
  the installer-only edge, runtime boundaries and enabled audit guard are checked.
- Two targeted SSR/source contract checks bind the actual selected navigation,
  Bots tab and blue brand selectors. Three response-barrier checks cover a body
  finishing after its request, traffic arriving during inspection, abort completion
  and finite failure for incomplete traffic.
- Focused ESLint, typecheck, syntax and whitespace checks apply to this delta.

No browser, application build, cloud service, provider, deployment, PR mutation
or workflow rerun was started for this preparation. Native CI must run the actual
browser sequence on the final adopted SHA. Interactive acceptance remains with
the designated CRM App Browser chat.


## Follow-up to the actual 7f native result

Native run42380836353/job128427908703 passed steps1–44, then step45 failed
(DesignC7 passed/43 failed; later two suites did not run). The first failure
expected Dashboard but observed the Management/workspaces target. Seven
successful `/api/auth/session` responses timed out in passive body inspection;
server/page error arrays were empty. These failures are retained, not relabelled
as successful acceptance or established product defects.

The fixture now recreates its document on identical/fragment-only URLs, then
requires the actual selected profile to survive that reload before checking the
same original navigation target. Profile persistence uses the product's real
Studio/non-Studio storage-key function. It does not seed preferences or substitute
a different destination. This addresses the source-proven same-document/profile-
listener hazard; native confirmation is still required.

A terminal response-body inspection now also settles the matching request wait.
Failed body inspections remain in the final failure evidence. Timeout diagnostics
retain at most ten pathname/method/status/finish records, without query strings
or payloads. The original caller-owned HTTP500, private sentinel, role/tenant,
search, actual business data, body-error and browser-error assertions remain.

The page's test-only observer additionally reads a clone of the real successful
JSON session-heartbeat POST response. It returns the identical native fetch
promise and original Response to the application. It neither supplies nor changes
any response, header, cookie, CSRF token, authentication state, request or endpoint.
This gives the existing passive inspector a second reader for the heartbeat that
the application intentionally does not consume. It is an observer transport
correction, not a claim that the actual Chromium timeout's cause has been proven.
The native failure did not retain enough request-finished metadata for that claim.

Five new targeted nonbrowser checks pass: actual loopback HTTP verifies exactly
one POST, identical promise/response and original status/cookie/body; a real200
stream without EOF still times out and cannot become successful; a foreign
sentinel remains detected; a failed body inspection remains failure evidence; the
previous unbound wait reproduces its timeout; URL cases distinguish fragment-only
from changed scope. Syntax, focused lint and whitespace checks pass. Existing
unchanged schema/Core/SSR evidence is reused. No browser/build/DB/provider/cloud
execution or CI rerun was performed for this follow-up. No final native PASS is
claimed.

The documented lifecycle is [request, headers, then completed body](https://playwright.dev/docs/api/class-request),
and [Response.finished waits for completion](https://playwright.dev/docs/api/class-response#response-finished).


## Follow-up to the actual01 native result

Run42384706743/job128439539008 passed mandatory steps1–44. Step45 reached
30 passed cases (all functional cases and1440px) before20 failures. The first
remaining pending GET `/api/crm/expose-template-assets` had no response headers
and no request-finished event. Its source consumer reads `response.json()` and
aborts its original fetch on effect cleanup; there is no request-dedupe cache.
Thus that case has no body to clone. The artifact also retains24 passive CDP
body-read failures after navigation on other successful API responses. Heartbeat
bodies completed; server/page error arrays stayed empty. Later suites did not run.

The follow-up observes every original same-origin API Fetch promise directly.
Its actual fulfillment/rejection and original AbortSignal are independent of CDP
request-finished events. A signal event alone never settles the wait. Successful
JSON bodies are read through their original Response clone to EOF and hashed;
only pathname/method/status/phase/hash metadata and foreign-sentinel booleans
cross the test binding. Original promise/Response, cookies, CSRF, requests and
application source remain untouched. No request is added, replayed or fulfilled.

Native network events still require matching original-Fetch start coverage and
actual completed JSON-body proofs, including duplicate cardinality. Missing,
unsettled or malformed proof fails closed. Non-Fetch API transport retains its
existing body inspector; HTTP500 and all original role/tenant/business/exception
assertions remain. The old duplicate CDP Fetch body reader is replaced by this
covered browser-owned reader, not filtered by its error messages or endpoint.
An active never-headers request and a never-ending200 JSON body still time out.
A rejected unsafe request remains an unknown-outcome failure.

A retiring non-keepalive document GET with no headers is explicitly recorded as
a canceled read, with no body or API-success claim. A pending write, keepalive
request or already received but uninspected body on retirement remains failure.
All original Fetch starts require a terminal record; a missing cancellation or
missing body cannot disappear during document changes. Bounded quiet turns and
pre-action drains also let React's pending effects register their requests.
Late native/bridge events are re-observed within that same15-second budget; no
endpoint, mutation or request is retried.

Thirteen targeted transport checks pass, including actual loopback HTTP and
Fetch/stream controls for ordinary APIs, private query/header redaction, one
request and identical native promise/Response/auth/CSRF behavior, actual Abort
rejection, ignored-Abort negative control, never-headers/never-EOF failures,
document retirement, unmatched/duplicate network coverage and retained non-Fetch
barriers. Focused lint, syntax and whitespace pass. There is no browser/build/DB/
provider execution, CI rerun or native PASS claim for this draft. The precise
original browser-promise outcome of the01 assets request was not retained; that
cause remains an inference for native confirmation, not a declared product fix.
