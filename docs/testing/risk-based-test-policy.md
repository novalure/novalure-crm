# Risk-based testing and evidence

Owner instruction of 27 November 2026 for ongoing and future Evelyn and connected Novalure work. Apply this policy within each project's existing authority and security boundaries.

1. Inspect the actual change, affected dependencies and risks. Reuse existing tests and select the smallest checks that can detect the issue and demonstrate the fix. Include relevant negative cases for authentication, authorization, tenant isolation, migrations and external effects. After a correction rerun affected checks; expand coverage for a specific impact or mandatory closure or release requirement.
2. Reuse still-valid evidence and briefly record what it proves and its scope. Refresh affected evidence when necessary. Do not transfer a result to a different revision or target where the gate binds it to the original. Required full regression and CI before merge or release remain mandatory.
3. Use existing protected test environments and synthetic data uniquely attributable to a run, with effective role, row-level security, data and run boundaries. Preserve originals and audit history; clean up only the run's own designated test data. A new database, QA platform, failure proxy or model transport requires a demonstrated gap that the existing secure path cannot address.
4. Independent AI review may use the existing Codex plan. Record the actual reviewer provenance, independence, reviewed diff and findings by severity. The trusted GitHub App check for the exact final head remains mandatory where required by repository protection; an additional model protocol or separate model billing is not a general prerequisite.
5. Preserve security, authorization, tenant isolation, privacy, audit and secret boundaries, and all applicable release checks and production approvals. Ask for personal login, MFA or a separate decision only when the specific dependent step is prepared and requires it; use existing authority for ordinary technical work.
6. One responsible chat maintains a shared closure list per candidate. Other chats contribute bounded results and avoid duplicating completed work. Record the candidate and revision, target environment, required check, result, evidence and next step. Distinguish synthetic test, preview and production evidence; never report an unexecuted check as passed.

## Candidate closure list

| Candidate / revision | Environment | Required check | Result | Existing evidence and what it proves | Next step |
| --- | --- | --- | --- | --- | --- |
| Identify the candidate | Test, preview or production | Applicable requirement | Pass, fail, blocked or not run | Link and scope | Action or none |

This policy does not waive branch protection, applicable complete release regression, independent review, the trusted App check, or applicable exact-revision and target production gates. Historical exceptions remain limited to their explicitly authorized scope.

