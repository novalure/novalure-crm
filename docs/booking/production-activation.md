# Booking production activation

This is a release procedure, not evidence that a production account is already
approved. Migration `112_booking_production_activation.sql` creates an empty
registry and enables nothing. Preview still requires its exact approved QA
bindings before provider writes.

The production runtime requires all of:

- `VERCEL_ENV=production`, `BOOKING_ENGINE_ENABLED=1`, and
  `BOOKING_PRODUCTION_ENABLED=1`.
- A UUID `BOOKING_PRODUCTION_ACTIVATION_ID` identifying the release cohort,
  plus a past UTC ISO `BOOKING_PRODUCTION_ACTIVATED_AT` cutoff.
- An explicit HTTPS `NOVALURE_APP_ORIGIN`. No request Host, public URL fallback,
  or preview URL determines production authority. Each registry row must match
  this origin exactly.
- Neither `BOOKING_TEST_BINDINGS_JSON` nor
  `BOOKING_MAIL_TEST_BINDINGS_JSON` may exist in Production, even as an empty
  string or `[]`. Never copy QA users, workspaces, tokens or bindings there.
- Regular per-employee OAuth consent and an explicitly selected writable calendar.
  No application-wide Novalure account substitutes for an absent customer account.

`BOOKING_MICROSOFT_ACCOUNT_TYPE` declares independently checked app metadata:
`single_tenant` requires a tenant UUID authority, `organizations` requires
`organizations`, `organizations_and_personal` requires `common`, and `personal`
requires `consumers`. `BOOKING_GOOGLE_OAUTH_STATUS` must explicitly identify
`testing`, `internal`, or `production`. These declarations do not modify either
provider. Existing callback paths remain
`/api/meetings/oauth/microsoft/callback` and
`/api/meetings/oauth/google/callback` on the configured production origin.

Credentials being configured does not prove external customer eligibility.
`external_customers` activations additionally require the corresponding
`BOOKING_MICROSOFT_EXTERNAL_OAUTH_VERIFIED=1` or
`BOOKING_GOOGLE_EXTERNAL_OAUTH_VERIFIED=1` declaration after independent provider
administration review; Google must also have `production` status. A single-tenant
Microsoft app cannot receive this external readiness status. Internal activation
is a narrower scope and never proves that other customers may connect. Runtime
credential expiry remains `not_verified`; record actual expiry and renewal
responsibility in the protected operator inventory.

Only the protected schema administrator can call
`booking_admin_activate_production(activation_id, workspace_id, user_id, provider,
connection_id, account_id, calendar_id, production_origin, capabilities,
activated_at, audience, review_reference)`. Use parameterized arguments from the
reviewed live connection, never client parameters or a QA manifest. Capabilities
are `booking` and optionally `messages`; audience is `internal` or
`external_customers`. `review_reference` identifies the approval evidence without
including credentials. A cohort can approve many distinct customer/employee
resources. The runtime role cannot insert/update the registry or execute either
administrative function.

Activation checks reject QA workspaces and marked synthetic identities, inactive
members or central identities, disabled Calendar modules, disconnected or changed
account/calendar bindings, missing write scopes, protected calendars, and
unreadable conflict calendars. Every booking write checks the current binding.
Token refresh alone does not invalidate an activation. A resource/account change
requires an exact matching approved row; there is no fallback to another resource.

The first Production build must retain the existing hourly cron expression
`2 * * * *` for `/api/cron/meeting-reminders`. Keep the activation registry empty
and booking message dispatch disabled while staging this code. After the actual
Production aliases and version endpoint identify the new guarded worker, release
the minute cron expression as a separate, normally checked configuration change.
Only then approve exact message bindings and observe a real platform-triggered
reminder. Do not assume that a staged Production build leaves cron registration
unchanged merely because its custom domains have not been promoted. Other cron
definitions and the existing global worker pause stay unchanged throughout.

`booking_admin_revoke_production(registry_row_id, review_reference)` revokes an
exact row. Dispatch holds a shared activation-row lock within its transaction, so
revocation serializes with an admitted send. Known provider outcomes are still
recorded after a late public-channel withdrawal; withdrawal cannot erase a
calendar event that has already been created.

Message dispatch requires its separate switches and `messages` capability. Its
effective cutoff is the later of the release cutoff and the exact resource's
activation timestamp. Earlier QA/legacy bookings and jobs are not adopted.
Scheduler enumeration is bounded to 1,000 active resource rows per call and
returns only binding metadata, never OAuth credentials.

## Release record and order

The user-selected first production scope is **Novalure Growth**, workspace
`8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101`, organizer
`bf34e694-7aba-4359-b027-f43a68255523`. Selection is not an activation: freshly
verify this exact active member, central identity, Calendar module, real OAuth
connection, provider account and selected writable calendar. No other organizer
or workspace is implicitly approved. Record the checked connection/calendar IDs,
provider readiness, credential expiry and review reference in the protected
operator record; keep credentials out of this document.

Before migration or promotion, record the exact current deployment/SHA, both
production alias mappings, production project/branch/host, normal runtime role,
original migration ledger/checksums and a recoverable pre-change recovery point.
The last independently read pre-release aliases `www.novalure-crm.app` and
`novalure-crm.vercel.app` both identified deployment
`dpl_C8cYbF3CqzuXUTxgQHCW74g2VEa1`, source
`6b55f40ef361ffef0438b24f34bd49bc0ba2d997`; re-read them before acting. A recovery
point is an incident-recovery option, not permission to replace later customer
records with an older snapshot.

1. Finish the normal PR #97 review/merge gates on its final exact SHA. Read the
   currently enforced repository rules rather than inferring approval from a
   mergeable flag. Keep required quality, dependency-audit, secret-scan and
   applicable QA/review requirements. A skipped manual QA job is not an execution
   PASS, and an internal agent review is not a trusted-App attestation. Earlier
   Studio/ST1 package exceptions do not apply to this release. Do not use an
   administrator bypass or change protection to merge.
2. Use the reviewed production-version rehearsal and retention/normal-runtime
   evidence before applying SQL to the actual production branch. Leave
   migrations 108–110 immutable. Apply the explicit sequence 108, 109, 110, 111,
   112, 113, each from clean committed source with its own `dry-run`, private
   plan-token file and matching `up`, using `--only=<exact version>`,
   `--allow-manual-cutover` and `--booking-production-cutover`. The runner also requires
   `MIGRATION_TARGET=prod`, `BOOKING_PRODUCTION_ENABLED=1`, the valid release UUID,
   exact target guards and the declared normal runtime role. A clone/rehearsal
   plan token is never reusable against production; create a new plan after each
   ledger change. Keep the additional schema and ledger on binary rollback.
3. Build the first guarded production candidate with the existing hourly
   `2 * * * *` meeting-reminder schedule, the production activation registry
   empty, `BOOKING_MESSAGES_ENABLED=0`, `BOOKING_REMINDERS_ENABLED=0`, no enabled
   publication and no QA binding variables. Preserve all other schedules and the
   existing global worker pause. Verify the candidate's exact SHA and target.
   During staging, both production aliases must still resolve to the recorded
   predecessor; a deployment's `alias` array alone does not prove this.
4. Promote that candidate and read both aliases and the actual version endpoint
   again. Verify ordinary authentication, permissions and the upgraded normal
   runtime; retain this guarded **hourly** deployment as the fallback. No live
   calendar binding or publication is approved before this code is current.
5. Only after that readback, release the separate, normally checked minute-cron
   change. The code receiving a potentially early schedule registration is now
   already guarded. Approve only the exact reviewed live calendar resource for
   the selected pilot. Enable a publication only after its persisted readiness
   checks pass. Message dispatch needs its separate reviewed switches,
   `messages` capability and cutoff; complete actual scheduler, signed-webhook
   and provider/recipient acceptance before calling those paths live-proven.

The relevant code authorities are [runtime.ts](../../src/lib/booking/runtime.ts),
[activation.ts](../../src/lib/booking/activation.ts),
[message-runtime.ts](../../src/lib/booking/message-runtime.ts),
[publication.ts](../../src/lib/booking/publication.ts) and the
[migration runner](../../scripts/db-migrate.mjs). Domain staging is documented by
[Vercel](https://vercel.com/docs/deployments/promoting-a-deployment), but neither
that documentation nor the public CLI supplies an explicit guarantee that cron
registration waits for promotion. The two release stages above do not rely on
that assumption.

## Abort and rollback boundaries

**Before the first activation, publication or business effect:** an application
rollback to the exact verified predecessor can be compatible with the upgraded
schema, subject to the actual production-version compatibility evidence. First
prove there are no active resource approvals, published/sticky organizer
cutovers or mappings, new core/channel/outbox operations, or already-started
provider/mail requests and their effects. An empty activation registry alone is
not sufficient. Keep 108–113 and their ledger entries installed; do not perform a destructive SQL
down-migration merely to change application binaries.

**After any successful publication:** the exact workspace/organizer cutover is
durable, including after disabling the publication or removing assignments.
[Migration 111](../../migrations/111_booking_public_channels.sql) grants the
runtime no UPDATE/DELETE on `booking_publication_organizer_cutovers`; the lookup
also retains previously mapped legacy pages. A pre-Booking binary ignores this
registry and can reopen the old engine. Disabling the new UI therefore does not
make rollback to that binary safe. Use the recorded, verified guarded hourly
deployment ID with its actual built environment snapshot, or another separately
proven build that preserves these cutover checks. Other organizers must remain
unaffected.

**After any booking/provider/message effect, even without a publication:** keep
the authoritative booking, operation, CRM, outbox and provider identifiers and
their known or uncertain outcomes. Do not discard a known successful provider
result because authorization was withdrawn while its response was in flight.
Do not retry an uncertain create/send or reset its state to obtain a fresh
attempt. Inspect the same operation and approved provider identifiers instead.

For a scoped incident, withdraw the affected public publication/channels and
revoke only the exact activation rows through the protected admin function.
Stop new booking-message dispatch; environment changes require a new deployment
and do not retroactively change an immutable running deployment. Registry
revocation is checked in the database and serializes with an admitted send's
shared lock. Let already-started requests persist their known outcomes. Preserve
the global pause and all unrelated tenants, grants, tokens, schedules and jobs.
Restore the guarded hourly build if the minute rollout is the problem, verify
both aliases/version and inspect outstanding operations before resuming.

Never restore the whole production database over confirmed business records to
undo this release. If data repair is necessary, use an isolated recovery copy to
compare the exact affected records and prepare a separately scoped repair that
preserves subsequent bookings, audit history and provider outcomes. Do not erase
sticky cutovers or widen the old queue's permissions as a rollback shortcut.

Local verification: `scripts/booking-production-guard-tests.ts` exercises runtime
and registry boundaries against disposable PostgreSQL; provider transport is not
used. `scripts/booking-channel-authorization-tests.ts` exercises public withdrawal
during route probes and persistence after a late withdrawal with simulated
provider ports and real local locks. These tests are not production OAuth,
calendar, Maps, mail-delivery or scheduler evidence.
