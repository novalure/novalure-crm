import { Pool } from "@neondatabase/serverless";

const fail = (code) => { throw new Error(code); };
const required = (env, name) => env[name]?.trim() || fail(`QA_SEED_MISSING_${name}`);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Keep a checked-out runtime client's error listener until it is safely returned or destroyed. */
export async function withQaSeedRuntimeTenant({ pool, qaTarget, workspaceId, actorId, isFailed, onError }, callback) {
  if (isFailed()) fail("QA_SEED_RUNTIME_CONNECTION_FAILED");
  const client = await pool.connect();
  let begun = false, fatal = false, ended = false;
  const onClientError = () => { fatal = true; onError(); };
  const assertConnected = () => {
    if (fatal || isFailed()) fail("QA_SEED_RUNTIME_CONNECTION_FAILED");
  };
  client.on("error", onClientError);
  let resolveEnded;
  const clientEnded = new Promise((resolve) => { resolveEnded = resolve; });
  const onEnd = () => { ended = true; resolveEnded(); };
  client.once("end", onEnd);
  const query = async (sql, params = []) => {
    assertConnected();
    const result = await client.query(sql, params);
    assertConnected();
    return result;
  };
  try {
    const identity = (await query(`select current_user as role,session_user as session_role,
      current_database() as database,current_setting('neon.project_id',true) as project,
      current_setting('neon.branch_id',true) as branch`)).rows[0];
    if (identity?.role !== "novalure_app" || identity.session_role !== "novalure_app"
      || identity.database !== qaTarget.expectedDatabase || identity.project !== qaTarget.expectedProjectId
      || identity.branch !== qaTarget.expectedBranchId) fail("QA_SEED_RUNTIME_IDENTITY_MISMATCH");
    await query("begin"); begun = true;
    const context = await query(
      "select set_config('app.tenant_id', $1, true) as workspace_id, set_config('app.actor_id', $2, true) as actor_id",
      [workspaceId, actorId],
    );
    if (context.rows[0]?.workspace_id !== workspaceId || context.rows[0]?.actor_id !== actorId) {
      fail("QA tenant context could not be verified.");
    }
    const result = await callback(query);
    assertConnected();
    await query("commit"); begun = false;
    return result;
  } catch (error) {
    // A dead connection cannot acknowledge ROLLBACK; destroy it instead of issuing more SQL.
    if (begun && !fatal && !isFailed()) {
      try { await query("rollback"); } catch { onClientError(); }
    }
    throw error;
  } finally {
    const destroy = fatal || isFailed();
    client.release(destroy);
    if (destroy && !ended) {
      let timer;
      try {
        await Promise.race([clientEnded, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("QA_SEED_RUNTIME_CLOSE_UNCONFIRMED")), 5_000);
        })]);
      } finally { clearTimeout(timer); }
    }
    // Destroyed clients retain their listener if closure cannot be confirmed.
    if (!destroy || ended) {
      client.removeListener("error", onClientError);
      client.removeListener("end", onEnd);
    }
  }
}

export function qaSeedOwnerUrl(qa, env = process.env) {
  let owner;
  try { owner = new URL(required(env, "MIGRATION_DATABASE_URL")); }
  catch { fail("QA_SEED_OWNER_URL_INVALID"); }
  const host = required(env, "NOVALURE_QA_MIGRATION_DATABASE_HOST").toLowerCase();
  const role = required(env, "NOVALURE_QA_MIGRATION_DATABASE_ROLE");
  const production = [required(env, "NOVALURE_PRODUCTION_DATABASE_HOST"), required(env, "NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST")]
    .map((value) => value.toLowerCase());
  const params = [...owner.searchParams.keys()];
  if (!/^postgres(?:ql)?:$/.test(owner.protocol) || !owner.password || role !== "neondb_owner"
    || decodeURIComponent(owner.username) !== role || owner.pathname !== `/${qa.expectedDatabase}`
    || owner.hostname.toLowerCase() !== host || !host.endsWith(".neon.tech") || host.includes("-pooler.")
    || qa.expectedHost.toLowerCase().replace("-pooler.", ".") !== host || !qa.expectedHost.includes("-pooler.")
    || production.includes(host) || production.includes(qa.expectedHost.toLowerCase())
    || owner.searchParams.get("sslmode") !== "verify-full" || owner.hash || (owner.port && owner.port !== "5432")
    || params.some((key) => !["sslmode", "channel_binding"].includes(key)) || params.length !== new Set(params).size
    || (owner.searchParams.has("channel_binding") && owner.searchParams.get("channel_binding") !== "require")) {
    fail("QA_SEED_OWNER_TARGET_DENIED");
  }
  return owner.toString();
}

/** The injection is only a transport seam for disposable local PostgreSQL tests. */
export async function withQaSeedOwner({ qaTarget, scope, phase, ownerPoolFactory }, callback) {
  if (!/^GOLIVETEST_[A-Za-z0-9_-]{6,80}$/.test(qaTarget.runPrefix) || qaTarget.expectedRole !== "novalure_app"
    || !["identities", "permissions"].includes(phase) || scope.workspaceIds.length !== 3
    || new Set(scope.workspaceIds).size !== 3 || !scope.workspaceIds.every((id) => uuid.test(id))
    || scope.users.length !== 6 || new Set(scope.users.map((user) => user.id)).size !== 6
    || !scope.users.every((user) => uuid.test(user.id)
      && scope.workspaceIds.includes(user.workspaceId) && /^qa-[a-z-]+\+golivetest_[a-z0-9_-]+@novalure\.local$/.test(user.email))
    || scope.projects.length !== 3 || new Set(scope.projects.map((project) => project.id)).size !== 3
    || !scope.projects.every((project) => uuid.test(project.id) && scope.workspaceIds.includes(project.workspaceId))) {
    fail("QA_SEED_BOOTSTRAP_SCOPE_INVALID");
  }
  const factory = ownerPoolFactory ?? (() => new Pool({
    connectionString: qaSeedOwnerUrl(qaTarget), max: 1, allowExitOnIdle: true,
    connectionTimeoutMillis: 20_000, query_timeout: 30_000, idleTimeoutMillis: 1_000,
  }));
  const pool = await factory();
  let client, begun = false, fatal = false, clientEnded;
  const onError = () => { fatal = true; };
  pool.on?.("error", onError);
  try {
    client = await pool.connect();
    client.on?.("error", onError);
    clientEnded = new Promise((resolve) => client.once("end", resolve));
    await client.query("begin"); begun = true;
    await client.query("set local search_path=pg_catalog,public");
    const identity = (await client.query(`select current_setting('neon.project_id',true) as project,
      current_setting('neon.branch_id',true) as branch,current_database() as database,
      current_user as role,session_user as session_role`)).rows[0];
    if (identity?.project !== qaTarget.expectedProjectId || identity.branch !== qaTarget.expectedBranchId
      || identity.database !== qaTarget.expectedDatabase || identity.role !== "neondb_owner" || identity.session_role !== "neondb_owner") {
      fail("QA_SEED_OWNER_IDENTITY_DENIED");
    }
    const workspaces = (await client.query("select id,is_qa,setup_state->>'qaSeedRun' as run from public.workspaces where id=any($1::uuid[]) for update", [scope.workspaceIds])).rows;
    if (workspaces.some((row) => row.is_qa !== true || row.run !== qaTarget.runPrefix)
      || (phase === "permissions" && workspaces.length !== scope.workspaceIds.length)) fail("QA_SEED_FOREIGN_WORKSPACE_COLLISION");
    const emails = [...new Set(scope.users.map((user) => user.email))];
    const existingUsers = (await client.query(`select id,workspace_id,email,auth_identity_id from public.workspace_users
      where id=any($1::uuid[]) or lower(email)=any($2::text[])`, [scope.users.map((user) => user.id), emails])).rows;
    if (existingUsers.some((row) => !scope.users.some((user) => user.id === row.id
      && user.workspaceId === row.workspace_id && user.email === row.email.toLowerCase()))
      || (phase === "permissions" && existingUsers.length !== scope.users.length)) fail("QA_SEED_FOREIGN_USER_COLLISION");
    const identities = (await client.query("select id,normalized_email from public.auth_identities where normalized_email=any($1::text[])", [emails])).rows;
    if (identities.some((row) => !existingUsers.some((user) => user.auth_identity_id === row.id
      && user.email.toLowerCase() === row.normalized_email))) fail("QA_SEED_FOREIGN_AUTH_IDENTITY_COLLISION");
    const queryOne = async (sql, params = []) => {
      if (fatal) fail("QA_SEED_OWNER_CONNECTION_FAILED");
      if (sql.includes(";")) fail("QA_SEED_OWNER_WRITE_SCOPE_DENIED");
      const table = sql.trim().match(/^insert\s+into\s+(?:public\.)?(workspaces|workspace_users|project_pipeline_permissions)\s*\(/i)?.[1];
      if (phase === "identities" && table === "workspaces" && scope.workspaceIds.includes(params[0])
        && params[7] === qaTarget.runPrefix) {
        // The static upsert also requires the matching QA marker on conflict.
      } else if (phase === "identities" && table === "workspace_users" && scope.users.some((user) =>
        user.id === params[0] && user.workspaceId === params[1] && user.email === params[3])) {
        // Central auth trigger runs as the explicit bootstrap owner only.
      } else if (phase === "permissions" && table === "project_pipeline_permissions"
        && scope.projects.some((project) => project.id === params[2] && project.workspaceId === params[1])
        && scope.users.some((user) => user.id === params[3] && user.workspaceId === params[1])) {
        const project = (await client.query(`select p.id from public.projects p join public.workspaces w on w.id=p.workspace_id
          where p.id=$1::uuid and p.workspace_id=$2::uuid and w.is_qa and w.setup_state->>'qaSeedRun'=$3`,
        [params[2], params[1], qaTarget.runPrefix])).rows[0];
        if (!project) fail("QA_SEED_PERMISSION_PROJECT_SCOPE_DENIED");
      } else fail("QA_SEED_OWNER_WRITE_SCOPE_DENIED");
      return (await client.query(sql, params)).rows[0] ?? null;
    };
    const result = await callback(queryOne);
    if (fatal) fail("QA_SEED_OWNER_CONNECTION_FAILED");
    await client.query("commit"); begun = false;
    return result;
  } catch (error) {
    if (begun) await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client?.release(fatal);
    await pool.end();
    if (clientEnded) {
      let timer;
      try {
        await Promise.race([clientEnded, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("QA_SEED_OWNER_CLOSE_UNCONFIRMED")), 5_000);
        })]);
      } finally { clearTimeout(timer); }
    }
    client?.removeListener?.("error", onError);
  }
}
