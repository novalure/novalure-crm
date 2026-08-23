"use client";

import { useEffect, useState } from "react";
import type {
  SystemDatabaseDiagnosticIssue,
  SystemDatabaseDiagnostics,
} from "@/app/api/system/database/route";
import type { LanguageCode } from "@/lib/i18n";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

const diagnosticIssueCodes = new Set<SystemDatabaseDiagnosticIssue["code"]>([
  "database_not_configured",
  "migration_checksum_incomplete",
  "migration_current_version_missing",
  "migration_ledger_empty",
  "migration_ledger_unavailable",
  "missing_tables",
  "table_check_failed",
  "table_inventory_incomplete",
]);

function isDiagnosticIssue(value: unknown): value is SystemDatabaseDiagnosticIssue {
  if (!isRecord(value) || typeof value.code !== "string") return false;
  if (!diagnosticIssueCodes.has(value.code as SystemDatabaseDiagnosticIssue["code"])) return false;
  return value.detail === undefined || typeof value.detail === "string";
}

export function parseSystemDatabaseDiagnostics(value: unknown): SystemDatabaseDiagnostics | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (!Array.isArray(value.expectedTables) || !value.expectedTables.every((item) => typeof item === "string")) {
    return null;
  }
  if (!Array.isArray(value.missingTables) || !value.missingTables.every((item) => typeof item === "string")) {
    return null;
  }
  if (!Array.isArray(value.issues) || !value.issues.every(isDiagnosticIssue)) return null;
  if (!Array.isArray(value.migrationLedger) || !Array.isArray(value.tableStatus)) return null;
  if (!isNullableString(value.migrationLedgerError) || !isNullableString(value.tableCheckError)) return null;
  if (!isRecord(value.status) || typeof value.status.configured !== "boolean") return null;
  if (!isRecord(value.migrationStatus)) return null;

  const { checksumRows, currentVersion, rows } = value.migrationStatus;
  if (!isNonNegativeInteger(rows) || !isNonNegativeInteger(checksumRows) || checksumRows > rows) return null;
  if (!isNullableString(currentVersion)) return null;

  const validLedger = value.migrationLedger.every(
    (row) =>
      isRecord(row) &&
      typeof row.version === "string" &&
      isNullableString(row.checksum),
  );
  const validTableStatus = value.tableStatus.every(
    (row) => isRecord(row) && typeof row.exists === "boolean" && typeof row.tableName === "string",
  );
  if (!validLedger || !validTableStatus) return null;

  const derivedChecksumRows = value.migrationLedger.filter(
    (row) => isRecord(row) && typeof row.checksum === "string" && row.checksum.trim().length > 0,
  ).length;
  const lastLedgerRow = value.migrationLedger.at(-1);
  const derivedCurrentVersion =
    isRecord(lastLedgerRow) && typeof lastLedgerRow.version === "string"
      ? lastLedgerRow.version.trim() || null
      : null;
  if (
    rows !== value.migrationLedger.length ||
    checksumRows !== derivedChecksumRows ||
    currentVersion !== derivedCurrentVersion ||
    value.ok !== (value.issues.length === 0)
  ) {
    return null;
  }

  if (value.status.configured) {
    if (typeof value.status.pooledUrlEnv !== "string" || typeof value.status.directUrlEnv !== "string") return null;
  } else if (!Array.isArray(value.status.missing) || !value.status.missing.every((item) => typeof item === "string")) {
    return null;
  }

  return value as SystemDatabaseDiagnostics;
}

function getIssueLabel(issue: SystemDatabaseDiagnosticIssue, de: boolean) {
  const labels: Record<SystemDatabaseDiagnosticIssue["code"], [string, string]> = {
    database_not_configured: ["Datenbank nicht konfiguriert", "Database not configured"],
    migration_checksum_incomplete: ["Checksums im Ledger unvollständig", "Ledger checksums incomplete"],
    migration_current_version_missing: ["Aktuelle Migration nicht bestimmbar", "Current migration cannot be determined"],
    migration_ledger_empty: ["Migrations-Ledger ist leer", "Migration ledger is empty"],
    migration_ledger_unavailable: ["Migrations-Ledger nicht verfügbar", "Migration ledger unavailable"],
    missing_tables: ["Erwartete Tabellen fehlen", "Expected tables are missing"],
    table_check_failed: ["Tabellenprüfung fehlgeschlagen", "Table check failed"],
    table_inventory_incomplete: ["Tabelleninventar unvollständig", "Table inventory incomplete"],
  };
  const label = labels[issue.code]?.[de ? 0 : 1] ?? (de ? "Unbekannter Diagnosefehler" : "Unknown diagnostic issue");
  return issue.detail ? `${label}: ${issue.detail}` : label;
}

export function SystemReleasesPanel({ language }: { language: LanguageCode }) {
  const de = language === "de";
  const [status, setStatus] = useState<SystemDatabaseDiagnostics | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/system/database", { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("status_unavailable");
        const payload: unknown = await response.json();
        const parsed = parseSystemDatabaseDiagnostics(payload);
        if (!parsed) throw new Error("status_contract_invalid");
        return parsed;
      })
      .then((payload) => {
        setFailed(false);
        setStatus(payload);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFailed(true);
      });
    return () => controller.abort();
  }, []);

  const cards: Array<[string, string]> = [
    [de ? "Laufzeitstatus" : "Runtime status", status ? (status.ok ? (de ? "Bereit" : "Ready") : (de ? "Prüfung nötig" : "Review required")) : "…"],
    [de ? "Aktuelle Migration" : "Current migration", status?.migrationStatus.currentVersion ?? "–"],
    [de ? "Ledger-Einträge" : "Ledger rows", status ? String(status.migrationStatus.rows) : "–"],
    [de ? "Checksums im Ledger" : "Recorded checksums", status ? String(status.migrationStatus.checksumRows) : "–"],
  ];

  return (
    <section aria-labelledby="system-releases-title" className="grid gap-4">
      <header className="rounded-xl border border-stone-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">{de ? "Administration" : "Administration"}</p>
        <h2 className="mt-1 text-2xl font-semibold text-stone-950" id="system-releases-title">{de ? "System & Releases" : "System & releases"}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{de ? "Schreibgeschützte Laufzeit-, Ledger- und Release-Evidenz für den aktiven Workspace." : "Read-only runtime, ledger and release evidence for the active workspace."}</p>
      </header>
      {failed ? <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">{de ? "Systemstatus konnte nicht geladen werden." : "System status could not be loaded."}</p> : null}
      <div aria-live="polite" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(([label, value]) => (
          <article className="rounded-xl border border-stone-200 bg-white p-4" key={label}>
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</p>
            <p className="mt-2 break-words text-lg font-semibold text-stone-950">{value}</p>
          </article>
        ))}
      </div>
      {status && !status.ok ? (
        <article className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-950" role="status">
          <h3 className="font-semibold">{de ? "Offene Diagnosepunkte" : "Open diagnostic issues"}</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {status.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>{getIssueLabel(issue, de)}</li>
            ))}
          </ul>
        </article>
      ) : null}
      <article className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <h3 className="font-semibold">{de ? "Release-Gate" : "Release gate"}</h3>
        <p className="mt-1 leading-6">{de ? "Ein grüner Build allein ist kein Produktions-GO. Restore, Tenant-Isolation, Providerkonfiguration und Langzeit-SLO bleiben separate Freigaben." : "A green build alone is not a production GO. Restore, tenant isolation, provider configuration and the long-running SLO remain separate approvals."}</p>
      </article>
    </section>
  );
}
