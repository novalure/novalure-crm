import { readFile } from "node:fs/promises";

/** Historical narrow fixtures need the current application's scalar media
 * primitives without pretending to rehearse the complete 189 RLS cutover.
 * Execute the actual migration SQL; project-media tests cover 189 in full. */
export async function applyMediaProjectRuntimeFunctions(db) {
  const sql = await readFile("migrations/189_property_media_project_access.sql", "utf8");
  const start = sql.indexOf("create function crm_workspace_media_usage");
  if (start < 0) throw new Error("Media runtime migration primitives missing");
  await db.admin.query(sql.slice(start));
}
