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

The independent review of the isolated4048 draft found that its coverage counts
were only compared in one direction. Extra observer starts or body proofs could
therefore pass, and a terminal could retain its id while changing its request
metadata. The follow-up requires exact two-sided request/body multisets and binds
each terminal to its start's key, pathname and method as well as document/id.
Missing or excess counts may settle only inside the original15-second drain
budget; malformed or misbound terminal proofs fail immediately. No request retry,
response waiver or application change was added. Two focused coverage groups
exercise the formerly accepted extra same-key/distinct-id and observer-only
records, extra/missing bodies, duplicate ids, and changed terminal metadata.
The twelve unchanged transport groups above are reused, not rerun. The earlier
4048 source is retained as the reviewed predecessor and is not release eligible.

## Follow-up to the actual BA1 native result

Run42390971619/job128458262765 passed mandatory1–44. Step45 retained
47 Design C passes and3 failures,4 axe scans, and zero page/server/outbound/
private-leak/body-inspection errors. Knowledge and Package4 were not run. The
last operator document records an original team GET rejected on its AbortSignal
before headers, with the remaining11 JSON bodies reaching EOF. Native request
counts and the preceding coverage error were not retained; attributing these
historical failures to the counter mismatch remains an inference.

The actual team hook defers fetch into a promise turn while its effect cleanup
can abort the signal first. [Fetch §5.6 step4](https://fetch.spec.whatwg.org/#dom-global-fetch)
rejects a pre-aborted call before starting fetch. The inspected
[Chromium FetchManager implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/fetch/fetch_manager.cc)
also rejects before creating/starting its loader (observed Gitblob
302a9450b6b6f717fd7e1062dc58e7f30e9d90c7). This is source-contract evidence,
not an executed native153 counter probe; that exact version tag was unavailable.

Only an explicit own data-property signal read through the native AbortSignal
getters synchronously before the call can qualify. Its original promise must
then reject with that identical original DOMException AbortError, for a GET
without keepalive. The call retains its unique document/id/start/terminal and
same key/path/method, but is labeled undispatched rather than successful. No
native event is removed: full two-sided request counts must match dispatched
starts, and every native successful JSON response still needs its actual EOF
proof. An unexpected native request for the canceled call fails; later Abort,
an Abort event alone, POST, keepalive, unknown signal accessors, wrong rejection
objects and malformed cancellation proofs cannot qualify. Ordinary calls to an
identical URL remain separately counted. No API or application behavior changes.

Timeout diagnostics now retain bridge/quiet state and the last bounded coverage
error with hashed key/counts. A remainder too short for the required quiet turns
still fails, and a timer waking after its deadline cannot report success. This
diagnostic change does not convert an unsettled lifecycle or count mismatch into
success. Three focused nonbrowser groups cover actual loopback zero-request
pre-abort plus an ordinary identical-URL request, the negative boundary matrix,
and finite timeout/error preservation. Unchanged transport evidence is reused;
no browser/build/provider execution, CI rerun or native PASS is claimed.

## Follow-up to the actual FD native result

Run42394393423/job128468536585 passed mandatory1–44; Step45 retained2 Design C
passes and1 prerequisite failure at profile choice. The current document had7
completed bodies, zero pending/bridges/errors, but the cumulative audit reported
UNSETTLED_ORIGINAL_FETCH_LIFECYCLE. The previous authenticated document retained
terminal ids1,2,4,5; no endpoint or phase for its missing id3 was exported. The
native login form and helper both navigate naturally, after non-atomic pre-action
drains. This is a historical missing-proof failure, not a demonstrated product
defect or a passing prior-round replacement.

The report path previously always deferred binding invocation through
keyPromise.then, even when the actual hash was ready. At pagehide that callback
can run after its document is destroyed. With a previously computed hash, the
observer now invokes the same metadata binding synchronously inside the actual
lifecycle callback, then tracks its returned promise and fixed bridge errors.
Unknown hashes keep their existing asynchronous calculation. No raw URL/host
hash interface, original-fetch/argument change or lifecycle exception is added.
Pending writes, keepalive, received but unread JSON, missing terminals and all
native count/body obligations still fail. A terminal is never manufactured as
successful or erased because its document retired.

The result exports both complete start and terminal metadata, with only the
existing hashed key/path/method/document/id and fixed observation fields. Query
strings, URLs, bodies and abort reasons are not projected. The internal audit
stays complete; beyond4000 exported events an explicit failure and incomplete
diagnostic marker replace any silent truncation claim. Missing-terminal counts
and at most10 identifying tuples accompany the primary error and final report.
The same complete native/lifecycle assertion also checks the final audit after
context close has delivered its last pagehide records; a new closure failure
cannot be reported as a passing case merely because the earlier drain passed.

Focused cases compare the exact former deferred reporter with synchronous
delivery before immediate simulated document destruction, retain write/keepalive/
real-EOF failures, and exercise synchronous/asynchronous bridge errors plus
complete/private-field-free bounded diagnostics. Unchanged transport and product
evidence is reused. No browser, provider, build or CI rerun is performed here;
actual native confirmation remains required.
# Received-body aborts and destroyed-document evidence

The A607 native second attempt remains a recorded failure: 47 cases passed and
five failed. One operator team GET received successful JSON headers before the
React effect aborted its signal; four distinct viewer starts lost their terminal
delivery in an intermediate document. These are separate evidence failures.

The built Design C fixture now observes the existing Node HTTP server through
its diagnostic channel. Its transparent write/end/header observers retain the
original arguments, callbacks, return values and errors. A body qualifies only
after actual Node `finish`, `writableFinished`, matching declared content length,
bounded decompression and complete JSON inspection. `close`, truncation,
overflow and a stream without end cannot produce EOF. This proves server
egress completion, never browser receipt or original-clone EOF.

The original browser fetch, its signal, native promise/Response and cancellation
remain unchanged. A received-JSON clone failure can be resolved only by the
independent complete server evidence for its authenticated request multiset.
Native counts and all original starts/terminals remain mandatory. Concurrent
equal URLs are not assigned FIFO identities: all matching requests, statuses and
bodies must balance exactly, and every body in the bag must be complete and
inspected. Missing, surplus, mixed-session, ambiguous or incomplete evidence
fails closed. The original body failure stays in the result beside an explicit
server-egress multiset resolution.

Request header fingerprints and response body hashes exist only in host RAM.
The already owned Next, sales-server, package controller and test-runner children
exchange bounded snapshots over their private native IPC channels. They are
never written to a capture file or report. The existing private fixture context
holds only a fresh unrelated capture key/run nonce in addition to its existing
synthetic credentials. Persistent diagnostics use unrelated opaque random
references, counts, paths, status and inspection/EOF booleans. Authentication,
CSRF, reset and invitation body digests are not persisted.

Original lifecycle metadata is sent through native CDP `Runtime.bindingCalled`.
The receiver validates a bounded metadata-only string without looking up or
evaluating a destroyed execution context. This removes the specific deferred
context-lookup drop in Playwright's `exposeBinding` path. No old document is
excluded, no request is replayed, and no terminal or EOF is invented.

Qualification here consists of targeted Node loopback HTTP, IPC and serialized
observer tests, including old-path negatives. It is not a browser, native CI,
protected QA or production result. The package controller is required for the
private capture relay; direct invocation without that channel fails closed.

## Complete authenticated groups after the B4 native failure

B4 run42406747086 passed mandatory steps1–44, then Design C recorded47 passes
and4 failures. All592 original starts have terminal metadata; the former missing
viewer terminals did not recur. The remaining operator team GET received200
JSON, then its original clone failed after a late signal abort. Native body
coverage was18 against17 inspected or qualified bodies, with zero server body
resolutions. No browser/server exception, outbound request or private leak was
recorded. Knowledge and Package4 were not run. These remain native failures.

The old qualifier rejects every URL with more than one native request-header
fingerprint. Native response rows previously lacked that RAM-only binding as
well. The retained B4 artifact contains neither private fingerprints nor server
rows, so it does not prove which predicate rejected this particular execution.

The qualifier now checks every claimed native authentication group separately:
its exact server starts and terminals, complete successful JSON bodies and status
counts must all match. Response fingerprints derive from the same actual
request-header promise as their native requests. Only after all claimed groups
qualify does the complete union of body hashes balance against original inspected
bodies and the remaining late-aborted bodies. There is no FIFO, individual
request or individual session assignment to an unresolved original body.

The global server relay also contains other pages, roles and API probes. An
unclaimed group is excluded from this page's proof and cannot replace any missing
claimed group. Missing or extra records within a claimed group, wrong-session
replacement, missing response binding, incomplete/foreign bodies, changed status
counts and mismatched original bodies still fail. The global foreign-sentinel
check remains mandatory, including unrelated sessions.

Bounded diagnostic records expose fixed rejection reasons, scalar counts and
unrelated random references only. No request-header, URL, response-body digest or
payload is persisted. Targeted loopback multi-session negatives, snapshot and
observer groups plus strict focused lint qualify the helper draft. No browser,
provider, deployment, workflow rerun or native PASS is claimed.
