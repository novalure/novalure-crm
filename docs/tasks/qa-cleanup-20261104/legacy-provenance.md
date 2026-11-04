# Legacy provenance evidence, with classification closed

This local successor records the original creation provenance and a current fingerprint of exact original objects. It is **not QA classification, 068 batch registration, cleanup, workspace retirement or a full inventory**. All those permissions remain false. It leaves identities, productive roles, calendars, settings, providers and business rows unchanged. Only the origin's ordinary append-only CRM command receipt/audit/event records are added. It creates no new ledger, orchestration layer, owner role, table grant or RLS bypass.

## Supported local path

`POST /api/admin/qa-legacy-provenance?workspaceId=<origin-internal-workspace>` uses the existing persisted cookie/CSRF and authorized workspace resolver. Selecting a target workspace does not grant origin authority. The source must be the actual internal Owner/Admin permitted by the existing 114 provisioning contract, with the same active stored auth identity/session and DB MFA verified during the previous fifteen minutes. The Node DTO cannot substitute for that check. JSON is limited to 16 KiB; each DB statement/lock wait has a fifteen-second timeout and pool checkout five seconds. These are not a total transaction deadline.

Plan body:

```json
{"mode":"plan","sourceReceiptId":"<original-source-command-receipt>","targetAuditId":"<original-target-provisioning-audit>","ownDraftId":"<original-personal-draft>"}
```

Use the existing UUID-v4 `Idempotency-Key` and `X-Correlation-Id` conventions and a CSRF token for this exact POST path. Do not supply an actor, target workspace, role, QA flag, free object list, owner identity or classification instruction. The target workspace/project/bot/knowledge area are derived from the caller's own immutable `customer.workspace.provision` receipt, bound back to its immutable source audit. The target `customer.workspace.provisioned` audit must agree in request, every ID, project and original target actor. Exactly one current active target Admin/workspace_admin must use the **same stored auth identity** as the origin. That member's actual private draft must be active and belong to the original project. A name prefix, supplied UUID, matching email or old inventory file never replaces this proof.

The response returns a stored `planId`, `plan.digest`, six exact identity/resource `targets` and `counts`, row/setting hashes and an explicitly unproven relation list. No draft content, bot configuration, account secrets or setting values are returned. The six targets are references, **not a deletion/adoption list**. The eight historical groups are separately qualified in `groups`.

To acknowledge only this provenance, use a fresh command key:

```json
{
  "mode":"register_provenance",
  "sourceReceiptId":"<same-original-source-receipt>",
  "targetAuditId":"<same-original-target-audit>",
  "ownDraftId":"<same-own-draft>",
  "planId":"<stored-own-plan-id>",
  "expectedPlanDigest":"<plan.digest>",
  "expectedCounts":{"bots":1,"crm_property_creation_drafts":1,"knowledge_areas":1,"projects":1,"workspace_users":1,"workspaces":1},
  "expectedTargets":[
    {"type":"bots","id":"<original-bot>"},
    {"type":"crm_property_creation_drafts","id":"<own-draft>"},
    {"type":"knowledge_areas","id":"<original-area>"},
    {"type":"projects","id":"<original-project>"},
    {"type":"workspace_users","id":"<original-existing-member>"},
    {"type":"workspaces","id":"<original-target-workspace>"}
  ],
  "confirmation":"REGISTER PROVENANCE ONLY <target-workspace> <plan.digest>"
}
```

Replace every placeholder with the exact returned value. All target IDs, counts, actor/origin, selectors, current row/setting fingerprints, tenant-table structure/policy/ACL metadata fingerprints and the fifteen-minute plan expiry are checked before the generic receipt replay lookup. Identical new-process retries recover one committed evidence receipt only while those current qualifications still hold; withdrawn authority, stale state or expiry deny even an old successful key. The SQL helper restores the origin context on success and exceptions, so receipts/audits remain in the origin and no caller can nominate a target actor. Fingerprint comparison is evidence about the reads made in that transaction, not complete workspace visibility or authority to perform any later business mutation; module-setting rows and unknown relations are not a complete locked resource graph.

`provenance_registered` means only that this exact evidence was persisted. Every result retains `classificationAllowed=false`, `qaFlagChanged=false`, `qaBatchCreated=false`, `cleanupAllowed=false`, `businessMutations=false`, `accountsAndRightsChanged=false` and `calendarsChanged=false`. Migration 195 is SECURITY INVOKER under existing RLS and adds only EXECUTE on this one function. It does not expose a QA marker setter or permit arbitrary new QA workspaces. If a target is already QA, this deliberately non-QA legacy path refuses it.

## Eight-group boundary and precise remaining package

| Historical group | This successor proves | Still open / preserved |
|---|---|---|
| Workspace | Original creation IDs plus current row fingerprint | Current complete owned-resource graph, explicit QA classification, inactive/archive lifecycle and public/job denial |
| Project | Exact original project/current hash and target read/write authority | Tenant-complete incoming successor visibility and supported retirement |
| Personal object draft | Current original member's active personal draft, project and row/revision hash | Discard requires a separately eligible registered batch; foreign private drafts remain private |
| Target membership | Same current existing identity as origin, active original Admin/workspace_admin | Preserve this existing membership/shared identity; do not treat it as a temporary test user. Separately registered temporary users/grants need normal revoke/suspend/session invalidation |
| Bot | Exact original bot/project and current hash | Provider/channel/public-link state and supported exact retirement |
| Knowledge area | Exact original area/project and current hash | Complete source/version/chunk/index/job descendants and supported archive |
| Settings | Current workspace/module-setting fingerprints only | Original before-values and complete baseline, exact version/hash restoration, current entitlements and later genuine changes; preserve calendars |
| Audit events | Exact immutable source command/audit and target provisioning audit | Retain all append-only audit/history anchors; never delete or call mutable active rows an audit exception |

The relation list is **catalog metadata, not row visibility or zero counts**. It expressly includes even known tenant tables because hashing one original row does not establish absence of other rows in that table. The following resource scopes remain uncovered and block classification/retirement: additional memberships and project grants; private per-user drafts/mail/calendar data; contacts/organizations/leads/deals/tasks/property listings/units/reservations/media; bots and knowledge sources/versions/indexes; public/webchat/funnel/share links; booking/automation/newsletter/outreach/notification/export queues and leases; module/entitlement/integration settings; provider/blob resources and global jobs without a trustworthy tenant relation. Unknown/future schemas remain unproven. No count from a historical snapshot is consumed as a current safety predicate.

Only a separately reviewed, current, narrow **tenant-complete visibility contract** for the actual resource graph plus exact registration/ownership/dependency checks can enable 068 classification. Any foreign/unregistered resource or unknown visibility must prevent blanket workspace shutdown. This helper deliberately cannot perform that transition, even when its original provenance is valid. The next implementation package is that complete visibility/admission contract and supported individually registered lifecycle adapters, not a generic privileged reader. A different separately authorized first-time QA provisioning path for new isolated tenants is also not implemented here.

## Historical evidence references, not live execution

The authorized original tuple is documented in the campaign's `live-evidence/qa-original-provenance-2026-11-04T22-43-30-638Z.json`: source receipt `c759934a-3968-41e5-a147-ca262e125c01`, target audit `91ccf505-7340-4e83-a5b1-591b444fca1f`, target workspace `69f1202e-b506-4127-9f59-a68d44c4b6ce`, project `0954acfe-e023-4cb3-8483-6e07f1a1db8e`, bot `c3d094f2-63fc-40e6-9818-e2d5f49a95fd`, area `57f2ac63-47e3-4e05-884d-1cc8478c36c7`, member `1cf46dcd-f79d-4934-ab1e-9cb3f6947186`, draft `284628d7-7500-4cf1-9eb3-c38da9c4660c`. Origin actor is `bf34e694-7aba-4359-b027-f43a68255523`. These values are documentation references, not migration seeds, hardcoded grants or current access evidence. The function consumes and revalidates actual stored provenance, not these files.

`live-evidence/qa-effects-inventory-225115Z.json` is a separate old 34-relation snapshot, not complete current visibility. Neither file grants execution authority. No live request, production classification, workspace change, account action, provider request or cleanup was performed by this successor.
