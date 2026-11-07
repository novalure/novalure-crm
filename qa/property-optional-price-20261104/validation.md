# Optional price intent — local correction evidence

Base: `8d94b6b21d07b74ef8e3960f66824c73f6a447f5`; standalone read helper: `6678c1b88dcee60bb6a0fb18b8b38db354045f38`.

This followup adds specific `publicPrice` and `rentPrice` known/unknown flags to the existing versioned core numeric state. A version number alone cannot qualify a historical zero: old guided creation could persist zero for an empty price. An unrelated area edit now keeps those old optional prices unknown. Explicit optional zero is known only through the matching field flag, and explicit unknown takes precedence over stale positive storage.

Creation writes all four numeric flags atomically. Updates merge old field intent, safe legacy defaults and only the supplied changes; legacy partial null semantics remain intact. Full editing opens historical unknown zero as blank, preserves an explicitly supplied zero through save/reload, and clears either optional price to SQL null. No schema migration is needed here. Public consumers and migration 190 are provided by the separate output correction and must use the standalone helper's field-specific semantics.

Final local validation passed **34/34 tests** across the existing six-file integrity suite:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 scripts/property-create-route-integrity-tests.ts scripts/property-core-number-state-tests.ts scripts/property-create-validation-tests.ts scripts/property-create-draft-tests.ts scripts/property-completeness-tests.ts scripts/property-country-db-tests.ts
```

The added real PostgreSQL/cookie/CSRF regression starts with the legacy zero shape, applies an unrelated partial area update, reloads through the full HTTP route, explicitly enters zero for both optional prices, then clears both and reloads again. It verifies persisted flags and SQL values at each boundary. Guided creation checks blank and explicit-zero optional prices. Existing concurrent create/replay, authority revocation, rollback, 125-field preservation, optimistic conflict and four-country checks also pass. TypeScript, focused ESLint with zero warnings and `git diff --check` pass.

The initial local run exposed a SQL parenthesis error in the new merge expression; it was corrected before the final passing runs. Disposable local fixtures only: no live writes, public links, paid provider calls, deployment, or production role acceptance. The local schema fixture limitations in `qa/property-integrity-2026-11-04/validation.md` still apply. No mounted full-editor browser proof is claimed by this followup.

## Independent alias review — negative result

A subsequent source review questioned the legacy `fieldValues["costs.mietpreis_brutto"]` alias. The complete public wrapper rejects partial `fieldValues` updates without the locked full snapshot. The real HTTP regression confirms 400 and unchanged SQL rent/knownness for positive, zero and blank aliases. A supported full editor save rebinds duplicate details from the authoritative scalar; clearing rent removes a deliberately stale positive detail alias and leaves SQL null/unknown after reload. The expanded route suite passes 10/10; typecheck, focused lint and diff check also pass. This candidate did not reproduce as a supported API defect, so no extra writer change was kept.
