# Isolated V2 Preview access

This is a separate, explicit QA profile on the existing LongFog target. It does not change Production or Franz-personal verification, the normal registrars, the eight Production SQL files or the QA9 retirement file. `evelyn_autonomous_preview_qa.sql` is an additional, versioned metadata capability. It creates no workload, grant, key, member, project, Task or recovery authority.

The installer must be the actual protected NOLOGIN owner of the autonomous metadata, without SUPERUSER/BYPASSRLS/role-creation/replication rights and without runtime membership. Installation rejects every database except `neondb`, Neon project `long-fog-84900593`, branch `br-summer-mountain-bh7w67e3`. The existing runtime remains `novalure_app` with its existing safe tenant membership. No new PostgreSQL role or provider permission is required.

The server opts in with `CRM_AUTONOMOUS_PREVIEW_ENABLED=1`. Native `VERCEL=1`, environment `preview`, CRM project `prj_R32Okl6AHijTohvuKmryuTLjWMsk`, unique HTTPS `VERCEL_URL`, deployment ID and lower40hex commit SHA must match. The runtime URL must name the existing LongFog pooler, `neondb` and `novalure_app`; SQL independently checks its actual Neon target and session role. Request body fields or unsigned headers cannot select a profile or fill receiver pins.

The external workload contract is fixed:

- Identity: `EVELYN_CRM_AUTONOMOUS_QA_IDENTITY`.
- Audience: `urn:novalure:crm:autonomous-access-v2:preview:prj_R32Okl6AHijTohvuKmryuTLjWMsk`.
- Issuer/owner/Evelyn project remain the existing Novalure Vercel pins; subject is `owner:novalure:project:evelyn:environment:preview`.
- Accept fresh original RS256 Preview JWTs only. The receiver caps validity at `min(exp, iat + 300)` and rejects stale/future/expired claims. It does not change JWT bytes or require a provider TTL setting.
- The original platform token is sent separately in `x-vercel-trusted-oidc-idp-token`. The confirmed custom audience token is the CRM Bearer.

The protected Evelyn host explicitly uses `profile: 'preview'` and a mandatory receiver `{origin,deploymentId,gitSha}`. It mints the audience token with the existing SDK audience/jti/skipCache mechanism. The V2 body, three receiver-signature domains and original received base64url verification are unchanged from the receiver-bound contract. Every Preview request requires both signed receiver fields. Production defaults do not become Preview fallbacks.

Only `registerAutonomousCrmPreviewAccess(connection,input)` registers QA access. The normal registration entry points keep their original behavior. The input uses existing registration UUIDs, department/agent/mission, public Ed25519 SPKI and authority reference, with:

```ts
entity: 'Task'
preview: { origin, deploymentId, revision, qaRunId }
expiresAt: finiteUtcTimestamp
module: {
  contractVersion: 'crm-autonomous-access-v2',
  readFields: ['title'], writeFields: [], relatedResources: {},
  lifecycleMode: 'EXISTING', delegationKind: 'DEPARTMENT', parentGrantId: null
}
scopes: ['crm.tasks.read']
```

The initial native case is DescribeAssignment/Read only. A later separately admitted local/native write assignment may add `crm.tasks.write` and `writeFields:['title']`; it still requires the genuine stored intent and applicable action gates before a hosted mutation, restore, reconcile or close. A Read result proves none of those later actions. The admitted title-update/restore plan must preserve the `SYNTHETIC:` prefix and the actual own Task marker.

Before any role switch, the assigned original Task owner must be the actual `current_user=session_user`. It reads and SHARE-locks the exact workspace/project/actor/Task with `NOVALURE_INTERNAL`, `crm_sales`, `SYNTHETIC:` and metadata `{syntheticTest:true,qaRunId,scope:'autonomous-v2-preview-task'}`. The lock remains in the same transaction through registration commit. The function then checks the actual safe registry owner and existing SET permission, uses SET LOCAL ROLE, and verifies exact stored workload/grant readback. It never creates a SET lease, changes roles or trusts a supplied boolean/proof callback. The existing narrowly admitted Root self-edge lease/restoration remains an external operator prerequisite.

The original `UNIQUE(identity_id)` and `ON CONFLICT(identity_id)` inference stay intact. QA stores a canonical internal instance key `EVELYN_CRM_AUTONOMOUS_QA_IDENTITY:<lowercase-v4-qaRunId>:<deploymentId>`, with separate fixed `preview_identity_id`. The inseparable constraint binds that key to exact origin/ID/SHA/run and finite expiry. External authentication returns the fixed public QA identity. New runs/builds retain historical rows, without relabeling Production/personal identities. Registrations use the existing workload/Grant PK/FKs; conflicting IDs do not adopt an older authority.

Parent chains keep the original depth, lock order, same-workload/project/source/department/mission/contract and field/scope subset checks. Private `*_v1` consumers reach the isolated QA predicate through a narrow union wrapper; the original implementation remains private and unchanged under its preserved name. Normal reads and effects revalidate the actual own Task and current registration. QA unrevoke and reversal of disabled/kill-switch state are denied; exact capability reduction remains possible after expiry. Finite expiry retains the existing protected operator update contract. Any renewal requires its actual bound operator plan; the runtime cannot renew it automatically.

Recovery retains its separate public key, exact allowed Grant IDs, original command lock, immutable receipt/digest and metadata-only NO_EFFECT/APPLIED semantics. Its QA lookup requires a current active QA workload and recovery authority. It deliberately allows historical business grants and missing/revoked business objects, just as the original recovery contract; it adds no business-row read. Recovery does not reactivate a Grant or create a missing business effect.

The public handoff returns `workloadId`, `qaRunId`, exact receiver origin/ID/SHA and the registered CrmOperationGrant fields: IDs, entity, department/agent, delegation/parent, allowed operations, field masks, SPKI SHA256 and expiry. The assigned Evelyn owner binds its actual protected `signingKeyReference`; no private key or capability value belongs in the handoff or chat.

Local PostgreSQL/auth/compiled-sender tests are components only. They use a disposable instance of the existing sales harness; native Neon settings and `/api/version` are synthetic there. They do not prove an installed cloud stage, real Vercel OIDC, hosted Owner/CSRF session, stored native intent, App/CI acceptance or Production activation. Those remain bound to the final published pair and actual target under the existing gates.
