import { hasProductCapability, type ProductRole } from "@/lib/product-model";

/** Presets organize work; they must not hide the existing customer self-service. */
type SelfServiceEntry = "dashboard" | "projects" | "knowledge" | "bots" | "settings";

export function getCrmSelfServiceEntries<T extends string>(entries: readonly T[], role: ProductRole): Array<T | SelfServiceEntry> {
  if (hasProductCapability(role, "novalure:internal")) return [...entries];
  const result = new Set<T | SelfServiceEntry>([...entries, "dashboard", "projects", "knowledge"]);
  if (hasProductCapability(role, "bots:publish")) result.add("bots");
  else result.delete("bots");
  if (hasProductCapability(role, "settings:manage")) result.add("settings");
  else result.delete("settings");
  // The existing workspace-module filter and server authorization still apply.
  return [...result];
}
