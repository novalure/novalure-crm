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

Local verification: `scripts/booking-production-guard-tests.ts` exercises runtime
and registry boundaries against disposable PostgreSQL; provider transport is not
used. `scripts/booking-channel-authorization-tests.ts` exercises public withdrawal
during route probes and persistence after a late withdrawal with simulated
provider ports and real local locks. These tests are not production OAuth,
calendar, Maps, mail-delivery or scheduler evidence.
