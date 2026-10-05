import { getSqlClient } from "@/lib/db/client";

// Every property-media writer takes this same parent lock before its mutation.
// READ COMMITTED gives the second statement a fresh snapshot after any waiter,
// including attachments that were not visible when the transaction began.
// The mutation must still recheck its own property/workspace/project target.
export async function queryPropertyMediaMutation<Row extends Record<string, unknown>>(input: {
  propertyId: string;
  workspaceId: string;
  query: string;
  params: unknown[];
}): Promise<Row | null> {
  const sql = getSqlClient();
  // Keep both lazy queries inside one HTTP transaction. Never retry a mutation
  // automatically when its transport completion is uncertain.
  const results = await sql.transaction<false, false>([
    sql.query(`
      select id from seller_listings
      where id = $1::uuid and workspace_id = $2::uuid
      for update
    `, [input.propertyId, input.workspaceId]),
    sql.query(input.query, input.params),
  ], { isolationLevel: "ReadCommitted" });
  return (results[1]?.[0] as Row | undefined) ?? null;
}
