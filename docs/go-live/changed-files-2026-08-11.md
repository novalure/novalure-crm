# Geänderte Dateien – Go-live-Remediation 2026-08-11

Vollständiger Worktree-Snapshot zum Abschluss der lokalen Umsetzung. Die Liste enthält bewusst auch gelöschte, zuvor getrackte Log-Artefakte und noch nicht zum Commit hinzugefügte neue Dateien.

**Gesamt:** 239 Einträge

| Kürzel | Bedeutung |
|---|---|
| `M` | getrackte Datei geändert |
| `A` | neue, aktuell ungetrackte Datei |
| `D` | getrackte Datei gelöscht |

## Release, CI, Toolchain und Repository-Hygiene

_16 Dateien_

| Status | Datei |
|---:|---|
| `A` | `.github/dependabot.yml` |
| `M` | `.github/workflows/livegang-e2e.yml` |
| `A` | `.github/workflows/secret-scan.yml` |
| `A` | `.node-version` |
| `D` | `dev-server.err.log` |
| `D` | `dev-server.out.log` |
| `M` | `next.config.ts` |
| `M` | `package-lock.json` |
| `M` | `package.json` |
| `D` | `preview-server-3004.err.log` |
| `D` | `preview-server-3004.out.log` |
| `D` | `preview-server.err.log` |
| `D` | `preview-server.out.log` |
| `D` | `server-3007.err.log` |
| `D` | `server-3007.out.log` |
| `M` | `vercel.json` |

## Datenbankmigrationen

_12 Dateien_

| Status | Datei |
|---:|---|
| `A` | `migrations/048_bot_webhook_integrity.sql` |
| `A` | `migrations/049_property_inventory_tenant_guards.sql` |
| `A` | `migrations/050_durable_job_leasing.sql` |
| `A` | `migrations/051_private_media_access.sql` |
| `A` | `migrations/052_validate_property_inventory_tenant_guards.sql` |
| `A` | `migrations/053_oauth_state_integrity.sql` |
| `A` | `migrations/054_csrf_token_integrity.sql` |
| `A` | `migrations/055_public_submission_abuse_guards.sql` |
| `A` | `migrations/056_auth_identity_sessions_mfa.sql` |
| `A` | `migrations/060_tenant_rls_pilot_prepare.sql` |
| `A` | `migrations/061_validate_and_activate_tenant_rls_pilot.sql` |
| `A` | `migrations/064_notification_provider_and_lead_assignee_integrity.sql` |

## Berichte und Security-Dokumentation

_5 Dateien_

| Status | Datei |
|---:|---|
| `A` | `docs/go-live/changed-files-2026-08-11.md` |
| `A` | `docs/go-live/go-live-remediation-report-2026-08-11.md` |
| `A` | `docs/security/auth-identity-session-mfa.md` |
| `A` | `docs/security/csrf-route-inventory.md` |
| `A` | `docs/security/p2-11-operational-reconciliation.md` |

## QA-, Test-, Migrations- und Betriebsskripte

_62 Dateien_

| Status | Datei |
|---:|---|
| `A` | `scripts/admin-navigation-smoke-tests.mjs` |
| `M` | `scripts/apply-company-profiles-migration.mjs` |
| `M` | `scripts/apply-novalure-growth-migration.mjs` |
| `M` | `scripts/apply-property-content-guards-migration.mjs` |
| `M` | `scripts/apply-property-default-units-migration.mjs` |
| `M` | `scripts/apply-property-department-migration.mjs` |
| `M` | `scripts/apply-public-slug-routing-migration.mjs` |
| `A` | `scripts/auth-security-tests.mjs` |
| `A` | `scripts/bot-document-share-lifecycle-tests.mjs` |
| `A` | `scripts/calendar-accessibility-smoke-tests.mjs` |
| `A` | `scripts/check-toolchain.mjs` |
| `M` | `scripts/company-profile-settings-smoke-tests.mjs` |
| `M` | `scripts/contact-access-rbac-smoke-tests.mjs` |
| `A` | `scripts/contact-empty-state-regression-tests.mjs` |
| `A` | `scripts/crm-scope-persistence-smoke-tests.mjs` |
| `A` | `scripts/cron-runtime-smoke-tests.mjs` |
| `A` | `scripts/csrf-security-tests.mjs` |
| `A` | `scripts/database-diagnostics-smoke-tests.mjs` |
| `M` | `scripts/db-migrate.mjs` |
| `A` | `scripts/deal-input-validation-tests.mjs` |
| `A` | `scripts/design-foundations-smoke-tests.mjs` |
| `A` | `scripts/durable-queue-smoke-tests.mjs` |
| `M` | `scripts/e2e-object-creation-tests.mjs` |
| `M` | `scripts/i18n-localization-smoke-tests.mjs` |
| `A` | `scripts/lib/infra-targets.mjs` |
| `A` | `scripts/migration-cutover-guard-tests.mjs` |
| `A` | `scripts/oauth-state-security-tests.mjs` |
| `A` | `scripts/open-redirect-security-tests.mjs` |
| `A` | `scripts/p2-11-provider-and-assignee-tests.mjs` |
| `A` | `scripts/page-metadata-localization-tests.mjs` |
| `A` | `scripts/password-input-accessibility-tests.mjs` |
| `M` | `scripts/phase0-smoke-tests.mjs` |
| `M` | `scripts/phase1-persistence-smoke-tests.mjs` |
| `M` | `scripts/phase3-rbac-smoke-tests.mjs` |
| `M` | `scripts/phase5-copy-smoke-tests.mjs` |
| `M` | `scripts/phase6-bot-grounding-smoke-tests.mjs` |
| `M` | `scripts/phase8-acceptance-smoke-tests.mjs` |
| `M` | `scripts/property-department-smoke-tests.mjs` |
| `A` | `scripts/public-submission-abuse-tests.mjs` |
| `M` | `scripts/qa-contact-access.mjs` |
| `M` | `scripts/qa-deal-idempotency.mjs` |
| `M` | `scripts/qa-lead-idempotency.mjs` |
| `M` | `scripts/qa-livegang-api.mjs` |
| `M` | `scripts/qa-livegang-reset.mjs` |
| `M` | `scripts/qa-livegang-runtime.mjs` |
| `M` | `scripts/qa-livegang-seed.mjs` |
| `M` | `scripts/qa-persistence-diagnostics.mjs` |
| `M` | `scripts/qa-phase2-property-kpis.mjs` |
| `M` | `scripts/qa-phase3-duplicate-guards.mjs` |
| `M` | `scripts/qa-productrole-invite-hardening.mjs` |
| `M` | `scripts/qa-property-pagination.mjs` |
| `M` | `scripts/qa-property-unit-pagination.mjs` |
| `M` | `scripts/qa-public-slug-routing.mjs` |
| `M` | `scripts/qa-reservation-stage-resolver.mjs` |
| `A` | `scripts/qa-security-and-scope-smoke-tests.mjs` |
| `A` | `scripts/qa-target-guard.mjs` |
| `M` | `scripts/qa-tenant-isolation.mjs` |
| `A` | `scripts/security-headers-smoke-tests.mjs` |
| `A` | `scripts/tenant-hardening-inventory.mjs` |
| `A` | `scripts/tenant-hardening-smoke-tests.mjs` |
| `A` | `scripts/touch-target-smoke-tests.mjs` |
| `A` | `scripts/unit-board-state-accessibility-tests.mjs` |

## App-Routen, Seiten und Runtime-Einstieg

_57 Dateien_

| Status | Datei |
|---:|---|
| `A` | `src/app/api/admin/audit-logs/route.ts` |
| `A` | `src/app/api/auth/csrf/route.ts` |
| `M` | `src/app/api/auth/login/route.ts` |
| `M` | `src/app/api/auth/logout/route.ts` |
| `M` | `src/app/api/auth/onboarding/route.ts` |
| `M` | `src/app/api/auth/password-reset/confirm/route.ts` |
| `A` | `src/app/api/auth/password-reset/exchange/route.ts` |
| `M` | `src/app/api/auth/password-reset/request/route.ts` |
| `M` | `src/app/api/auth/session/route.ts` |
| `M` | `src/app/api/bots/actions/route.ts` |
| `M` | `src/app/api/bots/channels/webhook/route.ts` |
| `M` | `src/app/api/bots/documents/route.ts` |
| `M` | `src/app/api/crm/customer-access/route.ts` |
| `M` | `src/app/api/crm/deals/route.ts` |
| `M` | `src/app/api/crm/google-notifications/[notificationId]/retry/route.ts` |
| `M` | `src/app/api/crm/google-notifications/route.ts` |
| `M` | `src/app/api/crm/properties/route.ts` |
| `M` | `src/app/api/crm/reservations/route.ts` |
| `M` | `src/app/api/crm/teams-notifications/[notificationId]/retry/route.ts` |
| `M` | `src/app/api/crm/teams-notifications/route.ts` |
| `M` | `src/app/api/crm/units/route.ts` |
| `M` | `src/app/api/cron/google-alerts/route.ts` |
| `M` | `src/app/api/cron/meeting-reminders/route.ts` |
| `M` | `src/app/api/cron/property-reservations/route.ts` |
| `M` | `src/app/api/cron/teams-alerts/route.ts` |
| `M` | `src/app/api/forms/submissions/route.ts` |
| `A` | `src/app/api/health/route.ts` |
| `M` | `src/app/api/media/[assetId]/route.ts` |
| `M` | `src/app/api/media/files/[assetId]/route.ts` |
| `M` | `src/app/api/media/public/[token]/route.ts` |
| `M` | `src/app/api/media/route.ts` |
| `M` | `src/app/api/meetings/bookings/route.ts` |
| `M` | `src/app/api/meetings/oauth/[provider]/callback/route.ts` |
| `M` | `src/app/api/meetings/oauth/[provider]/start/route.ts` |
| `M` | `src/app/api/settings/access/password/route.ts` |
| `M` | `src/app/api/settings/access/users/route.ts` |
| `M` | `src/app/api/system/database/route.ts` |
| `M` | `src/app/api/workspaces/route.ts` |
| `M` | `src/app/book/public-booking-page.tsx` |
| `M` | `src/app/cookies/page.tsx` |
| `M` | `src/app/data-deletion/page.tsx` |
| `M` | `src/app/datadeletion/page.tsx` |
| `A` | `src/app/fonts.ts` |
| `M` | `src/app/forms/embed/route.ts` |
| `M` | `src/app/forms/public-form-page.tsx` |
| `M` | `src/app/globals.css` |
| `M` | `src/app/imprint/page.tsx` |
| `M` | `src/app/layout.tsx` |
| `M` | `src/app/login/forgot-password/page.tsx` |
| `M` | `src/app/login/page.tsx` |
| `M` | `src/app/login/reset-password/page.tsx` |
| `M` | `src/app/meta/page.tsx` |
| `M` | `src/app/not-found.tsx` |
| `M` | `src/app/privacy/page.tsx` |
| `M` | `src/app/terms/page.tsx` |
| `M` | `src/app/unsubscribe/page.tsx` |
| `A` | `src/instrumentation.ts` |

## UI-, Design- und Komponentenebene

_40 Dateien_

| Status | Datei |
|---:|---|
| `A` | `src/components/admin/audit-log-panel.tsx` |
| `A` | `src/components/admin/governance-compliance-panel.tsx` |
| `A` | `src/components/admin/system-releases-panel.tsx` |
| `M` | `src/components/bot-command-center.tsx` |
| `M` | `src/components/calendar-command-center.tsx` |
| `M` | `src/components/company-profile-settings.tsx` |
| `M` | `src/components/contact-command-center.tsx` |
| `M` | `src/components/crm-analysis-bot.tsx` |
| `M` | `src/components/crm-workspace.tsx` |
| `M` | `src/components/customer-access-cockpit.tsx` |
| `M` | `src/components/dashboard-overview.tsx` |
| `M` | `src/components/data-hygiene-board.tsx` |
| `M` | `src/components/deal-pipeline-workspace.tsx` |
| `M` | `src/components/form-command-center.tsx` |
| `M` | `src/components/form-renderer-static.ts` |
| `M` | `src/components/form-renderer.tsx` |
| `M` | `src/components/form-runtime-client.tsx` |
| `M` | `src/components/funnel-blueprint-designer.tsx` |
| `M` | `src/components/funnel-command-center.tsx` |
| `M` | `src/components/funnel-renderer.tsx` |
| `M` | `src/components/knowledge-command-center.tsx` |
| `M` | `src/components/lead-inbox.tsx` |
| `M` | `src/components/lead-sequence-command-center.tsx` |
| `M` | `src/components/media-library-picker.tsx` |
| `M` | `src/components/mobile-daily-work.tsx` |
| `M` | `src/components/newsletter-command-center.tsx` |
| `M` | `src/components/password-visibility-input.tsx` |
| `M` | `src/components/property-command-center.tsx` |
| `A` | `src/components/submit-once-form.tsx` |
| `M` | `src/components/task-command-center.tsx` |
| `A` | `src/components/ui/button.tsx` |
| `A` | `src/components/ui/class-names.ts` |
| `A` | `src/components/ui/field.tsx` |
| `A` | `src/components/ui/foundations.module.css` |
| `A` | `src/components/ui/states.tsx` |
| `A` | `src/components/ui/status.tsx` |
| `A` | `src/components/ui/surface.tsx` |
| `M` | `src/components/unit-board.tsx` |
| `M` | `src/components/workspace-onboarding-tour.tsx` |
| `A` | `src/styles/novalure-tokens.css` |

## Domain-, Auth-, Security-, Datenbank- und Integrationsbibliotheken

_47 Dateien_

| Status | Datei |
|---:|---|
| `A` | `src/lib/auth/auth-audit.ts` |
| `A` | `src/lib/auth/auth-flow.ts` |
| `A` | `src/lib/auth/auth-security.ts` |
| `A` | `src/lib/auth/mfa-core.ts` |
| `A` | `src/lib/auth/mfa.ts` |
| `M` | `src/lib/auth/password-reset.ts` |
| `A` | `src/lib/auth/rate-limit-core.ts` |
| `A` | `src/lib/auth/rate-limit.ts` |
| `A` | `src/lib/auth/response-security.ts` |
| `A` | `src/lib/auth/session-store.ts` |
| `M` | `src/lib/auth/session.ts` |
| `M` | `src/lib/bots/chat-runtime.ts` |
| `M` | `src/lib/bots/omnichannel.ts` |
| `A` | `src/lib/bots/webhook-security.ts` |
| `A` | `src/lib/crm-scope.ts` |
| `A` | `src/lib/cron/runtime.ts` |
| `A` | `src/lib/db/admin-repositories.ts` |
| `M` | `src/lib/db/crm-loaders.ts` |
| `M` | `src/lib/db/crm-write-repositories.ts` |
| `M` | `src/lib/db/customer-access-repositories.ts` |
| `M` | `src/lib/db/google-notification-repositories.ts` |
| `M` | `src/lib/db/meeting-repositories.ts` |
| `M` | `src/lib/db/property-department-repositories.ts` |
| `M` | `src/lib/db/property-inventory-repositories.ts` |
| `A` | `src/lib/db/public-submission-abuse-repository.ts` |
| `M` | `src/lib/db/runtime-repositories.ts` |
| `M` | `src/lib/db/schema.ts` |
| `M` | `src/lib/db/settings-access-repositories.ts` |
| `M` | `src/lib/db/teams-notification-repositories.ts` |
| `A` | `src/lib/db/tenant-client.ts` |
| `A` | `src/lib/deal-validation.ts` |
| `M` | `src/lib/i18n.ts` |
| `M` | `src/lib/integrations/calendar-connections.ts` |
| `A` | `src/lib/integrations/calendar-oauth-state.ts` |
| `A` | `src/lib/jobs/durable-queue.ts` |
| `A` | `src/lib/media-security.ts` |
| `M` | `src/lib/media-store.ts` |
| `M` | `src/lib/meetings/notification-runner.ts` |
| `A` | `src/lib/notifications/provider-target-readiness.ts` |
| `A` | `src/lib/page-metadata.ts` |
| `M` | `src/lib/product-model.ts` |
| `A` | `src/lib/public-submission-contract.ts` |
| `A` | `src/lib/security/csrf-client.ts` |
| `A` | `src/lib/security/csrf-core.ts` |
| `A` | `src/lib/security/csrf.ts` |
| `A` | `src/lib/security/public-submission-abuse.ts` |
| `A` | `src/lib/security/redirects.ts` |

## Hinweis

Die Liste ist ein lokaler Arbeitsstand, kein Commit-, Deployment- oder Produktionsnachweis. Maßgeblich für die Releaseentscheidung bleibt der zugehörige Abschlussbericht.

