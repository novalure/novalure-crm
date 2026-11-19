import { readFile } from "node:fs/promises";
import { LocalSalesPool } from "./local-sales-db.mjs";
import { runQaCleanup } from "../../src/lib/qa-cleanup";
import type { AppSession } from "../../src/lib/auth/session";
import type { TenantPool } from "../../src/lib/db/tenant-client";

async function main() {
  const input = JSON.parse(await readFile(process.argv[2], "utf8")) as { marker: string; port: number; role: string; session: AppSession; request: unknown; metadata: { idempotencyKey: string; correlationId: string } };
  if (input.marker !== "SYNTHETIC_QA_CLEANUP_REPLAY" || !Number.isInteger(input.port) || !/^sales_qa_[a-f0-9]{12}$/.test(input.role)) throw new Error("Invalid isolated replay fixture");
  globalThis.fetch = async () => { throw new Error("Provider egress is forbidden in this fixture"); };
  const pool = new LocalSalesPool({ host: "127.0.0.1", port: input.port, user: input.role, database: "postgres", max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const result = await runQaCleanup(input.session, input.request, input.metadata, { pool: pool as unknown as TenantPool });
    process.stdout.write(JSON.stringify({ data: result.data, replayed: result.replayed, commandId: result.commandId }));
  } finally { await pool.end(); }
}
void main().catch(error => { process.stderr.write(error instanceof Error ? error.message : "Isolated replay failed"); process.exitCode = 1; });
