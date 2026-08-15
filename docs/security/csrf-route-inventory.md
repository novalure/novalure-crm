# CSRF route inventory

Inventory date: 2026-08-11. Scope: state-changing Next.js route handlers and browser API callers.

## Central cookie-session protection

`requirePermission`, `requireProductCapability`, and `resolveWorkspaceScopedSession` invoke the central guard for `POST`, `PATCH`, `PUT`, and `DELETE` whenever the authenticated session source is the signed `novalure_session` cookie. Header/demo/database-only sessions are not browser-cookie sessions and are outside this CSRF boundary.

| Route | Unsafe methods |
| --- | --- |
| `/api/approvals` | `POST` |
| `/api/bots/actions`, `/api/bots/agent`, `/api/bots/calls`, `/api/bots/channels`, `/api/bots/chat`, `/api/bots/documents`, `/api/bots/evaluations`, `/api/bots/knowledge`, `/api/bots/leads`, `/api/bots/meetings` | `POST` |
| `/api/calendar/google`, `/api/calendar/microsoft` | `POST` |
| `/api/crm/bots`, `/api/crm/dashboard-views`, `/api/crm/data-quality`, `/api/crm/editor-preflight`, `/api/crm/funnels`, `/api/crm/properties`, `/api/crm/recommendation-runtime`, `/api/crm/units` | `POST` |
| `/api/crm/broker/mandates`, `/api/crm/broker/search-profiles`, `/api/crm/calendar-events`, `/api/crm/customer-access`, `/api/crm/deals`, `/api/crm/google-notifications`, `/api/crm/leads`, `/api/crm/notes`, `/api/crm/projects`, `/api/crm/reservations`, `/api/crm/tasks`, `/api/crm/teams-notifications` | `POST`, `PATCH` |
| `/api/crm/contacts` | `POST`, `PATCH`, `DELETE` |
| `/api/crm/deals/[dealId]/stage`, `/api/crm/google-notifications/[notificationId]/retry`, `/api/crm/teams-notifications/[notificationId]/retry` | `POST`, `PATCH` |
| `/api/forms` | `POST` |
| `/api/funnels/[funnelId]/blueprint` | `PUT` |
| `/api/funnels/[funnelId]/submissions` | authenticated test-mode `POST` only |
| `/api/media`, `/api/media/[assetId]` | `POST`, `DELETE` |
| `/api/meetings/bookings/[bookingId]/confirm`, `/api/meetings/notifications`, `/api/meetings/notifications/[notificationId]/retry`, `/api/meetings/oauth/[provider]/disconnect`, `/api/meetings/settings` | `POST` |
| `/api/newsletter/send` | `POST` |
| `/api/settings/access/users`, `/api/settings/company-profile`, `/api/workspaces` | `POST`/`PATCH` as exported by each route |

Direct cookie-session routes migrated without changing their authorization model:

- `POST /api/auth/logout`
- `POST /api/auth/onboarding`
- `PATCH /api/settings/access/password`
- `POST /api/crm/properties`

## Explicit non-CSRF boundaries

These are not allowed to bypass authentication merely by claiming an exception. Each route has, or must retain, its own independent protection:

| Boundary | Routes | Independent protection |
| --- | --- | --- |
| Signed provider webhook | `POST /api/bots/channels/webhook` | Raw-body Meta HMAC, exact channel-account mapping, atomic replay uniqueness |
| Signed cron worker | `GET /api/cron/google-alerts`, `GET /api/cron/meeting-reminders`, `GET /api/cron/property-reservations`, `GET /api/cron/teams-alerts` | Constant-time `Authorization: Bearer $CRON_SECRET`; local bypass is non-production and opt-in only |
| OAuth browser callback | `GET /api/meetings/oauth/[provider]/start`, `GET /api/meetings/oauth/[provider]/callback` | Dedicated signed, expiring, one-time state and PKCE (P2-06 implementation) |
| Public form/funnel | `POST /api/forms/submissions`, live-mode `POST /api/funnels/[funnelId]/submissions` | Public-form abuse, publication-token, consent, and idempotency controls; no cookie authority |
| Public booking | `POST /api/meetings/bookings`, `POST /api/meetings/bookings/[bookingId]/cancel`, `POST /api/meetings/bookings/[bookingId]/reschedule` | Public booking token/abuse/idempotency controls; no cookie authority |
| Pre-authentication | `POST /api/auth/login`, password-reset request and confirmation | Pre-auth abuse/reset-token controls; no authenticated session exists yet |

The four cron handlers still mutate on `GET` because the current Vercel Cron transport invokes them that way. This is a separately tracked HTTP-semantics exception, not a cookie-CSRF exception.

## App migration status

All browser-side authenticated unsafe API calls use `csrfFetch`, including logout, CRM workspace, calendar, contacts, leads, properties, tasks, units, media, and bot actions. A source inventory leaves native `fetch` only for safe `GET` requests. The remaining HTML `POST` forms are the public booking flow and pre-authentication login/password-reset flows; none exercises cookie-session authority.

Authenticated funnel test submissions use `csrfFetch`. Anonymous live funnel submissions intentionally continue with native `fetch` because they have no cookie-session authority.

There are no remaining application route-handler or browser call-site migrations in this CSRF scope. The OAuth start/callback routes remain separately protected by signed, expiring, one-time state plus PKCE and were not reworked by this block.

## Non-browser QA clients still requiring migration

The required `qa-livegang-api.mjs` client is migrated and issues a unique token per unsafe request. The following standalone/manual clients still need the same request helper treatment before they can exercise protected cookie mutations:

- `scripts/qa-livegang-runtime.mjs`
- `scripts/qa-productrole-invite-hardening.mjs`
- `scripts/qa-contact-crud.mjs`
- mutation paths inside `scripts/qa-contact-ui.mjs`
- `scripts/qa-live-onboarding-local-verify.mjs`
