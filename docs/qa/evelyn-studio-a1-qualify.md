# Studio A1 qualification in CRM

The staged Ireland repository comes from `d8188bd4` and the machine boundary from
`f92fb5f4`. The current evidence and contact-stop checks follow `dccbafa5`.
The endpoint is `POST /api/integrations/evelyn/website-sales`. It accepts
`website-sales-machine-v1` workflow read, qualify execution, and exact-original
qualify reconciliation. The assigned, protected SALES registration scopes are
`crm.website-sales.read`, `crm.website-sales.qualify`, and
`crm.website-sales.reconcile`. Reconciliation also requires qualify authority.
Production uses the existing project-bound Evelyn OIDC verifier plus the
saved Ed25519 delegation for the exact company, branch, CRM project and actor.

An internal, authorized CRM user registers the Irish company branch and records
current evidence through `/api/crm/website-sales` using their CRM session.
The persisted `OBSERVED` workflow must recompute to `READY` with the exact
branch, current version and evidence digest. Studio acceptance proves source
identity. Qualification also requires a resolved canonical contact belonging
to that company, the original Studio project, and no applicable stop.
The fixed Studio submission uses the Novalure Eigenakquise project seeded
by migration 030. D11 assigns its canonical division to its records.
Qualification retains that division and requires company, lead, deal and
pipeline to agree with it.

The execute request wraps `website-sales-ireland-v1` / `qualify` with
`projectId`, `companyId`, `locationId`, `expectedVersion`, UUIDv4
`idempotencyKey`, `correlationId`, and payload:

```text
contactId, opportunitySummary, nextAction, expectedEvidenceDigest,
studioTransfer: {sourceGrantId, operationId, revision, payloadHash, leadId, submissionId}
```

Use the authenticated SOURCE response's `sourceGrantId` and event values
in the signed execution request.
CRM independently authenticates the associated current workload and SOURCE
grant, checks the accepted live transfer against its activation boundary,
and validates the exact original contact, lead and deal from the submission.
A missing or conflicting link is a manual-review outcome. The accepted
lead and deal retain their original commercial state and source metadata.
CRM adds one separate internal qualification follow-up and stores its
`data.workflow.nextTaskId` in the command receipt atomically. Any existing
Studio intake task stays in place. Evelyn uses this ID and receipt directly.

After an uncertain outcome, sign a fresh delegation nonce over the exact
original inner request with envelope operation `reconcile`. Verified
`COMMITTED` provides the stored audit reference, command ID and task ID.
CRM checks current Sales authority before returning a receipt. `NOT_FOUND`
has no business effect. Any permitted retry keeps the original inner
command and idempotency key.

Installation is a separate protected change. The SOURCE stage and staged
`202_website_sales_ireland.sql` then `203_website_sales_machine.sql` must
be independently admitted on the exact target. The stages seed no
activation, identity, grants or business data. The protected registration
helper accepts only the three A1 scopes.

### Protected Long Fog Preview

Enable `CRM_WEBSITE_SALES_PREVIEW_ENABLED=1` only on the admitted exact CRM
Preview. Use the native deployment URL and a real Evelyn Preview OIDC
token with audience
`urn:novalure:crm:website-sales:preview:prj_R32Okl6AHijTohvuKmryuTLjWMsk`.
Continue to sign the full request with the Ed25519 key for its separate
Preview Sales grant.

Register the Preview workload and expiring Sales grant with
`preview: {deploymentId, revision, sourceGrantId}`. The SOURCE grant
belongs to the same Preview deployment and revision. The Sales lookup and
SOURCE effect check enforce Long Fog project `long-fog-84900593`, branch
`br-summer-mountain-bh7w67e3`, database `neondb` and the `novalure_app`
runtime. The audit identity is `EVELYN_WEBSITE_SALES_QA_IDENTITY` with role
`Evelyn.QA`. Production keeps its production OIDC verifier and grants.

Targeted qualification regression:

```text
node --conditions=react-server --import tsx --test scripts/website-sales-a1-qualify-tests.ts
```

Both profiles exercise the actual 202/203 DDL, Sales route and receipt
transaction in disposable local PostgreSQL. The production test uses a
synthetic SOURCE tuple. The Preview test also installs the guarded SOURCE
stage and uses locally signed OIDC fixtures and simulated native target
metadata. A protected Vercel run provides the separate native acceptance.
