"use client";

import { useId } from "react";
import type { LanguageCode } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n";
import { buildEvelynCommandOverview } from "@/lib/evelyn-command-center";
import type { EvelynCommandData, EvelynCommandSection, EvelynMetricId, EvelynMetricState } from "@/lib/evelyn-command-center";
import { Badge, Button, Card, Icon, MetricCard } from "../../design-c/components/ui";
import "@/styles/evelyn-command-center.css";

export type { EvelynCommandSection } from "@/lib/evelyn-command-center";

export type EvelynCommandCenterProps = EvelynCommandData & {
  language: LanguageCode;
  userName: string;
  workspaceName: string;
  projectLabel: string;
  onOpenSection: (section: EvelynCommandSection) => void;
  /** Only supply a verified, authorized existing Evelyn-service entry point. */
  onOpenEvelyn?: () => void;
};

const copy = {
  de: {
    label: "Evelyn Command Center", overview: "Ihr CRM-Überblick", greeting: "Willkommen", subtitle: "Den nächsten Schritt im Blick.",
    scope: "Aktueller Bereich", database: "Aus autorisierten CRM-Daten", derived: "Zusammenfassung aus dem geladenen CRM-Stand · keine KI-Analyse",
    limited: "Geladener Ausschnitt · keine Gesamtzahlen", local: "Im geladenen Bereich", empty: "Noch keine Einträge im geladenen Bereich.",
    unavailable: "Nicht verfügbar", loading: "Wird geladen", invalid: "Bereich nicht verfügbar", restricted: "Für dieses Profil nicht verfügbar.", loadError: "Die Daten konnten nicht zuverlässig geladen werden.",
    unavailableDetail: "Diese Auswertung ist noch nicht verfügbar.", loadingDetail: "Der ausgewählte Bereich wird geladen.", invalidDetail: "Bitte einen berechtigten Workspace und Projektbereich auswählen.",
    metricLabels: { leads: "Neue Anfragen", tasks: "Offene Aufgaben", projects: "Aktive Projekte", calendarEvents: "Geladene Termine", customers: "Aktive Kunden", offers: "Offene Angebote" },
    metricDescriptions: { leads: "Status: Neu", tasks: "Status: offen", projects: "Status: Aktiv oder Skaliert", calendarEvents: "Termine im aktuellen Bereich", customers: "Status: aktiv", offers: "Angebote bleiben im bestehenden Vertriebsablauf erreichbar." },
    actions: "Ihre nächsten Schritte", actionsDetail: "Öffnen Sie einen für Sie verfügbaren Arbeitsbereich.", activity: "Aus Ihren CRM-Datensätzen", activityDetail: "Eingänge und Kundenaktivität aus dem geladenen Bereich.", activityEmpty: "Keine datierten Einträge verfügbar.",
    leadEvent: "Anfrage eingegangen", customerEvent: "Kundenaktivität", untitledLead: "Anfrage", untitledCustomer: "Kundeneintrag", appointments: "Termine im Bereich", appointmentsEmpty: "Noch keine geladenen Termine.",
    aiUnavailable: "Evelyn-Verbindung nicht verfügbar", aiDetail: "Ein autorisierter Evelyn-Dienst ist hier noch nicht angebunden. Die CRM-Funktionen bleiben über die vorhandenen Bereiche erreichbar.", aiOpen: "Evelyn öffnen", aiAvailable: "Evelyn-Zugang verfügbar", aiAvailableDetail: "Öffnet den bestehenden autorisierten Evelyn-Zugang.",
    sections: { leadInbox: "Anfragen ansehen", tasks: "Aufgaben öffnen", calendar: "Kalender öffnen", projects: "Projekte ansehen", contacts: "Kontakte öffnen", pipelines: "Vertrieb öffnen", knowledge: "Wissen verwalten", bots: "Assistenten öffnen", customerAccess: "Kundenverwaltung öffnen" },
    countSeparator: " · ", activityOpen: "Eintrag im zuständigen Bereich öffnen", noActions: "Für dieses Profil sind keine weiteren Arbeitsbereiche verfügbar.",
  },
  en: {
    label: "Evelyn Command Center", overview: "Your CRM overview", greeting: "Welcome", subtitle: "Keep your next step in view.",
    scope: "Current scope", database: "From authorized CRM data", derived: "Summary of loaded CRM records · no AI analysis",
    limited: "Loaded subset · not overall totals", local: "Within the loaded scope", empty: "No records in the loaded scope yet.",
    unavailable: "Unavailable", loading: "Loading", invalid: "Scope unavailable", restricted: "Unavailable for this profile.", loadError: "The data could not be loaded reliably.",
    unavailableDetail: "This report is not available yet.", loadingDetail: "Loading the selected scope.", invalidDetail: "Select an authorized workspace and project scope.",
    metricLabels: { leads: "New enquiries", tasks: "Open tasks", projects: "Active projects", calendarEvents: "Loaded appointments", customers: "Active customers", offers: "Open offers" },
    metricDescriptions: { leads: "Status: New", tasks: "Status: Open", projects: "Status: Active or Scaled", calendarEvents: "Appointments in the current scope", customers: "Status: Active", offers: "Offers remain available in the existing sales workflow." },
    actions: "Your next steps", actionsDetail: "Open a workspace available to your profile.", activity: "From your CRM records", activityDetail: "Enquiries and customer activity in the loaded scope.", activityEmpty: "No dated records available.",
    leadEvent: "Enquiry received", customerEvent: "Customer activity", untitledLead: "Enquiry", untitledCustomer: "Customer record", appointments: "Appointments in scope", appointmentsEmpty: "No appointments loaded yet.",
    aiUnavailable: "Evelyn connection unavailable", aiDetail: "An authorized Evelyn service has not been connected here yet. CRM features remain available in their existing sections.", aiOpen: "Open Evelyn", aiAvailable: "Evelyn access available", aiAvailableDetail: "Opens the existing authorized Evelyn entry point.",
    sections: { leadInbox: "View enquiries", tasks: "Open tasks", calendar: "Open calendar", projects: "View projects", contacts: "Open contacts", pipelines: "Open sales", knowledge: "Manage knowledge", bots: "Open assistants", customerAccess: "Open customer management" },
    countSeparator: " · ", activityOpen: "Open this record's section", noActions: "No additional sections are available for this profile.",
  },
  es: {
    label: "Evelyn Command Center", overview: "Su resumen del CRM", greeting: "Bienvenido", subtitle: "Su próximo paso, a la vista.",
    scope: "Ámbito actual", database: "Datos autorizados del CRM", derived: "Resumen de registros cargados del CRM · sin análisis de IA",
    limited: "Selección cargada · no son totales globales", local: "En el ámbito cargado", empty: "Todavía no hay registros en el ámbito cargado.",
    unavailable: "No disponible", loading: "Cargando", invalid: "Ámbito no disponible", restricted: "No disponible para este perfil.", loadError: "No se pudieron cargar los datos de forma fiable.",
    unavailableDetail: "Este informe todavía no está disponible.", loadingDetail: "Cargando el ámbito seleccionado.", invalidDetail: "Seleccione un espacio y un proyecto autorizados.",
    metricLabels: { leads: "Nuevas consultas", tasks: "Tareas abiertas", projects: "Proyectos activos", calendarEvents: "Citas cargadas", customers: "Clientes activos", offers: "Ofertas abiertas" },
    metricDescriptions: { leads: "Estado: Nuevo", tasks: "Estado: Abierto", projects: "Estado: Activo o Ampliado", calendarEvents: "Citas en el ámbito actual", customers: "Estado: Activo", offers: "Las ofertas siguen disponibles en el flujo de ventas existente." },
    actions: "Sus próximos pasos", actionsDetail: "Abra una sección disponible para su perfil.", activity: "De sus registros del CRM", activityDetail: "Consultas y actividad de clientes en el ámbito cargado.", activityEmpty: "No hay registros con fecha disponibles.",
    leadEvent: "Consulta recibida", customerEvent: "Actividad del cliente", untitledLead: "Consulta", untitledCustomer: "Registro del cliente", appointments: "Citas en el ámbito", appointmentsEmpty: "Todavía no hay citas cargadas.",
    aiUnavailable: "Conexión con Evelyn no disponible", aiDetail: "Todavía no hay un servicio autorizado de Evelyn conectado aquí. Las funciones del CRM siguen disponibles en sus secciones actuales.", aiOpen: "Abrir Evelyn", aiAvailable: "Acceso a Evelyn disponible", aiAvailableDetail: "Abre el acceso autorizado existente de Evelyn.",
    sections: { leadInbox: "Ver consultas", tasks: "Abrir tareas", calendar: "Abrir calendario", projects: "Ver proyectos", contacts: "Abrir contactos", pipelines: "Abrir ventas", knowledge: "Gestionar conocimiento", bots: "Abrir asistentes", customerAccess: "Abrir gestión de clientes" },
    countSeparator: " · ", activityOpen: "Abrir la sección de este registro", noActions: "No hay más secciones disponibles para este perfil.",
  },
} as const;

const metricIcons: Record<EvelynMetricId, string> = { leads: "users", tasks: "check", projects: "layers", calendarEvents: "calendar", customers: "briefcase", offers: "file" };
const actionOrder: EvelynCommandSection[] = ["leadInbox", "tasks", "projects", "knowledge", "bots", "calendar", "contacts", "pipelines", "customerAccess"];

export function EvelynCommandCenter(props: EvelynCommandCenterProps) {
  const { language, userName, workspaceName, projectLabel, onOpenSection, onOpenEvelyn } = props;
  const text = copy[language] ?? copy.en;
  const overview = buildEvelynCommandOverview(props);
  const titleId = useId();
  const number = new Intl.NumberFormat(getLocale(language));
  const date = new Intl.DateTimeFormat(getLocale(language), { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Vienna" });
  const availableMetrics = overview.metrics.filter(metric => metric.state === "ready");
  const actions = actionOrder.filter(section => props.scopeStatus === "ready" && props.allowedSections.includes(section));
  const summary = availableMetrics.filter(metric => metric.id !== "calendarEvents").slice(0, 3)
    .map(metric => `${number.format(metric.value!)} ${text.metricLabels[metric.id]}`).join(text.countSeparator);

  function metricDetail(id: EvelynMetricId, state: EvelynMetricState) {
    if (state === "loading") return text.loadingDetail;
    if (state === "invalid") return text.invalidDetail;
    if (state === "restricted") return text.restricted;
    if (state === "error") return text.loadError;
    if (state !== "ready") return id === "offers" ? text.metricDescriptions.offers : text.unavailableDetail;
    return `${text.metricDescriptions[id]} · ${overview.limited ? text.limited : text.local}`;
  }

  return <section aria-labelledby={titleId} className="ec-command-center" data-evelyn-command-center>
    <div className="ec-command-layout">
      <div className="ec-command-main">
        <section className="ec-intelligence">
          <div className="ec-intelligence-head"><span className="ec-orb"><Icon name="sparkles" size={25} /></span><div><strong>Evelyn</strong><span>{text.overview}</span></div><Badge tone="violet">{text.scope}</Badge></div>
          <h2 id={titleId}>{text.greeting}{userName.trim() ? `, ${userName.trim()}` : ""}.<br />{text.subtitle}</h2>
          <p className="ec-scope"><strong>{workspaceName}</strong><span>{projectLabel}</span></p>
          <p className="ec-summary" role="status">{props.scopeStatus === "loading" ? text.loadingDetail : props.scopeStatus === "invalid" ? text.invalidDetail : summary || text.unavailableDetail}</p>
          <div className="ec-intelligence-actions">{actions.slice(0, 3).map(section => <Button key={section} onClick={() => onOpenSection(section)} variant="secondary">{text.sections[section]}<Icon name="arrow" size={15} /></Button>)}</div>
          <small>{text.derived}</small>
        </section>
        <section aria-label={text.database} className="ec-metric-grid">
          {overview.metrics.map(metric => <MetricCard key={metric.id} label={text.metricLabels[metric.id]} icon={metricIcons[metric.id]} value={metric.state === "ready" ? number.format(metric.value!) : <span className="ec-metric-unavailable">{metric.state === "loading" ? text.loading : metric.state === "invalid" ? text.invalid : text.unavailable}</span>} detail={metricDetail(metric.id, metric.state)} />)}
        </section>
        <Card title={text.actions} className="ec-actions-card"><p>{text.actionsDetail}</p>{actions.length ? <div className="ec-section-actions">{actions.map(section => <Button key={section} onClick={() => onOpenSection(section)} variant="secondary">{text.sections[section]}<Icon name="arrow" size={15} /></Button>)}</div> : <p>{text.noActions}</p>}</Card>
      </div>
      <aside className="ec-command-context" aria-label={text.overview}>
        <Card title={text.activity}><p className="ec-context-description">{text.activityDetail}</p>{overview.activity.length ? <ol className="ec-record-list">{overview.activity.map(item => <li key={item.id}><span className="ec-record-icon"><Icon name={item.kind === "lead" ? "users" : "activity"} size={17} /></span><div><span>{item.kind === "lead" ? text.leadEvent : text.customerEvent}</span><strong>{item.title || (item.kind === "lead" ? text.untitledLead : text.untitledCustomer)}</strong><time dateTime={item.occurredAt}>{date.format(new Date(item.occurredAt))}</time></div><Button aria-label={`${text.activityOpen}: ${item.title || (item.kind === "lead" ? text.untitledLead : text.untitledCustomer)}`} onClick={() => onOpenSection(item.section)} variant="ghost"><Icon name="arrow" size={16} /></Button></li>)}</ol> : <p className="ec-context-empty">{text.activityEmpty}</p>}</Card>
        <Card title={text.appointments}>{overview.appointments.length ? <ol className="ec-appointment-list">{overview.appointments.map(event => <li key={event.id}><Icon name="calendar" size={18} /><div><strong>{event.title}</strong><time dateTime={event.startsAt}>{date.format(new Date(event.startsAt))}</time></div></li>)}</ol> : <p className="ec-context-empty">{overview.metrics.find(metric => metric.id === "calendarEvents")?.state === "ready" ? text.appointmentsEmpty : text.unavailableDetail}</p>}{actions.includes("calendar") && <Button onClick={() => onOpenSection("calendar")} variant="ghost">{text.sections.calendar}<Icon name="arrow" size={15} /></Button>}</Card>
        <Card title="Evelyn" className="ec-service-card"><Badge tone={onOpenEvelyn ? "info" : "neutral"}>{onOpenEvelyn ? text.aiAvailable : text.aiUnavailable}</Badge><p>{onOpenEvelyn ? text.aiAvailableDetail : text.aiDetail}</p>{onOpenEvelyn && <Button onClick={onOpenEvelyn}>{text.aiOpen}<Icon name="arrow" size={16} /></Button>}</Card>
      </aside>
    </div>
  </section>;
}
