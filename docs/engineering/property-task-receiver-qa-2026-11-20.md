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

The outer receiver function runs as a dedicated **NOLOGIN, non-superuser,
non-BYPASSRLS** definer, which is not the table owner or a member of the
general CRM role. Runtime logins have only schema usage and function EXECUTE,
no direct table rights, and cannot assume the definer role. The real CRM
tables and the two QA tables have FORCE RLS enabled. The test extends the
role lists of the existing CRM policies to the QA definer in this disposable
database only, without changing their expressions or commands; a catalog
comparison and a foreign-tenant read/write test check those properties.
Extending a policy to a new principal is nevertheless a local authorization
change, not evidence that such a grant is safe in production.

The definer has column-level CRM privileges for the queried fields, task and
audit insertion, plus UPDATE on the `id` column of projects, units and tasks
and `generation` on the QA authority row because PostgreSQL row locks require
UPDATE privilege. It does not have table-wide UPDATE/DELETE or task-title
UPDATE. The existing CRM onboarding trigger also requires read access to the
project's `setup_defaults` column. All of these grants are to a NOLOGIN role,
but their suitability under a real owner, real privileges and real identity
issuance is not established. Existing nested `crm_lock_active_member` and
`crm_lock_project_access` functions were installed by the partial bootstrap
under its local superuser; their actual production owner/RLS configuration is
not validated by this experiment. Thus this is **not a full production
least-privilege or forced-RLS proof**. The test receipt and audit action are not the CRM command
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
