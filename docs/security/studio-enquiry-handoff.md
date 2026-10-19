# Studio enquiry handoff: isolated Preview

The original Preview contract below remains applicable to that isolated scope.
The explicit Production counterpart is documented in
[ST1 public launch](../go-live/studio-enquiry-public-launch.md); its separate
target/credential guards and standalone migration100 on096 do not broaden
Preview access or apply its calendar migration097 to Production.

This change implements the server-to-server `studio-enquiry-v1` contract at
`POST /api/public/website-sales/enquiry`. It does not activate Production,
calendar access, invitations, marketing, notifications or the legacy signed
Website Sales route. The separate `STUDIO_ENQUIRY_SIGNING_SECRET` is used only
for this version; it must not reuse the legacy ingestion secret.

## Target and authority

Every live operation requires Vercel Preview project
`prj_R32Okl6AHijTohvuKmryuTLjWMsk`, branch
`codex/studio-preview-crm-handoff`, `STUDIO_ENQUIRY_QA_ENABLED=1`, the matching
`STUDIO_ENQUIRY_QA_CRM_PROJECT_ID`, and a nonempty
`STUDIO_ENQUIRY_QA_APPROVAL_ID`. The configured `DATABASE_URL` must exactly
match `NOVALURE_QA_DATABASE_URL`, its pooled host/name/role and the configured
Neon project/branch. An actual database query confirms those identities and
the migration tables. The QA host must differ from
`NOVALURE_PRODUCTION_DATABASE_HOST`. Existing safe runtime-role checks still
run inside every tenant transaction.

The workspace, form and actor come exclusively from the existing Studio
constants. Caller-supplied routing fields are rejected. The existing external
integration gateway branch and the old v1/calendar contracts remain intact.
Every snapshot is synthetic. Every provided email and phone must appear in
`STUDIO_ENQUIRY_QA_EMAILS_JSON` and `STUDIO_ENQUIRY_QA_PHONES_JSON`, respectively;
an empty list is allowed when that contact type is unused. Email or phone is
required for the selected follow-up channel. Name and company are optional;
neither an email address nor a phone number is converted into a name.

## Immutable confirmation and transfer

The signed body contains `version`, `action`, `operationId`, `revision`,
`payloadHash` and the complete `snapshot`. `Idempotency-Key` must equal the
operation UUID. The HMAC is SHA-256 over
`studio-enquiry-v1.<timestamp>.<rawBody>`, using the existing timestamp and
signature headers with a five-minute tolerance. JSON is bounded to 256,000
UTF-8 bytes while reading the stream. Oversize input is rejected, never clipped.

The snapshot preserves original field values, confirmed summary, open questions,
privacy policy version, file analysis and its limitations, and exact retrieved
website text/URLs. These are customer material, never instructions or permission.
The original serialized snapshot is stored as text so its SHA-256 remains
verifiable without JSONB key reordering. Updates cannot alter its identity,
revision, digest, content or allocated targets. A later edit needs a new confirmed
operation; reusing the previous operation with changed content returns conflict.

`reserve` persists only an immutable reservation. It creates no contact, lead,
submission or media asset. Each file has explicit `original` and `analysis`
roles. Original PDF/JPEG/PNG/WebP bytes and normalized PDF/WebP analysis bytes
each have their own MIME, byte count and SHA-256. Deterministic tenant-prefixed
asset IDs/paths reuse one object when both roles have identical content and MIME;
the two source roles remain separately recorded. The Studio copier must copy
each distinct asset only once.

The existing private CRM Blob credential remains inside CRM. Reservation may
use only `NOVALURE_PRIVATE_BLOB_STORE_ID`; the configured read-write credential
and the issued delegation must both match that exact store. Missing/mismatched
store identity fails closed before any copy grant is returned. Reservation may
return a 120-second, exact-path, exact-MIME, byte-bounded private PUT capability
to the authenticated Studio server. It grants no read, list, delete, wildcard,
overwrite or new random path. These URLs/signing material must never reach the
browser, logs or public source. File bytes go directly to Blob, outside the
Function JSON body. There are at most three logical files, each variant at most
10,000,000 bytes. No application PDF page limit is added.

Before `finalize`, CRM reads the actual private target bytes and verifies length,
SHA-256, MIME and magic bytes. Existing correct objects are reused. A mismatch
is a conflict and is never overwritten or automatically recopied. The final
transaction creates the existing CRM contact/lead/submission, private media rows,
both source-role links, confirmed snapshot metadata and accepted receipt together.
Tasks and outbound form actions are disabled for this server-only enquiry mode;
marketing consent is never inferred from privacy consent.

`status` never creates a lead. Same-operation retries return the durable accepted
receipt after a successful commit. A failed/uncertain commit is reconciled before
success is returned. Reserved objects remain available for same-key recovery;
automatic deletion during an uncertain finalization is prohibited. A receipt
reports durable acceptance, not current file availability or delivery of an email.

## Access, retention and removal

Migration 098 forces RLS on both new tables. Only the existing active Studio
operator in the fixed Studio workspace may operate the handoff tables. CRM
assets use the existing workspace RLS and authenticated
`/api/media/files/<assetId>` reader, with private/no-store, sandbox and nosniff
headers. No public media share is created.

Accepted files follow the existing CRM workspace retention policy: they remain
with the active workspace until authorized deletion/export. The Studio session
expiry and opportunistic 24-hour cleanup do not delete the CRM-owned copy.
Both original and analysis references remain bound to the confirmed record.
The source-role foreign keys and reference counter prevent the ordinary media
delete path from removing files in use. Unknown incoming asset foreign keys
still fail closed. Removing a handoff-owned file requires an explicitly authorized
detach/deletion procedure; this change grants no public or generic detach action.

No retention cron or orphan-object deletion guarantee is introduced. Isolated QA
cleanup must identify the exact test operations, reconcile their status, wait for
all issued PUT capabilities and in-flight writes to expire, then remove only
those test objects/records through the approved administrative cleanup path.
Uncertain operations must be retained for reconciliation. Production retention
automation and a user-facing deletion workflow remain separate activation gates.

## Verification and open gates

Run the new offline suite with
`node --conditions=react-server --import tsx --test scripts/studio-enquiry-tests.ts`.
It uses disposable local PostgreSQL, synthetic contacts, real PDF/PNG/WebP bytes,
and an in-memory Blob adapter. It covers no-lead reservation, missing/corrupt copy,
concurrent replay, rollback after writes, optional name/phone-only identity,
immutable confirmation, original/analysis hashes, foreign-tenant denial,
in-use/unknown-reference deletion guards and narrow SDK grants. It makes no model
or live provider requests. Existing Website Sales transaction tests must also pass
to preserve the old v1 behavior.

The root task subsequently ran all 12 cases successfully with pinned Node
24.14.0/npm 11.9.0, using real disposable PostgreSQL and mocked Blob. The first
local attempt was blocked before assertions by filesystem permissions; that
attempt is not counted as passing evidence. TypeScript separately passed on
installed Node 24.18.0. The later store-ID binding and live-harness additions
require fresh targeted tests. Full gates, exact-revision independent review,
remote migration/bindings, protected
Preview and real correct-tenant handoff remain to be evidenced by the root task.
No remote migration, environment binding, deployment, commit or push was performed
as part of this implementation.

## Read-only CRM lead details

The existing lead list retains its workspace filter and adds only a
`hasStudioEnquiry` boolean. Selecting an enquiry lead loads a bounded view
through `GET /api/crm/leads?id=<leadId>`, requiring normal `crm:read`, current
membership, the existing tenant transaction and lead RLS. The route reads only
that lead in the authenticated workspace and returns no storage paths or Blob
URLs. Hundreds of complete snapshots are not added to the list response.

The panel shows the complete confirmed summary, open questions, actual website
source URLs, analyses, limitations and optional exact extracted text. File links
use the authenticated private-media route. Identical PDF original/analysis roles
share one clearly labelled link; normalized images can have a separate analysis
copy. React escapes all customer text. Unsafe URLs, oversize text and invalid
asset-role bindings fail the read projection. A missing name uses the existing
unknown-contact label instead of inventing one from email or phone.

The form repository trims surrounding whitespace but does not impose a
3,000-character summary limit. The enquiry's up-to-10,000-character summary
remains in lead intent and in the immutable snapshot; a targeted regression
checks both. Legacy behavior is unchanged without `preserveProvidedIdentity`.
An enquiry-linked media asset also has a database guard against publication and
changes to its storage path, MIME, byte count or original name; other media are
unchanged. In-use deletion remains fail closed.

Additional offline checks:

```text
node --import tsx --test scripts/studio-enquiry-view-tests.ts
node --conditions=react-server --import tsx --test scripts/studio-enquiry-live-qa-tests.mjs
```

The three view cases and three harness-guard cases passed on local Node 24.18.0;
TypeScript and targeted lint passed. The expanded 14-case database suite and
final pinned build/review/live acceptance remain with the root task. The offline
React rendering test is not browser acceptance.

## Prepared live QA harness (not executed here)

Copy `config/studio-enquiry-live-qa.example.json` into the ignored
`.npm-cache/qa/` directory and populate it through the approved host-side secret
mechanism. It contains the dedicated signing credential, existing QA application
connection, exact Neon fingerprint, immutable Preview deployment/full revision,
approval record and allowlisted test contact. Never paste that private file or its
values into chat or logs. The committed example contains no usable credentials.

After the migration, environment bindings, protected deployment and independent
review gates pass, the root task can execute:

```text
node --conditions=react-server --import tsx scripts/studio-enquiry-live-qa.mjs .npm-cache/qa/<private-config>.json
```

The script uses existing Vercel CLI authentication only for read-only deployment
metadata. Actual HTTP uses native `C:\Windows\System32\curl.exe --disable --config -`
with an existing authorized protection token from the mandatory ACL-private
`protectionTokenFile`. All headers, cookies and signatures enter its configuration
on stdin; request bodies and raw responses remain ACL-private. It uses normal TLS,
the exact immutable origin, allowed paths, no redirects and bounded timeouts.
It never uses `vercel curl`, provisions a token, disables protection or changes
access rules. Read-only deployment metadata and `/api/version` must match the
exact Preview before any handoff. It then confirms actual Neon project/branch/database/non-owner runtime
role and FORCE RLS, with a distinct Production host. Database evidence queries
run read-only in the fixed Studio tenant. Only the new signed enquiry route and
its exact private PUT capabilities perform the authorized QA writes.

The harness saves its immutable synthetic PDF/PNG/WebP fixtures and operation ID
in an ignored private state file before sending. A retry with the same run ID
preserves the same operation/content and cannot silently create a new lead.
The generated analysis is explicitly synthetic transport-fixture data; the
harness never calls a model or claims new model-analysis proof.

It verifies reservation without a lead, original/analysis byte copies, repeated
reserve recognizing correct objects, finalize, status reconciliation and two
parallel finalize replays. The response-loss case deliberately discards an
already received HTTP 202 result; it is a simulated client-loss test, not an
actual network-timeout claim. Scoped DB counts must show one lead, one submission,
the correct source-role links/distinct assets and no tasks/bookings. It emits
only sanitized receipts/counts; no cookies, passwords, database URL, signing key,
PUT URL or private file text is printed.

Optional existing normal-login fixtures verify same-workspace private-media
bytes and authenticated foreign-workspace denial. They use the normal login
route and cookie sessions, never trusted-auth or demo headers. Missing fixtures
or a login/MFA challenge leave these checks explicitly open. The harness does
not create users, reset passwords, disable MFA or grant permissions. Anonymous
media denial is checked separately. No email, calendar, marketing, Production
endpoint, remote cleanup or paid model call is made. The receipt file stays in
the ignored QA directory; the script was prepared, not run by its author.
