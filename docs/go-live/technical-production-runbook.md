# Technical Production runbook

Autonomy and Access Framework `2.0.0` pre-authorizes regular technical Production deployment, required application configuration, backward-compatible database migration, verified application connection, controlled Canary activation, promotion after a healthy Canary, and rollback of the agent's own faulty change. This repository update does not execute any such operation.

## Required evidence for the exact target

Every item must be `PASS` before the write. A missing or stale item is a stop, not a manual approval loop.

1. **Target and identity:** repository, commit, project, environment, tenant/resource and execution identity match the reviewed plan; Runtime and migration identities are separated and least-privileged.
2. **Quality:** relevant tests, typecheck, lint, build, migration/upgrade tests, dependency audit, secret scan and required CI checks pass on the exact candidate.
3. **Security and isolation:** no open applicable Critical/High, tenant-isolation, authorization, credential or Production-readiness blocker; required reviews and branch protection are satisfied.
4. **Credentials:** workload identity or secret-manager references are verified without exposing values; Runtime login/TLS and negative privilege tests pass; no Runtime owner/superuser/admin-equivalent privilege exists.
5. **Recovery:** an appropriate current backup or restore point exists, the restore path has been exercised for the relevant scope, integrity checks are defined, and rollback compatibility is understood.
6. **Rollout:** the migration/deployment order, affected resources, bounded Canary cohort, observation window and promotion steps are recorded. Destructive or irreversible work is excluded unless separately decided.
7. **Monitoring and aborts:** health, error rate, latency, authorization/isolation, queue and data-integrity signals are observable. Numeric or otherwise unambiguous abort thresholds and an on-call/notification path are recorded.
8. **Rollback:** the exact rollback or forward-fix command/path, owner, decision threshold and post-rollback verification are recorded and do not require unsafe schema/data reversal.

Record sanitized evidence before execution and after every stage. Abort and roll back on a threshold breach; do not promote an unhealthy Canary. Do not bypass a required review or branch rule.

## Exceptions

Irreversible deletion of real business data, destructive migration without a proven recovery path, and removal of a security boundary are not durably authorized. Prepare the exact resource, effect, recovery limits and decision required from Franz. Business actions such as payments, contract execution, customer communication and personnel decisions remain governed by their own approvals.

## Existing blockers

- The Evelyn Neon Runtime bootstrap remains incomplete until password establishment, Runtime TLS/login, full negative privilege tests and removal of temporary Vault rights are evidenced. Do not overwrite `prod-neon-runtime-db` merely because the framework version changed.
- G08 evidence may be expanded only by new actual verification.
- G27 remains open until its separately required local QA cleanup is actually performed and absence is verified. Framework 2.0.0 removes a pure authorization objection to that narrowly scoped cleanup; it does not itself delete or prove absence of any file.
