export type AppRole = "owner" | "admin" | "agent" | "assistant";

export type AppPermission =
  | "crm:read"
  | "crm:write"
  | "funnels:write"
  | "bots:run"
  | "bots:approve"
  | "knowledge:write"
  | "workflows:run"
  | "newsletter:send"
  | "calendar:sync"
  | "settings:manage";

export const rolePermissions: Record<AppRole, AppPermission[]> = {
  owner: [
    "crm:read",
    "crm:write",
    "funnels:write",
    "bots:run",
    "bots:approve",
    "knowledge:write",
    "workflows:run",
    "newsletter:send",
    "calendar:sync",
    "settings:manage",
  ],
  admin: [
    "crm:read",
    "crm:write",
    "funnels:write",
    "bots:run",
    "bots:approve",
    "knowledge:write",
    "workflows:run",
    "newsletter:send",
    "calendar:sync",
  ],
  agent: ["crm:read", "crm:write", "funnels:write", "bots:run", "workflows:run"],
  assistant: ["crm:read", "bots:run"],
};

export function getRolePermissions(role: AppRole) {
  return rolePermissions[role] ?? [];
}

export function isAppRole(value: unknown): value is AppRole {
  return value === "owner" || value === "admin" || value === "agent" || value === "assistant";
}

export function can(role: AppRole, permission: AppPermission) {
  return getRolePermissions(role).includes(permission);
}
