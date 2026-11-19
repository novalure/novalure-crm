# Current isolated candidate binding

The existing manual `livegang-e2e.yml` candidate profile now accepts exactly
`refs/heads/codex/crm-release-20261106` and the same ref in its native
`GITHUB_WORKFLOW_REF`. The old package-4 branch and mixed ref/workflow pairs
are rejected. There is no additional allowed ref or caller configuration override.
The normal Actions provenance fields must come from the actual workflow run;
synthetic unit-test profiles do not establish native Actions provenance.

The existing repository, manual event, run identity, loopback endpoint,
non-production Neon host, role, run prefix and synthetic recipient checks remain.
This profile is still a local application against isolated QA data, not a
production Studio authority or a hosted customer acceptance.

Only the manual `qa-e2e` job has a 30-minute timeout. This is a runtime limit,
not a monetary cap or a guarantee that cancellation completes every cleanup.
Its existing cleanup steps retain their `always()` conditions. Actual cleanup
results must still be checked after a run.

The current release branch is explicitly disabled in Vercel Git deployment
configuration. Existing branch rules, build command and cron definitions are
preserved. This source rule does not claim that a native project setting or
deployment has been changed by this task.
