import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CrmWorkspace } from "@/components/crm-workspace";
import { getMockCoreCrmData } from "@/lib/db/crm-loaders";
import { users, workspace } from "@/lib/crm-source";
import { isVisualQaDeployment } from "../preview-guard";
import styles from "../visual-qa.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CRM Visual QA Content | Novalure",
  robots: {
    follow: false,
    index: false,
  },
};

export default function VisualQaContentPage() {
  if (!isVisualQaDeployment()) {
    notFound();
  }

  const previewUser = users[0];
  if (!previewUser) {
    notFound();
  }

  return (
    <div className={styles.content} inert>
      <CrmWorkspace
        coreData={getMockCoreCrmData(workspace.id)}
        initialLanguage="de"
        sessionProductRole={previewUser.productRole ?? "platform_admin"}
        sessionRole={previewUser.role}
        sessionUserId={previewUser.id}
        sessionUserName={previewUser.name}
        sessionWorkspace={{
          activeCalendarProvider: workspace.activeCalendarProvider,
          customerType: workspace.customerType,
          id: workspace.id,
          name: workspace.name,
          operatingModel: workspace.operatingModel,
          teamStructure: workspace.teamStructure,
        }}
      />
    </div>
  );
}
