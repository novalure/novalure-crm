# Existing standard QA references

The existing `livegang-e2e.yml` standard profile can explicitly select
`qa_target_ref=longfog` in the same `novalure-qa` Environment. The default
`legacy` selection retains the previous six secret and three variable names.
`isolated-candidate` always retains its existing reference family and Environment.

The LongFog family is `NOVALURE_QA_LONGFOG_` followed by the existing suffixes:
`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DATABASE_HOST`,
`MIGRATION_DATABASE_HOST`, `DATABASE_ROLE`, `MIGRATION_DATABASE_ROLE`,
`PROJECT_ID`, `BRANCH_ID`, and `DATABASE_NAME`. The first six are Environment
secrets; the last three are Environment variables. Only the reference name is
selected before installation. Secret values remain step-scoped after dependency
installation. A missing selected reference fails the existing preflight; it
does not fall back to a legacy value.

The operator prepares these new names using the existing native Neon CLI and
GitHub CLI with private stdin. The intended isolated target is
`long-fog-84900593/br-summer-mountain-bh7w67e3/neondb`, runtime `novalure_app`
and migration-only `neondb_owner`. No original secret or variable is overwritten.
The operator snapshots original name/timestamp metadata and the three original
public target values, verifies actual runtime identity in a read-only transaction,
checks the run slot before mutation, and verifies original metadata afterwards.
GitHub does not provide secret-value readback; actual delivery remains subject
to the existing `ci:qa-target` guard in the selected native run.

Rollback selects `legacy` or the preserved prior workflow revision. All original
values stay at GitHub. This is not a new Environment, database or test profile.
The existing `novalure-shared-qa` serialization, per-run data attribution, guards,
cleanup and mandatory checks remain. Preparing references does not admit a
candidate, install staged SQL, create test records, launch a browser test or
change production. Final admission still binds the actual revision, protected
build, database, roles and Evelyn counterpart.
