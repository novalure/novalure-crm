import type { AppSession } from "@/lib/auth/session";
import type { Project } from "@/lib/crm-types";
import { queryOne, queryRows } from "@/lib/db/client";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import type { WorkspaceCustomerType, WorkspaceOperatingModel } from "@/lib/product-model";

type IdRow = { id: string };

type PipelineTemplate = {
  isDefault?: boolean;
  key: string;
  name: string;
  purpose: string;
  stages: Array<{
    category?: string;
    key: string;
    name: string;
    probability?: number;
    slaHours?: number;
  }>;
};

export type DefaultPipelineSetupResult = {
  defaultPipelineId: string | null;
  pipelineIds: string[];
  stageCount: number;
};

type ProjectPipelineSeedRow = {
  customerType: WorkspaceCustomerType | null;
  defaultOperatingModel: WorkspaceOperatingModel | null;
  id: string;
  setupDefaults: Project["setupDefaults"] | null;
};

export async function ensureWorkspaceProjectDefaultPipelines(input: {
  session: AppSession;
}): Promise<DefaultPipelineSetupResult> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { defaultPipelineId: null, pipelineIds: [], stageCount: 0 };
  }

  const projects = await queryRows<ProjectPipelineSeedRow>(
    `
      select
        id,
        customer_type as "customerType",
        default_operating_model as "defaultOperatingModel",
        setup_defaults as "setupDefaults"
      from projects
      where workspace_id = $1
        and not exists (
          select 1
          from crm_pipelines cp
          join crm_pipeline_stages cps on cps.pipeline_id = cp.id
          where cp.workspace_id = projects.workspace_id
            and cp.project_id = projects.id
        )
      order by created_at asc
      limit 200
    `,
    [input.session.workspaceId],
  );

  const result: DefaultPipelineSetupResult = {
    defaultPipelineId: null,
    pipelineIds: [],
    stageCount: 0,
  };

  for (const project of projects) {
    const projectResult = await ensureProjectDefaultPipelines({
      customerType: project.customerType ?? input.session.workspaceCustomerType ?? null,
      operatingModel: project.defaultOperatingModel ?? input.session.workspaceOperatingModel ?? null,
      projectId: project.id,
      session: input.session,
      setupDefaults: project.setupDefaults,
    });

    if (!result.defaultPipelineId) result.defaultPipelineId = projectResult.defaultPipelineId;
    result.pipelineIds.push(...projectResult.pipelineIds);
    result.stageCount += projectResult.stageCount;
  }

  return result;
}

export async function ensureProjectDefaultPipelines(input: {
  customerType?: WorkspaceCustomerType | null;
  operatingModel?: WorkspaceOperatingModel | null;
  projectId: string;
  session: AppSession;
  setupDefaults?: Project["setupDefaults"] | null;
}): Promise<DefaultPipelineSetupResult> {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.projectId)) {
    return { defaultPipelineId: null, pipelineIds: [], stageCount: 0 };
  }

  const templates = getDefaultPipelineTemplates(input.customerType, input.operatingModel);
  const pipelineIds: string[] = [];
  let defaultPipelineId: string | null = null;
  let stageCount = 0;

  for (const [pipelineIndex, template] of templates.entries()) {
    const pipeline = await queryOne<IdRow>(
      `
        insert into crm_pipelines (
          workspace_id,
          project_id,
          customer_type,
          operating_model,
          key,
          name,
          purpose,
          is_default,
          metadata
        )
        values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb)
        on conflict (workspace_id, project_id, key) where project_id is not null
        do update set
          customer_type = excluded.customer_type,
          operating_model = excluded.operating_model,
          name = excluded.name,
          purpose = excluded.purpose,
          is_default = excluded.is_default,
          metadata = crm_pipelines.metadata || excluded.metadata,
          updated_at = now()
        returning id
      `,
      [
        input.session.workspaceId,
        input.projectId,
        input.customerType ?? null,
        input.operatingModel ?? null,
        template.key,
        template.name,
        template.purpose,
        Boolean(template.isDefault ?? pipelineIndex === 0),
        JSON.stringify({
          generatedFrom: "workspace_setup_defaults",
          setupDefaults: input.setupDefaults ?? {},
        }),
      ],
    );

    if (!pipeline?.id) continue;

    pipelineIds.push(pipeline.id);
    if (!defaultPipelineId && (template.isDefault || pipelineIndex === 0)) {
      defaultPipelineId = pipeline.id;
    }

    for (const [stageIndex, stage] of template.stages.entries()) {
      const insertedStage = await queryOne<IdRow>(
        `
          insert into crm_pipeline_stages (
            pipeline_id,
            workspace_id,
            project_id,
            key,
            name,
            position,
            probability,
            category,
            sla_hours,
            metadata
          )
          values ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb)
          on conflict (pipeline_id, key)
          do update set
            name = excluded.name,
            position = excluded.position,
            probability = excluded.probability,
            category = excluded.category,
            sla_hours = excluded.sla_hours,
            metadata = crm_pipeline_stages.metadata || excluded.metadata,
            updated_at = now()
          returning id
        `,
        [
          pipeline.id,
          input.session.workspaceId,
          input.projectId,
          stage.key,
          stage.name,
          stageIndex,
          stage.probability ?? 0,
          stage.category ?? "work",
          stage.slaHours ?? null,
          JSON.stringify({ generatedFrom: template.key }),
        ],
      );

      if (insertedStage?.id) stageCount += 1;
    }
  }

  if (defaultPipelineId) {
    await queryOne<IdRow>(
      `
        update projects
        set default_pipeline_id = coalesce(default_pipeline_id, $3::uuid), updated_at = now()
        where id = $1 and workspace_id = $2
        returning id
      `,
      [input.projectId, input.session.workspaceId, defaultPipelineId],
    );
  }

  await writeAuditLog({
    action: "project.default_pipelines_ensured",
    after: {
      customerType: input.customerType ?? null,
      defaultPipelineId,
      operatingModel: input.operatingModel ?? null,
      pipelineIds,
      stageCount,
    },
    entityId: input.projectId,
    entityType: "project",
    projectId: input.projectId,
    session: input.session,
  });

  return { defaultPipelineId, pipelineIds, stageCount };
}

export function getDefaultPipelineTemplates(
  customerType?: WorkspaceCustomerType | null,
  operatingModel?: WorkspaceOperatingModel | null,
): PipelineTemplate[] {
  if (operatingModel === "managed_by_novalure") {
    return [
      {
        isDefault: true,
        key: "managed_customer_pipeline",
        name: "Servicebetrieb-Pipeline",
        purpose: "managed_service",
        stages: [
          { key: "new", name: "Neu", probability: 5, slaHours: 1 },
          { key: "qualify", name: "Qualifizieren", probability: 20, slaHours: 24 },
          { key: "appointment", name: "Termin vereinbaren", probability: 40 },
          { key: "visit", name: "Besichtigung / Bewertung", probability: 55 },
          { key: "offer", name: "Angebot / Mandat", probability: 70 },
          { key: "closing_review", name: "Abschlussprüfung", probability: 85 },
          { key: "won", name: "Gewonnen", probability: 100, category: "won" },
          { key: "lost", name: "Verloren", probability: 0, category: "lost" },
          { key: "disqualified", name: "Disqualifiziert", probability: 0, category: "disqualified" },
        ],
      },
    ];
  }

  if (customerType === "property_developer") {
    return [
      {
        isDefault: true,
        key: "developer_project_pipeline",
        name: "Projektpipeline",
        purpose: "developer_sales",
        stages: [
          { key: "new", name: "Neu", probability: 5, slaHours: 2 },
          { key: "qualify", name: "Qualifizieren", probability: 20, slaHours: 24 },
          { key: "consultation", name: "Beratung / Besichtigung", probability: 40 },
          { key: "reservation", name: "Reservierung", probability: 65 },
          { key: "contract_review", name: "Vertragsprüfung", probability: 85 },
          { key: "won", name: "Gewonnen", probability: 100, category: "won" },
          { key: "lost", name: "Verloren", probability: 0, category: "lost" },
          { key: "disqualified", name: "Disqualifiziert", probability: 0, category: "disqualified" },
        ],
      },
    ];
  }

  if (customerType === "novalure_internal" || operatingModel === "novalure_internal") {
    return [
      {
        isDefault: true,
        key: "novalure_sales_pipeline",
        name: "Novalure Sales Pipeline",
        purpose: "novalure_internal",
        stages: [
          { key: "request", name: "Anfrage", probability: 5, slaHours: 4 },
          { key: "audit_scheduled", name: "Audit geplant", probability: 25, slaHours: 48 },
          { key: "offer", name: "Angebot", probability: 55 },
          { key: "onboarding", name: "Onboarding", probability: 75 },
          { key: "active", name: "Aktiv", probability: 100, category: "won" },
          { key: "paused_lost", name: "Pausiert / Verloren", probability: 0, category: "lost" },
        ],
      },
    ];
  }

  return [
    {
      isDefault: true,
      key: "broker_seller_pipeline",
      name: "Verkäufer-Pipeline",
      purpose: "broker_seller",
      stages: [
        { key: "new", name: "Neu", probability: 5, slaHours: 2 },
        { key: "qualify", name: "Qualifizieren", probability: 20, slaHours: 24 },
        { key: "appointment", name: "Termin vereinbaren", probability: 40 },
        { key: "valuation_visit", name: "Besichtigung / Bewertung", probability: 55 },
        { key: "offer_mandate", name: "Angebot / Mandat", probability: 70 },
        { key: "closing_review", name: "Abschlussprüfung", probability: 85 },
        { key: "won", name: "Gewonnen", probability: 100, category: "won" },
        { key: "lost", name: "Verloren", probability: 0, category: "lost" },
        { key: "disqualified", name: "Disqualifiziert", probability: 0, category: "disqualified" },
      ],
    },
  ];
}
