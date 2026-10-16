import { queryOne, resolveDatabaseUrl } from "@/lib/db/client";
import { websiteSalesActorId, websiteSalesWorkspaceId } from "@/lib/website-sales-ingestion";

export type StudioQaTarget = {
  projectId: string;
  branchId: string;
  databaseName: string;
  databaseRole: string;
};

export function isStudioIsolatedLocalTest(env: NodeJS.ProcessEnv = process.env) {
  return env.NODE_ENV === "test" && env.CRM_LOCAL_TEST_DATABASE === "1" &&
    env.VERCEL === undefined && env.VERCEL_ENV === undefined && env.VERCEL_URL === undefined;
}

export function studioQaRecipients(env: NodeJS.ProcessEnv = process.env): string[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(env.STUDIO_BOOKING_QA_RECIPIENTS_JSON ?? ""); }
  catch { return null; }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20 ||
      parsed.some((item) => typeof item !== "string" || item !== item.trim().toLowerCase() ||
        item.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)) ||
      new Set(parsed).size !== parsed.length) return null;
  return parsed;
}

export function studioQaTargetConfiguration(env: NodeJS.ProcessEnv = process.env): StudioQaTarget | null {
  if (env.VERCEL !== "1" || env.VERCEL_ENV !== "preview" ||
      !env.STUDIO_BOOKING_QA_CRM_PROJECT_ID?.trim() ||
      env.VERCEL_PROJECT_ID !== env.STUDIO_BOOKING_QA_CRM_PROJECT_ID) return null;
  const databaseUrl = resolveDatabaseUrl(env);
  const qaDatabaseUrl = env.NOVALURE_QA_DATABASE_URL?.trim().replace(/^['"]|['"]$/g, "");
  const projectId = env.NOVALURE_QA_PROJECT_ID?.trim();
  const branchId = env.NOVALURE_QA_BRANCH_ID?.trim();
  const databaseName = env.NOVALURE_QA_DATABASE_NAME?.trim();
  const databaseRole = env.NOVALURE_QA_DATABASE_ROLE?.trim();
  const host = env.NOVALURE_QA_DATABASE_HOST?.trim().toLowerCase();
  const productionHost = env.NOVALURE_PRODUCTION_DATABASE_HOST?.trim().toLowerCase();
  if (!env.DATABASE_URL?.trim() || !databaseUrl || !qaDatabaseUrl || databaseUrl !== qaDatabaseUrl || !projectId || !branchId ||
      !databaseName || !databaseRole || !host || !productionHost || host === productionHost) return null;
  try {
    const url = new URL(databaseUrl);
    if (!/^postgres(?:ql)?:$/.test(url.protocol) || url.hostname.toLowerCase() !== host ||
        !host.includes("-pooler.") || decodeURIComponent(url.pathname.slice(1)) !== databaseName ||
        decodeURIComponent(url.username) !== databaseRole) return null;
  } catch { return null; }
  return { projectId, branchId, databaseName, databaseRole };
}

export async function studioQaDatabaseMatches(env: NodeJS.ProcessEnv = process.env) {
  if (isStudioIsolatedLocalTest(env)) return true;
  const expected = studioQaTargetConfiguration(env);
  if (!expected) return false;
  try {
    const actual = await queryOne<{ projectId: string | null; branchId: string | null;
      databaseName: string; databaseRole: string; bookingTablePresent: boolean; studioActorPresent: boolean }>(
      `select current_setting('neon.project_id', true) as "projectId",
         current_setting('neon.branch_id', true) as "branchId",
         current_database() as "databaseName", current_user as "databaseRole",
         (to_regclass('public.studio_sales_bookings') is not null) as "bookingTablePresent",
         exists (select 1 from public.workspace_users where id=$1::uuid and workspace_id=$2::uuid
           and status='active' and role='agent' and product_role='novalure_operator') as "studioActorPresent"`,
      [websiteSalesActorId, websiteSalesWorkspaceId],
    );
    return actual?.projectId === expected.projectId && actual.branchId === expected.branchId &&
      actual.databaseName === expected.databaseName && actual.databaseRole === expected.databaseRole &&
      actual.bookingTablePresent === true && actual.studioActorPresent === true;
  } catch { return false; }
}
