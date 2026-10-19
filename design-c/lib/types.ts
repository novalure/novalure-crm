export type DesignView =
  | "dashboard"
  | "customers"
  | "tenants"
  | "studio"
  | "properties"
  | "assistants"
  | "knowledge"
  | "activity"
  | "components"
  | "settings";

/** Presentation-only context; never an authorization or tenant-selection contract. */
export type DemoWorkspace = {
  id: string;
  name: string;
  kind: "studio" | "developer" | "broker" | "company";
  project: string;
};

export type PreviewAction = (title: string) => void;
export type DomainViewProps = {
  context: DemoWorkspace;
  portal: boolean;
  onPreviewAction: PreviewAction;
};
