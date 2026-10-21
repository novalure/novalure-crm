import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { BookingWorkspace } from "@/components/booking-workspace";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { languageCookieName, languageRequestHeaderName, resolveLanguage } from "@/lib/language-runtime";
import { getWorkspaceEnabledModules, hasProductCapability } from "@/lib/product-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Booking | Novalure CRM", robots: { index: false, follow: false } };

export default async function BookingPage() {
  const requestHeaders = await headers();
  const session = await getSessionFromHeaders(requestHeaders);
  if (!session) redirect("/login");
  const language = resolveLanguage(requestHeaders.get(languageRequestHeaderName) ?? (await cookies()).get(languageCookieName)?.value);
  const enabled = getWorkspaceEnabledModules({ setupState: session.workspaceSetupState, workspaceId: session.workspaceId, workspaceName: session.workspaceName }).calendar;
  const canManage = enabled && hasProductCapability(session.productRole, "calendar:manage") && session.permissions.includes("crm:write");
  return <BookingWorkspace language={language} employeeName={session.name} workspaceName={session.workspaceName} canManage={canManage} canEditCompanyDefaults={hasProductCapability(session.productRole, "workspace:admin")} />;
}
