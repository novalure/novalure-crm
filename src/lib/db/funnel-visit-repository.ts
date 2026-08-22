import "server-only";

import { hasDatabaseUrl, queryOne } from "@/lib/db/client";
import { evaluateLaunchScope } from "@/lib/launch-scope";

type FunnelVisitMutationRow = {
  accepted: boolean;
  counted: boolean;
  schemaReady: boolean;
};

export type PublicFunnelVisitResult =
  | { accepted: false; counted: false; reason: "publication_stale" }
  | { accepted: true; counted: boolean };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[a-f0-9]{64}$/u;

/**
 * Records one public page visit for one exact Funnel publication.
 *
 * The analytics insert is the source event. A tenant-qualified identity row is
 * the idempotency gate; `funnels.visits` and the conversion denominator advance
 * only when both rows are inserted. The selected Funnel row is locked so a
 * concurrent publication rotation cannot split the revision check from the
 * counter mutation.
 */
export async function recordPublicFunnelVisit(input: {
  funnelId: string;
  publicationRevision: number;
  visitIdHash: string;
  workspaceId: string;
}): Promise<PublicFunnelVisitResult> {
  if (!evaluateLaunchScope("publicFunnelVisit").allowed) {
    throw new Error("Public Funnel visit tracking is launch-off");
  }
  if (!hasDatabaseUrl()) throw new Error("Funnel database is not configured");
  if (
    !uuidPattern.test(input.workspaceId) ||
    !uuidPattern.test(input.funnelId) ||
    !Number.isSafeInteger(input.publicationRevision) ||
    input.publicationRevision < 0 ||
    !sha256Pattern.test(input.visitIdHash)
  ) {
    throw new Error("Invalid public Funnel visit scope");
  }

  const row = await queryOne<FunnelVisitMutationRow>(
    `
      with expired_visit_identities as materialized (
        select id
        from public_funnel_visit_events
        where expires_at <= now()
        order by expires_at, id
        limit 64
        for update skip locked
      ), pruned_visit_identities as (
        delete from public_funnel_visit_events expired
        using expired_visit_identities targets
        where expired.id = targets.id
        returning expired.id
      ), schema_guard as materialized (
        select exists (
          select 1
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace
            on namespace.oid = relation.relnamespace
          join pg_catalog.pg_constraint relation_constraint
            on relation_constraint.conrelid = relation.oid
          where namespace.nspname = 'public'
            and relation.relname = 'public_funnel_visit_events'
            and relation.relkind = 'r'
            and relation_constraint.conname in (
              'public_funnel_visit_events_scope_key',
              'public_funnel_visit_events_funnel_fk'
            )
          group by relation.oid
          having bool_or(
            relation_constraint.conname = 'public_funnel_visit_events_scope_key'
            and relation_constraint.contype = 'u'
            and relation_constraint.convalidated
          )
          and bool_or(
            relation_constraint.conname = 'public_funnel_visit_events_funnel_fk'
            and relation_constraint.contype = 'f'
            and relation_constraint.convalidated
          )
        ) as ready
      ), selected_funnel as materialized (
        select
          funnel.id,
          funnel.workspace_id as "workspaceId",
          funnel.project_id as "projectId"
        from funnels funnel
        cross join schema_guard schema
        where funnel.workspace_id = $1::uuid
          and funnel.id = $2::uuid
          and funnel.status = 'aktiv'
          and schema.ready
          and coalesce(
            case
              when jsonb_typeof(funnel.tracking->'publicationRevision') = 'number'
                then (funnel.tracking->>'publicationRevision')::numeric
              else null
            end,
            0
          ) = $3::numeric
          and (
            (
              funnel.blueprint->>'schemaVersion' = '1'
              and funnel.blueprint->>'status' = 'aktiv'
              and jsonb_typeof(funnel.blueprint->'pages') = 'array'
            )
            or (
              funnel.blueprint->'blueprint'->>'schemaVersion' = '1'
              and funnel.blueprint->'blueprint'->>'status' = 'aktiv'
              and jsonb_typeof(funnel.blueprint->'blueprint'->'pages') = 'array'
            )
          )
        for update of funnel
      ), inserted_visit_identity as (
        insert into public_funnel_visit_events (
          workspace_id,
          funnel_id,
          publication_revision,
          visit_id_hash
        )
        select
          selected."workspaceId",
          selected.id,
          $3::bigint,
          $4::text
        from selected_funnel selected
        on conflict (workspace_id, funnel_id, publication_revision, visit_id_hash)
          do nothing
        returning id
      ), inserted_visit_event as (
        insert into analytics_events (
          workspace_id,
          project_id,
          entity_id,
          entity_type,
          user_id,
          contact_id,
          lead_id,
          deal_id,
          funnel_id,
          event_type,
          module,
          source,
          channel,
          value_cents,
          occurred_at,
          metadata
        )
        select
          selected."workspaceId",
          selected."projectId",
          selected.id,
          'funnel',
          null,
          null,
          null,
          null,
          selected.id,
          'funnel_visit',
          'funnel',
          'public_funnel',
          'website',
          0,
          now(),
          jsonb_build_object(
            'analyticsVersion', 1,
            'entityId', selected.id,
            'entityType', 'funnel',
            'publicationRevision', $3::bigint
          )
        from selected_funnel selected
        cross join inserted_visit_identity visit_identity
        returning id
      ), updated_funnel as (
        update funnels funnel
        set
          visits = funnel.visits + 1,
          conversion_rate = round(
            (funnel.leads_count::numeric / (funnel.visits + 1)::numeric) * 100,
            2
          ),
          updated_at = now()
        from selected_funnel selected
        where funnel.workspace_id = selected."workspaceId"
          and funnel.id = selected.id
          and exists (select 1 from inserted_visit_event)
        returning funnel.id
      )
      select
        (select ready from schema_guard) as "schemaReady",
        exists (select 1 from selected_funnel) as accepted,
        exists (select 1 from updated_funnel) as counted,
        (select count(*) from pruned_visit_identities) as "prunedVisitIdentityCount"
    `,
    [input.workspaceId, input.funnelId, input.publicationRevision, input.visitIdHash],
  );

  if (!row?.schemaReady) {
    throw new Error("Public Funnel visit schema is not ready");
  }
  if (!row?.accepted) {
    return { accepted: false, counted: false, reason: "publication_stale" };
  }
  return { accepted: true, counted: row.counted === true };
}
