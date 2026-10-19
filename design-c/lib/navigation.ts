import type { DesignView } from "./types";

export type CommandNavItem = {
  id: string;
  label: string;
  portalLabel?: string;
  icon: string;
  view?: DesignView;
  internalOnly?: boolean;
  capability?: string;
};

/** UI capability projection only. Authorization must remain server-enforced. */
export const COMMAND_NAVIGATION: CommandNavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: "grid", view: "dashboard" },
  {
    id: "customers",
    label: "Kunden & Mandanten",
    icon: "users",
    view: "customers",
    internalOnly: true,
    capability: "customers",
  },
  { id: "sales", label: "Vertrieb", icon: "chart", internalOnly: true },
  {
    id: "studio",
    label: "Websites & Studio",
    portalLabel: "Meine Projekte & Websites",
    icon: "globe",
    view: "studio",
    capability: "studio",
  },
  {
    id: "properties",
    label: "Immobilien",
    portalLabel: "Meine Immobilien",
    icon: "home",
    view: "properties",
    capability: "properties",
  },
  {
    id: "assistants",
    label: "KI-Assistenten",
    portalLabel: "Meine KI-Assistenten",
    icon: "chat",
    view: "assistants",
    capability: "assistants",
  },
  {
    id: "knowledge",
    label: "Knowledge Center",
    portalLabel: "Wissensverwaltung",
    icon: "book",
    view: "knowledge",
    capability: "knowledge",
  },
  {
    id: "marketing",
    label: "Marketing",
    icon: "megaphone",
    internalOnly: true,
  },
  {
    id: "organization",
    label: "Organisation",
    icon: "layers",
    internalOnly: true,
  },
  { id: "finance", label: "Finanzen", icon: "wallet", internalOnly: true },
  {
    id: "activity",
    label: "Evelyn Activity Center",
    portalLabel: "Meine Aktivitäten",
    icon: "activity",
    view: "activity",
  },
  {
    id: "settings",
    label: "Einstellungen",
    icon: "settings",
    view: "settings",
  },
];

export function visibleNavigation(
  portal: boolean,
  capabilities: ReadonlySet<string>,
) {
  return COMMAND_NAVIGATION.filter(
    (item) =>
      !(portal && item.internalOnly) &&
      (!item.capability || capabilities.has(item.capability)),
  );
}
