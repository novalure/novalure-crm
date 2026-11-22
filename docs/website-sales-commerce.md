# Website Sales closing chain

Migration 209 adds append-only scoped closing records, exact owner approvals,
immutable provider jobs and actual source projections. It follows unchanged
migration 208 and reuses canonical CRM offers, deals, contacts and PM tasks.
The human workbench adds “Abschluss und Betreuung”; the existing Sales areas
remain available.

The supported chain is approved offer → immutable reviewed contract → exact
fresh owner approval → guarded delivery/signature job → actual signature proof
→ canonical delivery/customer acceptance → staged invoice request → actual
accounting invoice and payment allocation → service/renewal source history.
Preparing a request never issues an invoice or declares a payment settled.

Owner legal and issuer/tax sources must be supplied and remain current. At
EUR 5,000 net, contract approval requires a second, actually later MFA
reauthentication. Read-only and fact-recording rights cannot substitute for the
configured contract approver. Final customer signature is never performed by
the system.

The actual Resend and DocuSeal adapters, the bounded dedicated worker and signed
source ingress are implemented separately from activation. They are disabled
without exact-target host configuration and least-privilege credentials. This
change creates no real provider account, paid plan, customer message, signature,
invoice, refund or recurring schedule. BrightBooks has no invented API adapter.
Its actual authorized API contract remains an external activation dependency.

Payment schedules use either percentages throughout or exact fixed NET amounts
throughout. Fixed installments sum to the approved full NET commitment, retain
each cent and conserve the sourced HALF_UP tax total. New invoice requests are
held for billing review after an actual pause/cancellation/expiry or invalidated
service source; existing issued invoices, payment facts and debts remain intact.

Installation is atomic, including role/ACL/classification changes. The intended
non-superuser installer temporarily receives the narrow membership needed
for function ownership and ACL transfer and restores it before commit. PostgreSQL's
native creator ADMIN-only records are checked with SET/INHERIT false, not
misreported as runtime membership. A failed install restores the previous state.
Actual source-observer and execution authority are recorded independently of
the original command author; raw keys, tokens and credentials are not audit data.

`/api/integrations/website-sales/commerce/requests?jobId=<uuid>` is a signed
read-only pull of the exact frozen accounting/service request. HMAC domain:
`website-sales-commerce-pull-v1.<connectionId>.<timestamp>.GET.<pathAndQuery>`.
It returns no authority to execute a financial action. The provider connector
must obey its separate accounting and business authorization.

`POST /api/integrations/website-sales/commerce/source-events` accepts exact raw
JSON bytes with headers `x-sales-source-id`, `x-sales-event-id`,
`x-sales-timestamp`, `x-sales-signature: v1.<base64urlHmac>`.
HMAC input:
`website-sales-commerce-source-v1.<connectionId>.<eventId>.<timestamp>.<rawBody>`.
The registered account, full tenant/resource/workflow, source system, event
kind, actual request references and freshness are checked again. The host sets
the observation time and receipt. Connector authentication does not turn a
manual record into an independently verified bank fact.

Delivery, signed-document/audit hashes, issued invoices, payment allocations,
refunds, credits, reversals and subscriptions keep distinct provenance. Current
source resolution considers corrections and complete bounded history, rather
than falling back to an old positive record. The UI uses the server assessment;
unknown and unallocated amounts are not displayed as paid or zero.

Operational configuration, machine capabilities, source boundaries and release
gates are specified in the companion Evelyn runbook
`docs/runbooks/website-sales-commerce.md`. Local provider fixtures, disposable
PostgreSQL and browser acceptance are evidence of implementation only. No live
activation follows from a fixture passing. Teams and A1 remain outside scope.
