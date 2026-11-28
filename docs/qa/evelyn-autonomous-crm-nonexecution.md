# Exact technical closure of an unknown CRM command

This successor is separate from the frozen PR143 revision `6c5e4ae6`. It adds
no deployment, credential, grant, human business approval or runtime activation.

An unknown delivery, timeout, current denial or missing receipt remains UNKNOWN.
The separate recovery host may submit only its actual committed A1 intent. A
current production workload and an independently registered recovery authority
are mandatory. The authority fixes the control project and permitted historical
grant IDs. Its canonical Ed25519 SPKI key cannot equal a department key, including
alternative base64 representations; registration uses a shared key digest lock.

The existing endpoint accepts `x-evelyn-close-without-effect: 1` and
`x-evelyn-recovery: v1.<authority>.<payload>.<signature>`. The signed domain is
`crm-autonomous-access-v2-close.POST./api/integrations/evelyn/access`. Normal
delegation, reconciliation and browser credentials cannot be combined with it.
The original six-field command remains unchanged. The signed payload additionally
binds the original grant, task, department, agent, entity, workspace, CRM/control
projects, mission, attempt, effect, registry version and artifact/target/request
digests, with a fresh nonce and short expiry.

Under the original workspace/idempotency command lock, an exact original receipt
returns only APPLIED metadata. Its complete original attribution and body hash
must be witnessed by the autonomous events; repeated identical Execute/Reconcile
events are valid, contradictory attribution is denied. No response/business
projection is selected. Current business grant expiry, object existence, CAS,
QC and business approvals are deliberately irrelevant to historical observation
or fencing. The workload source actor and recovery authority remain current.

Otherwise an append-only NO_EFFECT closure permanently fences that key. A
BEFORE-INSERT guard on `crm_command_receipts` also fences old queued handlers:
their entire existing CRM transaction, nested receipts, approval consumption and
outbox roll back. All seven mutators perform only SQL/transactional outbox work
before the outer receipt; `SendOffer` queues `crm_offer_deliveries`, never SMTP.
Consent decision logging shares the same AsyncLocal transaction. No effectful
callback exists in the closure path. Uncertain DB/commit errors return503/UNKNOWN.

The staged SQL runs after the existing four stages under their bounded NOLOGIN,
non-superuser, non-BYPASS installer. Its existing eleven-table ownership needs
only the additional technical `crm_command_receipts` table. Runtime roles gain
no table access to authorities/closures/events and no owner-role membership.
New owner policies read only in-workspace receipt/event metadata. The stage
creates no registrations or keys. `CRM_AUTONOMOUS_NONEXECUTION_ENABLED` defaults
off; an absent stage cannot silently disable existing v1 or ordinary CRM paths.

Local acceptance must cover all seven actual mutations reaching successful SQL
and then fully rolling back at a fenced outer receipt, both lock order races,
historical inactive actors, exact repeated/mismatched events, purpose/key/nonce
separation and the actual immutable Evelyn client. These are local synthetic
tests; a production installation, trusted App check and target activation remain
separate required evidence. This source document does not mark them passed.
