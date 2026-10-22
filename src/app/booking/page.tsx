import { redirect } from "next/navigation";
import { BookingWorkspace } from "@/components/booking-workspace";
import { getCrmRequestLanguage } from "@/lib/auth/request-language";
import { getWorkspaceEnabledModules, hasProductCapability } from "@/lib/product-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Booking | Novalure CRM", robots: { index: false, follow: false } };

export default async function BookingPage() {
  const { session, language, preference } = await getCrmRequestLanguage();
  if (!session) redirect("/login");
  const enabled = getWorkspaceEnabledModules({ setupState: session.workspaceSetupState, workspaceId: session.workspaceId, workspaceName: session.workspaceName }).calendar;
  const canManage = enabled && hasProductCapability(session.productRole, "calendar:manage") && session.permissions.includes("crm:write");
  return <div lang={language} data-crm-language-preference={preference}><BookingWorkspace language={language} employeeName={session.name} workspaceName={session.workspaceName} canManage={canManage} /></div>;
}
