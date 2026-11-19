export const projectWizardTypeKeys = ["real_estate_project", "buyer_pipeline", "seller_pipeline", "investment_mandate", "b2b_workspace"] as const;
export type ProjectWizardTypeKey = typeof projectWizardTypeKeys[number];

/** Create-only intent. Private text must never be copied to Project/Core/receipts. */
export type ProjectWizardInput = {
  schemaVersion: 1;
  expectedActorId: string;
  typeKey: ProjectWizardTypeKey;
  responsibleUserId: string | null;
  funnelReferenceId: string | null;
  pipelineTemplateKey: string;
  privateNotes: string;
};

/** Safe receipt metadata; names and private text are resolved by the internal read path. */
export type ProjectWizardReceipt = Omit<ProjectWizardInput, "privateNotes" | "expectedActorId">;

export type ProjectWizardOptions = {
  workspaceId: string;
  actorId: string;
  projectTypes: ProjectWizardTypeKey[];
  responsibleUsers: Array<{ id: string; name: string }>;
  funnelReferences: Array<{ id: string; name: string }>;
  pipelineTemplates: Array<{ key: string; name: string }>;
};

export type ProjectWizardDetails = Omit<ProjectWizardReceipt, "typeKey" | "pipelineTemplateKey"> & {
  legacy: boolean;
  typeKey: ProjectWizardTypeKey | null;
  pipelineTemplateKey: string | null;
  projectId: string;
  privateNotes: string;
  responsibleName: string | null;
  funnelReferenceTitle: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
};
