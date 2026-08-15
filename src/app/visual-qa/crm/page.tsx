import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isVisualQaDeployment } from "./preview-guard";
import styles from "./visual-qa.module.css";

type VisualQaPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CRM Visual QA | Novalure",
  robots: {
    follow: false,
    index: false,
  },
};

export default async function VisualQaPage({ searchParams }: VisualQaPageProps) {
  if (!isVisualQaDeployment()) {
    notFound();
  }

  const query = searchParams ? await searchParams : {};
  const viewport = Array.isArray(query.viewport) ? query.viewport[0] : query.viewport;

  return (
    <main className={viewport === "mobile" ? styles.stage : styles.desktopStage}>
      <section
        aria-label={viewport === "mobile" ? "390 pixel mobile CRM preview" : "Desktop CRM preview"}
        className={viewport === "mobile" ? styles.device : styles.desktopDevice}
      >
        <iframe
          className={styles.frame}
          sandbox="allow-same-origin"
          src="/visual-qa/crm/content"
          title={viewport === "mobile"
            ? "Novalure CRM mobile visual QA"
            : "Novalure CRM desktop visual QA"}
        />
      </section>
    </main>
  );
}
