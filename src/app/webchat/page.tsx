import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { WebchatCustomerPortal } from "@/components/webchat-customer-portal";
import { getCrmRequestLanguage } from "@/lib/auth/request-language";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { createWorkspaceProductContext } from "@/lib/product-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Webchat | Novalure CRM", robots: { index: false, follow: false } };

export default async function WebchatPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { session, language, preference } = await getCrmRequestLanguage();
  if (!session || session.source !== "cookie") redirect("/login");
  const query = await searchParams;
  if (query.workspaceId !== undefined && typeof query.workspaceId !== "string") return <main><h1>{language === "de" ? "Zugriff nicht möglich" : "Access unavailable"}</h1></main>;
  const url = new URL("/webchat", getTrustedAppOrigin());
  if (typeof query.workspaceId === "string") url.searchParams.set("workspaceId", query.workspaceId);
  const auth = await resolveWorkspaceScopedSession(new Request(url, { headers: new Headers(await headers()) }), { permission: "crm:read" });
  if (!auth.ok) return <main><h1>{language === "de" ? "Zugriff nicht möglich" : "Access unavailable"}</h1><Link href="/">{language === "de" ? "Zurück zum Arbeitsbereich" : "Back to workspace"}</Link></main>;
  const target = auth.session;
  const workspaceContext = createWorkspaceProductContext({ workspaceId: target.workspaceId, workspaceName: target.workspaceName,
    technicalRole: target.role, productRole: target.productRole, customerType: target.workspaceCustomerType,
    operatingModel: target.workspaceOperatingModel, setupState: target.workspaceSetupState,
    teamStructure: target.workspaceTeamStructure, activeCalendarProvider: target.workspaceActiveCalendarProvider });
  // Module presentation is already derived; arbitrary setup metadata stays server-side.
  workspaceContext.setupState = null;
  return <div lang={language} data-crm-language-preference={preference}><WebchatCustomerPortal language={language} workspaceId={target.workspaceId} workspaceContext={workspaceContext} /></div>;
}
