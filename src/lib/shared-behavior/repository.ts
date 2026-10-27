import "server-only";

import type { AppSession } from "../auth/session";
import { withCrmRead } from "../crm-command";
import type { TenantTransactionOptions } from "../db/tenant-client";
import { compileSharedBehavior, parseBehaviorRelease, SharedBehaviorError, suggestBehaviorRules } from "./catalog";
import { insertPrivateSignal, parsePrivateSignal } from "./private-signal-insert";

/** Internal instrumentation boundary. No HTTP endpoint is installed by this package. */
export async function recordPrivateLearningSignal(session: AppSession, value: unknown, options: TenantTransactionOptions = {}) {
  const input = parsePrivateSignal(value);
  return withCrmRead(session, async (tx, member) => {
    if (!member.permissions.includes("crm:write")) throw new SharedBehaviorError("LEARNING_WRITE_FORBIDDEN");
    return insertPrivateSignal(tx, member.workspaceId, member.userId, input);
  }, options);
}

/** Evidence stays private even from another owner in the same workspace. */
export async function suggestPrivateBehaviorImprovements(session: AppSession, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, member) => {
    const counts = await tx.query<{ issue: string; failures: number }>(`
      select issue,least(count(*),1000000)::integer as failures from behavior_learning_signals
      where workspace_id=$1::uuid and actor_id=$2::uuid and outcome='fail'
        and created_at >= now()-interval '30 days'
      group by issue order by issue`, [member.workspaceId, member.userId]);
    // No counts, event IDs, actor IDs or tenant IDs in a cross-scope candidate.
    return suggestBehaviorRules(counts);
  }, options);
}

/** Reads only the published, immutable selection; no candidate or evidence access. */
export async function loadSharedBehavior(session: AppSession, target: unknown, options: TenantTransactionOptions = {}) {
  // Validate before any database work, including when no release is published.
  compileSharedBehavior(null, target);
  return withCrmRead(session, async tx => {
    const row = await tx.queryOne<{ version: number; ruleIds: string[]; targets: string[] }>(`
      select r.version,r.rule_ids as "ruleIds",r.targets
      from behavior_release_head h join behavior_releases r on r.version=h.version where h.singleton=true`);
    const release = row ? parseBehaviorRelease({ contractVersion: "shared-behavior-v1", version: row.version, selection: { ruleIds: row.ruleIds, targets: row.targets } }) : null;
    return compileSharedBehavior(release, target);
  }, options);
}
