import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { parseBehaviorSelection, SharedBehaviorError, type BehaviorSelection } from "./catalog";
import { evaluateSelection } from "./evaluation";

type PublisherPool = Pick<Pool, "connect">;
type Candidate = { id: string; rule_ids: string[]; targets: string[]; baseline_revision: number };
function revision(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2147483647) throw new SharedBehaviorError("INVALID_HEAD_REVISION");
}
function uuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new SharedBehaviorError("INVALID_CANDIDATE_ID");
}
async function transaction<T>(pool: PublisherPool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local statement_timeout='5s'");
    const { rows } = await client.query<{ safe: boolean }>(`select not rolsuper and not rolbypassrls and not rolcreatedb and not rolcreaterole and not rolreplication
      and pg_has_role(current_user,'novalure_behavior_publisher','USAGE')
      and not pg_has_role(current_user,'novalure_tenant_app','MEMBER')
      and not pg_has_role(current_user,'novalure_app','MEMBER')
      and not has_table_privilege(current_user,'public.behavior_learning_signals','SELECT')
      and not has_table_privilege(current_user,'public.workspace_users','SELECT') as safe from pg_roles where rolname=current_user`);
    if (rows[0]?.safe !== true) throw new SharedBehaviorError("UNSAFE_PUBLISHER_IDENTITY");
    await client.query("select pg_advisory_xact_lock(71626026)");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}
async function head(client: PoolClient) {
  const { rows } = await client.query<{ revision: number; version: number; rule_ids: string[]; targets: string[] }>(`select h.revision,h.version,r.rule_ids,r.targets from behavior_release_head h left join behavior_releases r on r.version=h.version where h.singleton=true`);
  const row = rows[0];
  return { revision: row?.revision ?? 0, version: row?.version ?? 0,
    selection: row?.version ? parseBehaviorSelection({ ruleIds: row.rule_ids, targets: row.targets }) : null };
}
async function candidate(client: PoolClient, id: string) {
  uuid(id);
  const row = (await client.query<Candidate>("select * from behavior_candidates where id=$1", [id])).rows[0];
  if (!row) throw new SharedBehaviorError("CANDIDATE_NOT_FOUND");
  return row;
}
/** Dedicated, explicitly injected publisher pool; never uses DATABASE_URL or tenant credentials. */
export function createBehaviorLifecycle(pool: PublisherPool) {
  return {
    /** Dedicated publisher administration; never expose this pool through a tenant HTTP route. */
    async inspect() {
      return transaction(pool, async client => ({
        head: await head(client),
        candidates: (await client.query("select id,rule_ids,targets,baseline_revision from behavior_candidates order by id limit 100")).rows,
        evaluations: (await client.query("select candidate_id,checks,improvements,regressions,passed from behavior_evaluations order by candidate_id limit 100")).rows,
        history: (await client.query("select revision,action,version,candidate_id from behavior_publication_events order by revision desc limit 100")).rows,
        runs: (await client.query("select run_id,slot,status,started_at,completed_at from behavior_learning_runs order by slot desc limit 30")).rows,
      }));
    },
    async admitScheduledRun() {
      return transaction(pool, async client => {
        // DB clock only. A running or failed claim is retained and never automatically retried.
        const id = randomUUID();
        const result = await client.query(`insert into behavior_learning_runs(run_id,slot,status)
          values($1,date_trunc('day',now() at time zone 'UTC') at time zone 'UTC','running')
          on conflict(slot) do nothing returning run_id`, [id]);
        return result.rowCount ? id : null;
      });
    },
    async finishScheduledRun(id: string, status: "published" | "rejected" | "failed") {
      uuid(id);
      if (!["published", "rejected", "failed"].includes(status)) throw new SharedBehaviorError("INVALID_RUN_STATUS");
      return transaction(pool, async client => {
        const result = await client.query("update behavior_learning_runs set status=$2,completed_at=now() where run_id=$1 and status='running' returning run_id", [id, status]);
        if (result.rowCount !== 1) throw new SharedBehaviorError("RUN_NOT_ACTIVE");
      });
    },
    async propose(value: unknown, expectedRevision: number) {
      const selection = parseBehaviorSelection(value); revision(expectedRevision);
      return transaction(pool, async client => {
        if ((await head(client)).revision !== expectedRevision) throw new SharedBehaviorError("STALE_BEHAVIOR_HEAD");
        const id = randomUUID();
        await client.query("insert into behavior_candidates(id,rule_ids,targets,baseline_revision) values($1,$2,$3,$4)", [id, selection.ruleIds, selection.targets, expectedRevision]);
        return { candidateId: id, baselineRevision: expectedRevision };
      });
    },
    async evaluate(id: string) {
      return transaction(pool, async client => {
        const row = await candidate(client, id), current = await head(client);
        if (row.baseline_revision !== current.revision) throw new SharedBehaviorError("STALE_BEHAVIOR_HEAD");
        const result = evaluateSelection({ ruleIds: row.rule_ids, targets: row.targets }, current.selection);
        await client.query(`insert into behavior_evaluations values($1,$2,$3,$4,$5,$6,$7) on conflict(candidate_id) do nothing`,
          [id, result.evaluatorDigest, result.selectionDigest, result.checks, result.improvements, result.regressions, result.passed]);
        return result;
      });
    },
    async publish(id: string, expectedRevision: number) {
      revision(expectedRevision);
      return transaction(pool, async client => {
        const row = await candidate(client, id), current = await head(client);
        if (current.revision !== expectedRevision || row.baseline_revision !== expectedRevision) throw new SharedBehaviorError("STALE_BEHAVIOR_HEAD");
        const result = evaluateSelection({ ruleIds: row.rule_ids, targets: row.targets }, current.selection);
        const receipt = (await client.query("select * from behavior_evaluations where candidate_id=$1", [id])).rows[0];
        if (!result.passed || !receipt?.passed || receipt.evaluator_digest !== result.evaluatorDigest || receipt.selection_digest !== result.selectionDigest)
          throw new SharedBehaviorError("BEHAVIOR_EVALUATION_REQUIRED");
        const version = Number((await client.query("select coalesce(max(version),0)+1 as version from behavior_releases")).rows[0].version);
        await client.query("insert into behavior_releases values($1,$2,$3)", [version, row.rule_ids, row.targets]);
        const next = current.revision + 1;
        await client.query(`insert into behavior_release_head(singleton,version,revision) values(true,$1,$2)
          on conflict(singleton) do update set version=excluded.version,revision=excluded.revision`, [version, next]);
        await client.query("insert into behavior_publication_events values($1,'publish',$2,$3)", [next, id, version]);
        return { version, revision: next };
      });
    },
    async rollback(version: number, expectedRevision: number) {
      revision(expectedRevision);
      if (!Number.isSafeInteger(version) || version < 0) throw new SharedBehaviorError("INVALID_ROLLBACK_VERSION");
      return transaction(pool, async client => {
        const current = await head(client);
        if (current.revision !== expectedRevision) throw new SharedBehaviorError("STALE_BEHAVIOR_HEAD");
        if (version === current.version || (version !== 0 && !(await client.query("select 1 from behavior_publication_events where version=$1 and action='publish'", [version])).rowCount))
          throw new SharedBehaviorError("ROLLBACK_VERSION_NOT_PUBLISHED");
        await client.query("update behavior_release_head set version=$1,revision=revision+1 where singleton=true", [version || null]);
        await client.query("insert into behavior_publication_events values($1,'rollback',null,$2)", [current.revision + 1, version || null]);
        return { version, revision: current.revision + 1 };
      });
    },
  };
}
export type { BehaviorSelection };

/** One bounded automatic cycle for an explicitly supplied fixed selection. No scheduling or private data reads. */
export async function runBehaviorLearningCycle(pool: PublisherPool, selection: unknown, expectedRevision: number) {
  const lifecycle = createBehaviorLifecycle(pool);
  const proposal = await lifecycle.propose(selection, expectedRevision);
  const evaluation = await lifecycle.evaluate(proposal.candidateId);
  if (!evaluation.passed) return { status: "rejected" as const, candidateId: proposal.candidateId, evaluation };
  const publication = await lifecycle.publish(proposal.candidateId, expectedRevision);
  return { status: "published" as const, candidateId: proposal.candidateId, evaluation, ...publication };
}

/** Caller is an existing authorized scheduler. No cron definitions, private reads, models or retries. */
export async function runScheduledBehaviorLearning(pool: PublisherPool, input: { enabled: boolean; selection: unknown; expectedRevision: number }) {
  if (input.enabled !== true) return { status: "disabled" as const };
  // Validate before admission: malformed input cannot consume a day or introduce free text.
  const selection = parseBehaviorSelection(input.selection); revision(input.expectedRevision);
  const lifecycle = createBehaviorLifecycle(pool);
  const runId = await lifecycle.admitScheduledRun();
  if (!runId) return { status: "already_claimed" as const };
  try {
    const result = await runBehaviorLearningCycle(pool, selection, input.expectedRevision);
    await lifecycle.finishScheduledRun(runId, result.status);
    return { runId, ...result };
  } catch {
    await lifecycle.finishScheduledRun(runId, "failed");
    // No raw SQL/provider exception, private evidence or credential in a monitor result.
    return { runId, status: "failed" as const };
  }
}
