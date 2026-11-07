import { PublicProductShell } from "@/components/public-product-shell";
import { companyLegalDetails } from "@/lib/legal";
import { getPublicProductLanguage, publicProductMetadata, type PublicProductPageProps } from "@/lib/public-product-page";
import styles from "./page.module.css";

const copy = {
  de: {
    title: "CRM-Demo anfragen",
    description: "Sehen Sie, wie Novalure CRM Ihren Projektvertrieb von der verfügbaren Einheit bis zur Reservierung abbildet.",
    agendaTitle: "Was wir Ihnen zeigen",
    agenda: [
      "Projekt und Einheitenbestand mit Verfügbarkeiten",
      "Webexposés, Nutzungsstatistik und Käuferanfragen",
      "Besichtigungen, Reservierungen und Projektberichte",
    ],
    contactTitle: "Ein Termin für Ihr Team",
    contactText: "Schreiben Sie uns kurz, für welches Projekt oder Maklerteam Sie Novalure prüfen. Wir melden uns mit einem Terminvorschlag.",
    emailButton: "E-Mail zur Demo öffnen",
    emailBody: "Hallo Novalure-Team,\n\nich möchte eine CRM-Demo anfragen.\n\nUnternehmen:\nProjekt oder Team:\nWas wir sehen möchten:\n\nViele Grüße",
    emailHint: "Die Schaltfläche öffnet eine vorbereitete Nachricht in Ihrem E-Mail-Programm.",
  },
  en: {
    title: "Request a CRM demo",
    description: "See how Novalure CRM supports your development sales, from available units to reservations.",
    agendaTitle: "What we will show you",
    agenda: [
      "Development and unit inventory with availability",
      "Web brochures, usage analytics and buyer enquiries",
      "Viewings, reservations and project sales reports",
    ],
    contactTitle: "A session for your team",
    contactText: "Tell us which development or estate agency team you are evaluating Novalure for. We will get back to you with a proposed time.",
    emailButton: "Open demo request email",
    emailBody: "Hello Novalure team,\n\nI would like to request a CRM demo.\n\nCompany:\nDevelopment or team:\nWhat we would like to see:\n\nKind regards",
    emailHint: "The button opens a prepared message in your email app.",
  },
  es: {
    title: "Solicite una demo del CRM",
    description: "Vea cómo Novalure CRM apoya la comercialización de su promoción, desde las unidades disponibles hasta las reservas.",
    agendaTitle: "Qué le mostraremos",
    agenda: [
      "Inventario y disponibilidad de las unidades de la promoción",
      "Fichas web, estadísticas de uso y consultas de compradores",
      "Visitas, reservas e informes de ventas de la promoción",
    ],
    contactTitle: "Una sesión para su equipo",
    contactText: "Cuéntenos para qué promoción o agencia inmobiliaria está valorando Novalure. Le responderemos con una propuesta de fecha.",
    emailButton: "Abrir correo para solicitar la demo",
    emailBody: "Hola, equipo de Novalure:\n\nMe gustaría solicitar una demo del CRM.\n\nEmpresa:\nPromoción o equipo:\nQué nos gustaría ver:\n\nSaludos",
    emailHint: "El botón abre un mensaje preparado en su aplicación de correo.",
  },
} as const;

export async function generateMetadata({ searchParams }: PublicProductPageProps) {
  const language = await getPublicProductLanguage((await searchParams).lang);
  const { title, description } = copy[language];
  return publicProductMetadata({ path: "/demo", language, title: `${title} | Novalure CRM`, description });
}

export default async function DemoPage({ searchParams }: PublicProductPageProps) {
  const language = await getPublicProductLanguage((await searchParams).lang);
  const text = copy[language];
  const { email } = companyLegalDetails;
  const demoMail = `mailto:${email}?subject=${encodeURIComponent(text.title)}&body=${encodeURIComponent(text.emailBody)}`;

  return (
    <PublicProductShell language={language} path="/demo">
      <main className={styles.main}>
        <div className={styles.overview}>
          <p className={styles.eyebrow}>Novalure CRM</p>
          <h1>{text.title}</h1>
          <p className={styles.intro}>{text.description}</p>
          <h2 className={styles.agendaTitle}>{text.agendaTitle}</h2>
          <ul className={styles.agenda}>
            {text.agenda.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <section aria-labelledby="demo-contact" className={styles.contact}>
          <h2 id="demo-contact">{text.contactTitle}</h2>
          <p>{text.contactText}</p>
          <a className={styles.button} href={demoMail}>{text.emailButton}</a>
          <p className={styles.hint}>{text.emailHint}</p>
          <a className={styles.email} href={`mailto:${email}`}>{email}</a>
        </section>
      </main>
    </PublicProductShell>
  );
}
