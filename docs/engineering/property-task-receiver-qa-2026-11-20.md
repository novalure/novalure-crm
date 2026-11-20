# Property task transaction: local CRM experiment

This is **not a migration, integration, deployment, or production receiver**.
`scripts/fixtures/property-task-crm-qa.sql` can install only in the synthetic
loopback database named `property_task_synthetic_qa` under `qa_admin`. Nothing
loads it in the application. There is no route, pool, credential, dispatch,
A1 effect, or grant to an existing application role. The SQL contains a
purpose-built *test double* for the case, source, identity, and stop state.

Run `node --test scripts/crm-property-task-qa.test.mjs` with this repository's
dependencies installed. It creates and stops a disposable loopback PostgreSQL
cluster without reading an external connection URL. The normal local CRM
sales-schema bootstrap is partial: among other exclusions it omits pgvector,
some production cutovers and their prerequisites. The staged observation
candidate is installed in that temporary database to exercise its real unit
version trigger. No live schema or migration has been inspected or modified.

The experiment calls a security-definer function through a dedicated synthetic
login with no direct table rights. In one PostgreSQL transaction it locks the
actual CRM membership, project grant, project and unit rows, plus the synthetic
case/identity/source/stop row; it inserts an actual CRM `tasks` row, an actual
`audit_logs` row and a synthetic receipt. Tests cover scope/login denial,
rollback, duplicate and concurrent calls, changed case or source, and real
PostgreSQL lock races involving membership, project grant, unit, source, and
stop. A stop or revocation committed first prevents the task; a mutation
started while the task owns the relevant row lock waits for its transaction.
These are ordering tests for the local database only. They do not establish
the moment an external service acknowledges a revocation.

The function owner is the temporary cluster's synthetic superuser; therefore
the experiment **does not prove a production definer's privileges or forced
RLS behavior**. The test receipt and audit action are not the CRM command
receipt/domain event contract. The task contains a fixed synthetic title and
does not implement a complete task lifecycle, assignee policy, or recovery
API. Exact replay is permitted only while the checked authority and task
remain current; unknown outcomes after revocation still need a separately
authorized, bounded receipt lookup. The task version is not protected here
against every ordinary CRM task writer. No test assumes a local GUC proves an
identity; the synthetic login is bound by a database-owned test row.

## Missing authority boundary

The existing Evelyn clarification case and its source, commercial rights,
identity, and department stop are separate in-memory/service boundaries. No
existing authenticated mechanism was found that makes **all** their writes,
revocations and acknowledgements participate in the same CRM transaction or
in a proven close-before-ack protocol. A copied row or earlier source read
cannot establish that guarantee. In addition, the staged CRM observation
grant explicitly exposes no source approval and grants read only; it cannot be
repurposed to authorize tasks. Existing task writers include
`crm-write-repositories.ts`, `data-quality-repositories.ts`,
`form-repositories.ts`, `offer-repositories.ts` and onboarding/automation
paths; their semantics cannot safely be inferred from this experiment.

The smallest next implementation requires an authoritative, durable case and
source revision with a defined owner; every relevant case/source/identity/stop
change must close the exact receiver fence before acknowledging the change,
with recovery after a failed or uncertain close and no alternate bypass. Then
implement a narrowly scoped CRM task principal and receiver with real
membership, project and classification rules, immutable CRM-compatible
receipt/audit, task mutation and replay/reconciliation contracts, and an
owner/RLS configuration tested without superuser privileges. Enumerate and
protect all actual writer/revocation paths and verify both race directions,
failure recovery and deployment identity on the actual schema before any
pool or A1 effect is enabled. Until those conditions are demonstrated, the
real receiver remains absent and disabled.
