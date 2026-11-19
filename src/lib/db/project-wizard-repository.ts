import 'server-only';
import type { AppSession } from '@/lib/auth/session';
import { assertCrmFields, assertCrmUuid, assertProjectGrant, CrmCommandError, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from '@/lib/crm-command';
import { getDefaultPipelineTemplates } from '@/lib/db/pipeline-default-repositories';
import { hasProductCapability, isWorkspaceCustomerType, isWorkspaceOperatingModel } from '@/lib/product-model';
import { projectWizardTypeKeys, type ProjectWizardDetails, type ProjectWizardInput, type ProjectWizardOptions, type ProjectWizardReceipt } from '@/lib/project-wizard';

type WizardContext = { customerType?: unknown; operatingModel?: unknown };
type SettingsRow = { schemaVersion: 1; typeKey: ProjectWizardInput['typeKey']; responsibleUserId: string | null; funnelReferenceId: string | null; pipelineTemplateKey: string };
const receiptColumns = `schema_version as "schemaVersion",type_key as "typeKey",responsible_user_id as "responsibleUserId",funnel_reference_id as "funnelReferenceId",pipeline_template_key as "pipelineTemplateKey"`;

function contextFor(session: AppSession, input: WizardContext) {
  if (input.customerType != null && !isWorkspaceCustomerType(input.customerType)) throw new CrmCommandError('INVALID_CUSTOMER_TYPE', 'Kundentyp prüfen.');
  if (input.operatingModel != null && !isWorkspaceOperatingModel(input.operatingModel)) throw new CrmCommandError('INVALID_OPERATING_MODEL', 'Betriebsmodell prüfen.');
  return { customerType: input.customerType ?? session.workspaceCustomerType ?? null, operatingModel: input.operatingModel ?? session.workspaceOperatingModel ?? null };
}

function parseWizard(value: unknown): ProjectWizardInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CrmCommandError('INVALID_PROJECT_WIZARD', 'Projektangaben prüfen.');
  const input = value as Record<string, unknown>;
  assertCrmFields(input, ['schemaVersion', 'expectedActorId', 'typeKey', 'responsibleUserId', 'funnelReferenceId', 'pipelineTemplateKey', 'privateNotes']);
  if (input.schemaVersion !== 1 || !projectWizardTypeKeys.includes(input.typeKey as ProjectWizardInput['typeKey']) || typeof input.pipelineTemplateKey !== 'string' || typeof input.privateNotes !== 'string' || input.privateNotes.length > 4000 || input.privateNotes.includes('\0')) throw new CrmCommandError('INVALID_PROJECT_WIZARD', 'Projekttyp, Pipeline und private Notiz prüfen (höchstens 4000 Zeichen).');
  return {
    schemaVersion: 1,
    expectedActorId: assertCrmUuid(input.expectedActorId, 'expectedActorId'),
    typeKey: input.typeKey as ProjectWizardInput['typeKey'],
    responsibleUserId: input.responsibleUserId === null ? null : assertCrmUuid(input.responsibleUserId, 'responsibleUserId'),
    funnelReferenceId: input.funnelReferenceId === null ? null : assertCrmUuid(input.funnelReferenceId, 'funnelReferenceId'),
    pipelineTemplateKey: input.pipelineTemplateKey,
    privateNotes: input.privateNotes,
  };
}

/** Validate all requested references before the new project/domain INSERT. */
export async function validateProjectWizardCreate(session: AppSession, value: unknown, context: WizardContext): Promise<ProjectWizardInput> {
  const wizard = parseWizard(value);
  return withCrmRead(session, async (tx, fresh) => {
    if (wizard.expectedActorId !== fresh.userId) throw new CrmCommandError('PROJECT_WIZARD_ACTOR_CHANGED', 'Die Projektanlage gehört zu einer anderen aktiven Mitgliedschaft. Bitte neu öffnen.', 403);
    if (!fresh.permissions.includes('crm:write') || !hasProductCapability(fresh.productRole, 'settings:manage')) throw new CrmCommandError('FORBIDDEN', 'Projektanlage ist nicht freigegeben.', 403);
    const manager = await tx.queryOne<{ allowed: boolean }>('select crm_workspace_manager($1::uuid) as allowed', [fresh.workspaceId]);
    if (!manager?.allowed) throw new CrmCommandError('FORBIDDEN', 'Projektanlage erfordert bestehende Verwaltungsrechte.', 403);
    const resolved = contextFor(fresh, context);
    if (!getDefaultPipelineTemplates(resolved.customerType, resolved.operatingModel).some(template => template.key === wizard.pipelineTemplateKey)) throw new CrmCommandError('INVALID_PIPELINE_TEMPLATE', 'Die Pipeline passt nicht zum aktuellen Kundentyp und Betriebsmodell.');
    if (wizard.responsibleUserId) {
      const user = await tx.queryOne<{ allowed: boolean }>('select crm_project_wizard_lock_responsible($1::uuid,$2::uuid) as allowed', [fresh.workspaceId, wizard.responsibleUserId]);
      if (!user?.allowed) throw new CrmCommandError('PROJECT_RESPONSIBLE_FORBIDDEN', 'Aktiven Verantwortlichen mit bestehenden workspaceweiten Projektrechten wählen.', 403);
    }
    if (wizard.funnelReferenceId) {
      const funnel = await tx.queryOne<{ projectId: string | null }>('select f.project_id as "projectId" from funnels f join projects p on p.workspace_id=f.workspace_id and p.id=f.project_id where f.workspace_id=$1::uuid and f.id=$2::uuid', [fresh.workspaceId, wizard.funnelReferenceId]);
      if (!funnel?.projectId) throw new CrmCommandError('FUNNEL_REFERENCE_FORBIDDEN', 'Die interne Funnel-Referenz ist nicht lesbar.', 403);
      await assertProjectGrant(tx, fresh, funnel.projectId);
    }
    return wizard;
  });
}

/** Called only inside the existing project command transaction. No private text is returned. */
export async function persistProjectWizard(tx: TenantTransaction, session: AppSession, projectId: string, wizard: ProjectWizardInput): Promise<ProjectWizardReceipt> {
  const row = await tx.queryOne<SettingsRow>(`insert into project_wizard_settings(workspace_id,project_id,schema_version,type_key,responsible_user_id,funnel_reference_id,pipeline_template_key,created_by) values($1::uuid,$2::uuid,1,$3,$4::uuid,$5::uuid,$6,$7::uuid) returning ${receiptColumns}`, [session.workspaceId, projectId, wizard.typeKey, wizard.responsibleUserId, wizard.funnelReferenceId, wizard.pipelineTemplateKey, session.userId]);
  if (!row) throw new CrmCommandError('PROJECT_WIZARD_UNCONFIRMED', 'Projektkonfiguration nicht bestätigt.', 503);
  await tx.execute('insert into project_wizard_private_notes(workspace_id,project_id,actor_id,private_notes) values($1::uuid,$2::uuid,$3::uuid,$4)', [session.workspaceId, projectId, session.userId, wizard.privateNotes]);
  return row;
}

export async function validateProjectDefaultPipeline(session: AppSession, projectId: string, value: unknown): Promise<string | null> {
  if (value === null || value === '') return null;
  const id = assertCrmUuid(value, 'defaultPipelineId');
  return withCrmRead(session, async tx => {
    const pipeline = await tx.queryOne<{ id: string }>('select id from crm_pipelines where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid for share', [session.workspaceId, projectId, id]);
    if (!pipeline) throw new CrmCommandError('PROJECT_PIPELINE_FORBIDDEN', 'Die Standardpipeline muss zu genau diesem Projekt gehören.', 403);
    return pipeline.id;
  });
}

export async function getProjectWizardOptions(session: AppSession, input: WizardContext = {}, options: TenantTransactionOptions = {}): Promise<ProjectWizardOptions> {
  return withCrmRead(session, async (tx, fresh) => {
    const context = contextFor(fresh, input);
    const users = await tx.query<{ id: string; name: string }>('select id,name from workspace_users where workspace_id=$1::uuid and crm_project_wizard_responsible_allowed(workspace_id,id) order by name,id', [fresh.workspaceId]);
    const funnels = await tx.query<{ id: string; name: string }>('select f.id,f.name from funnels f join projects p on p.workspace_id=f.workspace_id and p.id=f.project_id where f.workspace_id=$1::uuid and crm_project_access(f.workspace_id,f.project_id,false) order by f.name,f.id', [fresh.workspaceId]);
    return { workspaceId: fresh.workspaceId, actorId: fresh.userId, projectTypes: [...projectWizardTypeKeys], responsibleUsers: users, funnelReferences: funnels, pipelineTemplates: getDefaultPipelineTemplates(context.customerType, context.operatingModel).map(({ key, name }) => ({ key, name })) };
  }, options);
}

export async function getProjectWizardDetails(session: AppSession, projectId: string, options: TenantTransactionOptions = {}): Promise<ProjectWizardDetails> {
  assertCrmUuid(projectId, 'projectId');
  return withCrmRead(session, async (tx, fresh) => {
    await assertProjectGrant(tx, fresh, projectId);
    const settings = await tx.queryOne<SettingsRow>(`select ${receiptColumns} from project_wizard_settings where workspace_id=$1::uuid and project_id=$2::uuid`, [fresh.workspaceId, projectId]);
    const project = await tx.queryOne<{ pipelineId: string | null; pipelineName: string | null }>('select cp.id as "pipelineId",cp.name as "pipelineName" from projects p left join crm_pipelines cp on cp.workspace_id=p.workspace_id and cp.project_id=p.id and cp.id=p.default_pipeline_id where p.workspace_id=$1::uuid and p.id=$2::uuid', [fresh.workspaceId, projectId]);
    let responsibleName: string | null = null, funnelReferenceTitle: string | null = null;
    if (settings?.responsibleUserId) responsibleName = (await tx.queryOne<{ name: string }>('select name from workspace_users where workspace_id=$1::uuid and id=$2::uuid and crm_project_wizard_responsible_allowed(workspace_id,id)', [fresh.workspaceId, settings.responsibleUserId]))?.name ?? null;
    if (settings?.funnelReferenceId) funnelReferenceTitle = (await tx.queryOne<{ name: string }>('select f.name from funnels f join projects p on p.workspace_id=f.workspace_id and p.id=f.project_id where f.workspace_id=$1::uuid and f.id=$2::uuid and crm_project_access(f.workspace_id,f.project_id,false)', [fresh.workspaceId, settings.funnelReferenceId]))?.name ?? null;
    const note = await tx.queryOne<{ text: string }>('select private_notes as text from project_wizard_private_notes where workspace_id=$1::uuid and project_id=$2::uuid and actor_id=$3::uuid', [fresh.workspaceId, projectId, fresh.userId]);
    return { schemaVersion: 1, legacy: !settings, typeKey: settings?.typeKey ?? null, responsibleUserId: settings?.responsibleUserId ?? null, funnelReferenceId: settings?.funnelReferenceId ?? null, pipelineTemplateKey: settings?.pipelineTemplateKey ?? null, projectId, privateNotes: note?.text ?? '', responsibleName, funnelReferenceTitle, pipelineId: project?.pipelineId ?? null, pipelineName: project?.pipelineName ?? null };
  }, options);
}
