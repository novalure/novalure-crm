// Existing CI entry point; the combined Auftrag-2 flow retains the original
// login/MFA, request idempotency, disconnected-provider and tenant/RBAC checks.
// It additionally checks persisted setup, inherited rules, templates and reminders.
import "./booking-setup-browser.mjs";
