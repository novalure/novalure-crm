/** Operator-only offline booking fulfillment. Never uses the customer application's database login. */
import { createHash } from "node:crypto";
import { Pool } from "pg";

const help = `KI- und Website-Anfragen verwalten (separater Abrechnungszugang erforderlich)
  list [--workspace UUID] [--status pending|fulfilled|cancelled]
  reservations [--workspace UUID]
  fulfill --request UUID --reference RECHNUNGSNUMMER [--paid-through ISO-DATUM]
  close --request UUID --status fulfilled|cancelled
  reconcile --reservation UUID --credits ANZAHL --status succeeded|failed --reference PRUEFREFERENZ
Umgebung: NOVALURE_AI_BILLING_DATABASE_URL. Keine Kundenzahlung wird ausgelöst.
Bezahlte KI-Zeiträume enden am ersten Tag eines Kalendermonats um 00:00 UTC.
Laufende bezahlte Zeiträume können nicht verkürzt oder sofort herabgestuft werden.
fulfill bestätigt eine zuvor außerhalb des CRM vereinbarte Buchung. Erst dann werden Credits freigegeben.
reconcile nur nach Abgleich mit dem Anbieterbeleg; unbekannte KI-Aufrufe niemals pauschal erstatten.`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "--help"].includes(command)) { process.stdout.write(help + "\n"); return; }
  if (!["list", "reservations", "fulfill", "close", "reconcile"].includes(command)) throw new Error("INVALID_INPUT");
  if (args.length % 2) throw new Error("INVALID_INPUT");
  const input: Record<string, string> = {};
  const allowed: Record<string, readonly string[]> = {
    list: ["workspace", "status"], reservations: ["workspace"], fulfill: ["request", "reference", "paid-through"],
    close: ["request", "status"], reconcile: ["reservation", "credits", "status", "reference"],
  };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !allowed[command].includes(key) || Object.hasOwn(input, key) || !args[i + 1]) throw new Error("INVALID_INPUT");
    input[key] = args[i + 1];
  }
  const uuid = (value: string | undefined) => {
    if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new Error("INVALID_UUID");
    return value;
  };
  const reference = () => {
    if (!input.reference || input.reference.length < 3 || input.reference.length > 200 || /[\r\n\x00]/u.test(input.reference)) throw new Error("INVALID_REFERENCE");
    return input.reference;
  };
  const digest = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
  const connectionString = process.env.NOVALURE_AI_BILLING_DATABASE_URL;
  if (!connectionString) throw new Error("BILLING_DATABASE_REQUIRED");
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 });
  try {
    const role = (await pool.query(`select pg_has_role(current_user,'novalure_ai_billing_writer','USAGE')
      and not pg_has_role(current_user,'novalure_tenant_app','USAGE') and not r.rolsuper and not r.rolbypassrls
      as allowed from pg_roles r where r.rolname=current_user`)).rows[0];
    if (!role?.allowed) throw new Error("DEDICATED_BILLING_ROLE_REQUIRED");
    let result: unknown;
    if (command === "list") {
      if (input.status && !["pending", "fulfilled", "cancelled"].includes(input.status)) throw new Error("INVALID_STATUS");
      result = (await pool.query("select crm_ai_operator_requests($1::uuid,$2) as result", [input.workspace ? uuid(input.workspace) : null, input.status || "pending"])).rows[0].result;
    } else if (command === "reservations") {
      result = (await pool.query("select crm_ai_operator_reservations($1::uuid) as result", [input.workspace ? uuid(input.workspace) : null])).rows[0].result;
    } else if (command === "fulfill") {
      const requestId = uuid(input.request), order = reference();
      let paidThrough: string | null = null;
      if (input["paid-through"]) {
        const parsed = new Date(input["paid-through"]);
        if (!Number.isFinite(parsed.getTime()) || !/T/.test(input["paid-through"]) ||
          parsed.getUTCDate() !== 1 || parsed.getUTCHours() !== 0 || parsed.getUTCMinutes() !== 0 ||
          parsed.getUTCSeconds() !== 0 || parsed.getUTCMilliseconds() !== 0) throw new Error("INVALID_PAID_THROUGH");
        paidThrough = parsed.toISOString();
      }
      result = (await pool.query("select crm_ai_fulfill_booking($1::uuid,$2,$3,$4::timestamptz) as result", [requestId, order, digest({ requestId, order, paidThrough }), paidThrough])).rows[0].result;
    } else if (command === "close") {
      if (!["fulfilled", "cancelled"].includes(input.status)) throw new Error("INVALID_STATUS");
      await pool.query("select crm_ai_close_booking($1::uuid,$2)", [uuid(input.request), input.status]);
      result = { status: input.status };
    } else {
      if (!["succeeded", "failed"].includes(input.status) || !/^\d{1,6}$/.test(input.credits)) throw new Error("INVALID_RECONCILIATION");
      const reservationId = uuid(input.reservation), credits = Number(input.credits), ref = reference();
      result = (await pool.query("select crm_ai_reconcile_reservation($1::uuid,$2,$3,$4,$5) as result", [reservationId, credits, input.status, ref, digest({ reservationId, credits, status: input.status, reference: ref })])).rows[0].result;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally { await pool.end(); }
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.message : "UNAVAILABLE";
  process.stderr.write(`Vorgang nicht bestätigt (${/^[A-Z0-9_]{3,80}$/.test(code) ? code : "UNAVAILABLE"}). Berechtigung und Eingaben prüfen.\n`);
  process.exitCode = 1;
});
