import "server-only";
import { withTenantTransaction, type TenantScope, type TenantTransaction, type TenantTransactionOptions } from "@/lib/db/tenant-client";
import { BookingError, type BookingProviderName } from "./types";
import { assertBookingRuntime, bookingOAuthReadiness, bookingProductionConfiguration } from "./runtime";

export type BookingActivationCapability = "booking" | "messages";
export type BookingActivationBinding = {
  provider: BookingProviderName; connectionId: string; accountId: string | null; calendarId: string;
};
export type BookingActivation = BookingActivationBinding & {
  workspaceId: string; userId: string; accountId: string;
  activationId: string; activatedAt: string; audience: "internal" | "external_customers";
};
type ActivationOptions = TenantTransactionOptions & {
  tx?: TenantTransaction; env?: NodeJS.ProcessEnv; capability?: BookingActivationCapability;
};
type ActivationRow = Omit<BookingActivation, "activatedAt"> & { activatedAt: string | Date };

function checkedActivation(row: ActivationRow, env: NodeJS.ProcessEnv): BookingActivation {
  const config = bookingProductionConfiguration(env)!;
  const readiness = bookingOAuthReadiness(row.provider, env);
  if (!readiness.configured || readiness.authorityCompatible !== true ||
    row.audience === "external_customers" && !readiness.externalCustomerReady)
    throw new BookingError("BOOKING_OAUTH_CONFIGURATION_REQUIRED", 503);
  // Both cutoffs apply; enabling a later release cannot drain an earlier QA queue.
  return { ...row, activatedAt: new Date(Math.max(new Date(row.activatedAt).getTime(), Date.parse(config.activatedAt))).toISOString() };
}

/** Revalidates the exact live resource. Token rotation is deliberately not an activation identity. */
export async function assertBookingActivation(scope: TenantScope, binding: BookingActivationBinding, options: ActivationOptions = {}): Promise<BookingActivation | null> {
  const env = options.env ?? process.env;
  if (assertBookingRuntime(env) === "preview") return null;
  if (!binding.accountId) throw new BookingError("BOOKING_PRODUCTION_ACTIVATION_REQUIRED", 403);
  const config = bookingProductionConfiguration(env)!;
  const read = async (tx: TenantTransaction) => {
    const row = await tx.queryOne<ActivationRow>(`select * from booking_get_production_activation($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8,$9)`,
      [config.activationId, scope.workspaceId, scope.actorId, binding.provider, binding.connectionId, binding.accountId,
        binding.calendarId, config.origin, options.capability ?? "booking"]);
    if (!row) throw new BookingError("BOOKING_PRODUCTION_ACTIVATION_REQUIRED", 403);
    return checkedActivation(row, env);
  };
  return options.tx ? read(options.tx) : withTenantTransaction(scope, read, options);
}

/** Server scheduler only: a bounded definer function exposes identities, never provider credentials. */
export async function listProductionBookingBindings(options: TenantTransactionOptions & { env?: NodeJS.ProcessEnv; capability?: BookingActivationCapability; limit?: number } = {}): Promise<BookingActivation[]> {
  const env = options.env ?? process.env;
  if (assertBookingRuntime(env) !== "production") return [];
  const config = bookingProductionConfiguration(env)!;
  const limit = options.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new BookingError("INVALID_ACTIVATION_LIMIT");
  // No membership is impersonated. Only the explicitly granted bounded registry function can read here.
  const registryScope = { workspaceId: "00000000-0000-4000-8000-000000000000", actorId: "00000000-0000-4000-8000-000000000000" };
  return withTenantTransaction(registryScope, async tx => {
    const rows = await tx.query<ActivationRow>(`select * from booking_list_production_activations($1::uuid,$2,$3,$4)`,
      [config.activationId, config.origin, options.capability ?? "booking", limit]);
    return rows.flatMap(row => {
      try { return [checkedActivation(row, env)]; } catch { return []; }
    });
  }, options);
}
