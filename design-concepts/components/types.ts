import type { ReactNode } from "react";

export type ViewId = "dashboard" | "customers" | "studio" | "assistants" | "knowledge";
export type VariantId = "a" | "b" | "c";
export type TenantId = "atelier" | "haven";
export type ShellProps = {
  children: ReactNode;
  view: ViewId;
  tenant: TenantId;
  portal: boolean;
  onNavigate: (view: ViewId) => void;
  onTenantChange: (tenant: TenantId) => void;
  onAction: (action: string) => void;
};
export type DashboardProps = Pick<ShellProps, "onNavigate" | "onAction" | "tenant">;
export const NAV_ITEMS: { id: ViewId; label: string; icon: string }[] = [
  { id: "dashboard", label: "Übersicht", icon: "grid" },
  { id: "customers", label: "Kunden", icon: "users" },
  { id: "studio", label: "Novalure Studio", icon: "layers" },
  { id: "assistants", label: "KI-Assistenten", icon: "sparkles" },
  { id: "knowledge", label: "Wissen", icon: "book" },
];
export const TENANTS = {
  atelier: { name: "Atelier Nord", short: "AN", field: "Design & Architektur", domain: "atelier-nord.example", project: "Atelier Website", contact: "Mara Sommer", color: "#6d7b66" },
  haven: { name: "Haven Estates", short: "HE", field: "Immobilien & Wohnen", domain: "haven-estates.example", project: "Parkside Residences", contact: "Leo Berger", color: "#6472a6" },
} as const;
