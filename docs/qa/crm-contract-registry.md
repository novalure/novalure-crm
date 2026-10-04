# CRM / Evelyn contract registry

`src/lib/crm-contract-registry.ts` is the machine-readable, provider-neutral
contract catalogue for the Novalure CRM and Evelyn boundary. It does not enable
a provider, send customer communication, authorize a payment, or deploy a
runtime.

The registry covers record reads and writes, events, tasks, activities,
approvals, documents, customer communication, reporting and finance
references. Every entry declares its schema version, producer, consumer,
compatibility policy, required tests and change owner. The canonical entity
map covers Contact, Company, Lead, Deal, Pipeline, Activity, Email, Meeting,
Task, Document, Offer, Project, WorkPackage, Approval and SupportCase. Where a
native table does not exist, the mapping is explicitly a projection over an
existing tenant-owned model; no database migration is implied.

The acquisition profiles `developer_project_marketing` and
`website_web_design` both use the existing `crm_pipelines` model. Their stage
and entity vocabularies are contract metadata, not automatic seed data.

Compatibility is fail closed. The existing synthetic HTTP boundary keeps the
pinned `crm-integration-v1` wire value for Evelyn parity and publishes registry
schema/version metadata in responses. Runtime contract selection requires the
exact active schema. Writes additionally reject a schema older than the schema
that produced the current state and continue to use the existing resource CAS.
Unknown contracts, access directions and versions are rejected.

`detectCrmContractImpact` classifies additions, removals, entity-map changes,
pipeline changes and compatibility changes. `assertCrmContractRegistryChange`
requires a SemVer registry bump matching that impact. The synthetic suite
contains no real tenant data, provider calls, email, payment or deployment and
includes isolation-preserving negative assertions.
