# P2-11 operational reconciliation gate

Status: implemented in code, not applied to a database or provider. Inventory evidence is from the 2026-08-11 go-live audit; this change deliberately performs no provider call and no production mutation.

## Known unresolved production cohorts

| Cohort | Audited count | Current audited state | Migration 064 result | Why it remains open |
| --- | ---: | --- | --- | --- |
| Google notifications | 8 | `failed`, no authorized target mapping supplied | `pending_config`, `target_missing`, no retry lease | An authorized workspace/project Google Chat target ID has not been assigned per job. |
| Teams notifications | 10 | `pending_config`, no authorized target mapping supplied | Annotated `pending_config`, `target_missing`, no retry lease | An authorized workspace/project Teams incoming-webhook target ID has not been assigned per job. |
| Qualifying lead | 1 | `Qualifizieren`, no assignee | Preserved as legacy data by a `NOT VALID` check; all future writes are trigger-guarded | No authorized active workspace assignee was supplied. The migration must not guess a person. |

These are real audited cohorts, not seeded fixtures. Their individual IDs and authorized destination/user mappings were not provided in the audit artifact. Therefore the 18 jobs are intentionally non-retrying and operationally open; the legacy lead is intentionally not reassigned. P2-11 production acceptance cannot be claimed until an authorized operator supplies those mappings and records the outcome.

## Read-only inventory

Run with the approved read-only audit role after migration 064. Do not copy webhook credentials into tickets or logs.

```sql
select
  provider,
  status,
  configuration_code,
  count(*) as job_count
from (
  select 'google'::text as provider, status, configuration_code
  from google_notification_jobs
  where status in ('failed', 'pending_config', 'dead_letter')
  union all
  select 'teams'::text as provider, status, configuration_code
  from teams_notification_jobs
  where status in ('failed', 'pending_config', 'dead_letter')
) jobs
group by provider, status, configuration_code
order by provider, status, configuration_code;

select count(*) as qualifying_without_active_assignee
from leads l
left join workspace_users wu
  on wu.id = l.assigned_to_user_id
 and wu.workspace_id = l.workspace_id
 and wu.status = 'active'
where l.status = 'Qualifizieren'
  and wu.id is null;
```

## Authorized recovery procedure

1. An administrator identifies one enabled target in the same workspace and either the same project or workspace scope. The target must authorize the job alert type and use the worker-supported destination (`google_chat_webhook` or `incoming_webhook`).
2. Save the provider-issued HTTPS credential through the target API. The server validates provider hostname, destination, alert scope, project and workspace before it can enqueue.
3. Run `operation: "healthcheck"` (or `"reconnect"`) with the target ID only after `NOVALURE_NOTIFICATION_TEST_SINK_URL` points to the approved test sink. This probe never contacts Google or Microsoft and explicitly returns `providerHealth: "not_probed"` and `providerReconnectPerformed: false`.
4. Reconcile one job at a time through its existing `/retry` route with `{ "targetId": "..." }`. The route requires `settings:manage`, verifies target and idempotency state, records the actor, and only moves `failed`, `pending_config`, or `dead_letter` to `queued`. It does not send inline.
5. Let the leased worker perform the external delivery. A repeated reconcile with the same active target is idempotent; a different target, delivered job, cross-workspace target, project mismatch or unsupported destination is rejected. A prior timeout/transient/unknown delivery outcome is also blocked until an authorized incident owner verifies whether the provider already received it.
6. If delivery is no longer authorized or needed, leave the job non-retrying until the approved operational owner records a final cancellation. Do not mass-update the cohort to `queued`.
7. For the legacy lead, an authorized administrator must either select an active user in the same workspace or move the lead out of `Qualifizieren`. Record that action through the normal lead API so the audit trail identifies the actor.

## Acceptance evidence still required in the real environment

- Per-job authorized target mapping and final outcome for all 8 Google and 10 Teams jobs.
- Approved test-sink response for each provider configuration; no real provider call from a test or healthcheck.
- Zero duplicate provider message IDs and zero jobs cycling from `pending_config` without explicit reconciliation.
- Zero leads in `Qualifizieren` without an active same-workspace assignee, followed by validation of the `NOT VALID` check constraint.
