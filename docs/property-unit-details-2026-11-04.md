# Structured property unit details — 4 November 2026

Implemented in the isolated property-completeness worktree. No production connection, provider action or release was performed by this task.

## Stored contract

Migration `186_property_unit_details.sql` adds nullable columns to the existing forced-RLS `property_units` table. Existing rows remain unknown; no data is guessed from a project, another unit or generic property labels.

| DTO field | SQL column | Meaning |
| --- | --- | --- |
| balconyAreaSqm | balcony_area_sqm | Balcony area, m² |
| terraceAreaSqm | terrace_area_sqm | Terrace area, m² |
| gardenAreaSqm | garden_area_sqm | Garden area, m² |
| loggiaAreaSqm | loggia_area_sqm | Loggia area, m² |
| roofTerraceAreaSqm | roof_terrace_area_sqm | Roof terrace area, m² |
| undergroundParkingCount | underground_parking_count | Underground spaces |
| carportCount | carport_count | Carport spaces |
| outdoorParkingCount | outdoor_parking_count | Outdoor spaces |
| bedrooms | bedrooms | Bedroom count, separate from total rooms |
| heatingYear | heating_year | Unit heating installation year, separate from building year |
| investorPriceCents | investor_price_cents | Optional second investor price, integer EUR cents |

All real private loader responses return numbers or null. The TypeScript fields remain optional to tolerate historical in-memory fixture objects. Unknown is null; zero is an explicitly recorded value. Areas accept at most two decimals, counts require whole numbers, and heating year is bounded to 1800–2200. The price input and parser preserve exact cents, including the safe integer boundary.

## Editing and authorization

The unit board can record details during creation and reopen them through **Details bearbeiten**. Existing units are editable in every sales status. This edit changes neither sale price, investor price, unit status nor reservations. Empty values clear a detail to null; omitted keys in partial API updates preserve the stored detail. Read users can expand unit details in the table.

`POST /api/crm/units?workspaceId=…` uses the existing authenticated CSRF-protected workspace session and fresh project-write checks:

- `operation: unit` creates an inventory record with the optional descriptive fields. Existing main-price confirmation rules remain in force.
- `operation: unit_details` accepts `projectId`, `unitId`, numeric `expectedVersion`, the descriptive fields, and request identifiers. It cannot accept a price field.
- `operation: investor_price` accepts `investorPriceCents` (safe integer cents or explicit null), a nonempty `sourceReference`, unit/project/version and request identifiers. It checks the same explicit project price mandate, developer organization/contact relationship and authority serialization key as ordinary sale-price confirmation. Clearing also requires that mandate and a source. Main sale price is preserved.

Updates lock the real scoped unit and compare its persisted version. Each accepted edit increments the source version and timestamp, records before/after detail values in the append-only unit audit, and stores the ordinary command receipt/audit. The existing migration159 unit-change trigger already queues matching refresh for all property unit updates; no parallel fan-out trigger was added. RLS is not disabled and no new table/function grants are introduced.

## Public output boundary

The public/PDF implementation consumes only an actually selected unit with a verified property-unit relationship. The investor price is an internal second price and is not automatically copied into public output or used as a public-price override. No project-first or first-unit fallback is authorized by this contract. Publication still uses the existing reviewed immutable version flow.

## Local verification

`node --conditions=react-server --import tsx --test scripts/property-unit-details-tests.ts` exercises the actual SQL migration and repositories against disposable local PostgreSQL through the nonprivileged tenant transaction role. It covers typed/null/zero round trips through both private loaders, partial clearing, status and price preservation, exactly-one-writer CAS, matching refresh, project and price-mandate denial, exact-cent confirmation/replay/clearing, database range checks and rollback after an audit failure. No production credentials are consumed.

The accompanying existing unit-board price and accessibility regressions also pass. Global build, browser acceptance and production migration/deployment belong to the integrated release performed by the root task.
