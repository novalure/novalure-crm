import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantScope, TenantTransaction } from "./tenant-client";

type ActiveTransaction = Readonly<{ scope: TenantScope; transaction: TenantTransaction }>;
const transactions = new AsyncLocalStorage<ActiveTransaction>();

export function currentTenantTransaction() {
  return transactions.getStore();
}

/** Scope ends with the callback. Never bind a transaction to an ambient request with enterWith. */
export function runWithTenantTransaction<T>(
  scope: TenantScope,
  transaction: TenantTransaction,
  callback: () => Promise<T>,
): Promise<T> {
  const active = transactions.getStore();
  if (active && (active.scope.actorId !== scope.actorId || active.scope.workspaceId !== scope.workspaceId)) {
    throw new Error("Nested tenant transaction cannot change its actor or workspace");
  }
  return transactions.run(Object.freeze({ scope, transaction }), callback);
}
