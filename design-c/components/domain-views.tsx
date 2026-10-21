"use client";

import { useId, useState, type ReactNode } from "react";
import type { DemoWorkspace, DomainViewProps } from "../lib/types";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Icon,
  PageHeading,
  Tabs,
} from "./ui";

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "violet";
const previewText = "Synthetische Beispieldaten · reine Designvorschau";
const customerTabs = [
  { id: "overview", label: "Übersicht" },
  { id: "contacts", label: "Kontakte" },
  { id: "projects", label: "Projekte" },
  { id: "websites", label: "Websites" },
  { id: "assistants", label: "Assistenten" },
  { id: "knowledge", label: "Wissen" },
  { id: "offers", label: "Angebote" },
  { id: "invoices", label: "Rechnungen" },
  { id: "activities", label: "Aktivitäten" },
];
const assistantTabs = [
  { id: "overview", label: "Übersicht" },
  { id: "configuration", label: "Konfiguration" },
  { id: "sources", label: "Wissensquellen" },
  { id: "conversations", label: "Gespräche" },
  { id: "statistics", label: "Statistik" },
  { id: "integrations", label: "Integrationen" },
  { id: "subscription", label: "Abo" },
];
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("");

function DemoNote({ children }: { children?: ReactNode }) {
  return (
    <p className="dc-domain-note">
      <Icon name="info" size={15} />
      <span>{children || previewText}</span>
    </p>
  );
}
function Metric({
  label,
  value,
  detail,
  icon = "chart",
}: {
  label: string;
  value: string;
  detail: string;
  icon?: string;
}) {
  return (
    <div className="dc-domain-metric">
      <span className="dc-domain-metric-icon">
        <Icon name={icon} size={18} />
      </span>
      <span className="dc-domain-muted">{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
function Row({
  icon = "file",
  title,
  detail,
  end,
}: {
  icon?: string;
  title: string;
  detail: string;
  end?: ReactNode;
}) {
  return (
    <div className="dc-domain-row">
      <span className="dc-domain-icon">
        <Icon name={icon} size={19} />
      </span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      {end}
    </div>
  );
}
function DefinitionGrid({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="dc-domain-definitions">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function ContextLine({
  context,
  portal,
}: {
  context: DemoWorkspace;
  portal: boolean;
}) {
  return (
    <div className="dc-domain-context">
      <span>
        <span className="dc-domain-context-dot" />
        {context.name}
        <span className="dc-domain-context-separator">/</span>
        {context.project}
      </span>
      <Badge tone="neutral">
        {portal ? "Portalvorschau" : "Synthetischer Arbeitsbereich"}
      </Badge>
    </div>
  );
}
function PresentationButton({
  children,
  title,
  action,
  variant = "secondary",
}: {
  children: ReactNode;
  title: string;
  action: DomainViewProps["onPreviewAction"];
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <Button variant={variant} onClick={() => action(title)}>
      {children}
    </Button>
  );
}

export function CustomersView(props: DomainViewProps) {
  return (
    <CustomersInner key={`${props.context.id}:${props.portal}`} {...props} />
  );
}
function CustomersInner({ context, portal, onPreviewAction }: DomainViewProps) {
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("overview");
  if (portal)
    return (
      <PortalOverview
        context={context}
        portal={portal}
        onPreviewAction={onPreviewAction}
      />
    );
  const names = [
    context.name,
    `${context.name} Entwicklung`,
    `${context.name} Living`,
    `${context.name} Partners`,
  ];
  const name = names[selected];
  const project =
    selected === 0
      ? context.project
      : `${context.project} · Phase ${selected + 1}`;
  const visible = names
    .map((name, index) => ({ name, index }))
    .filter((item) =>
      item.name.toLocaleLowerCase("de").includes(query.toLocaleLowerCase("de")),
    );
  return (
    <div className="dc-domain-view">
      <PageHeading
        eyebrow="BEZIEHUNGEN IM BLICK"
        title="Kunden & Kontakte"
        description="Ein gemeinsamer Ort für Beziehungen, Projekte und den nächsten guten Schritt."
        actions={
          <PresentationButton
            title="Kunden anlegen"
            action={onPreviewAction}
            variant="primary"
          >
            <Icon name="plus" size={16} /> Neuer Kunde
          </PresentationButton>
        }
      />
      <ContextLine context={context} portal={portal} />
      <div className="dc-customer-layout">
        <Card
          className="dc-customer-directory"
          title="Kundenverzeichnis"
          actions={<Badge tone="neutral">4 Demo</Badge>}
        >
          <label className="dc-domain-search">
            <Icon name="search" size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Kunden durchsuchen …"
              aria-label="Kunden durchsuchen"
            />
          </label>
          <div className="dc-customer-items">
            {visible.map((item) => (
              <button
                className={`dc-customer-item ${selected === item.index ? "is-selected" : ""}`}
                key={item.index}
                onClick={() => {
                  setSelected(item.index);
                  setTab("overview");
                }}
                aria-pressed={selected === item.index}
              >
                <span className={`dc-domain-avatar dc-avatar-${item.index}`}>
                  {initials(item.name)}
                </span>
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {
                      [
                        "Immobilien & Entwicklung",
                        "Projektentwicklung",
                        "Wohnen & Vermarktung",
                        "Beratung & Service",
                      ][item.index]
                    }
                  </small>
                </span>
                <Icon name="chevron-right" size={15} />
              </button>
            ))}
          </div>
          {visible.length === 0 && (
            <p className="dc-domain-muted">Keine passenden Demo-Kunden.</p>
          )}
          <DemoNote>
            Alle Kunden sind erfunden und gehören nur zu diesem Demo-Kontext.
          </DemoNote>
        </Card>
        <Card className="dc-customer-profile">
          <div className="dc-customer-profile-head">
            <span className="dc-domain-avatar dc-domain-avatar-lg">
              {initials(name)}
            </span>
            <div>
              <div className="dc-domain-eyebrow">
                KUNDENPROFIL · DEMO-{context.id.toUpperCase()}-0{selected + 1}
              </div>
              <h2>{name}</h2>
              <p>Immobilien mit Perspektive. Gemeinsam digital weiterdenken.</p>
            </div>
            <Badge tone="success">Aktiver Demokunde</Badge>
          </div>
          <Tabs
            label="Bereiche des Kundenprofils"
            items={customerTabs}
            value={tab}
            onChange={setTab}
          />
          <div className="dc-customer-panel">
            {tab === "overview" && (
              <>
                <DefinitionGrid
                  items={[
                    [
                      "Ansprechperson",
                      `${["Mara Berger", "Jonas Leitner", "Lena Winter", "Noah Hartmann"][selected]} · Demo`,
                    ],
                    [
                      "E-Mail",
                      `kontakt+${context.id}-${selected + 1}@example.com`,
                    ],
                    ["Projekt", project],
                    ["Kundenverantwortung", "Evelyn Studio · Demo-Team"],
                    ["Zusammenarbeit seit", "Juni 2026 · Beispieldatum"],
                    ["Branche", "Immobilien & Projektentwicklung"],
                  ]}
                />
                <div className="dc-domain-divider" />
                <div className="dc-domain-section-head">
                  <h3>Gebuchte Leistungen</h3>
                  <span className="dc-domain-muted">
                    Synthetischer Vertragsstand
                  </span>
                </div>
                <Row
                  icon="globe"
                  title="Website & digitale Präsenz"
                  detail={`${project} · Website im Entwurf`}
                  end={<Badge tone="info">In Arbeit</Badge>}
                />
                <Row
                  icon="sparkles"
                  title="Evelyn Projektassistent"
                  detail={`Berät beispielhaft zu ${project}`}
                  end={<Badge tone="success">Demo aktiv</Badge>}
                />
                <Row
                  icon="book"
                  title="Wissen & Inhalte"
                  detail="12 Beispielquellen · 2 Entwürfe zur internen Prüfung"
                  end={<Badge tone="violet">In Betreuung</Badge>}
                />
                <div className="dc-domain-callout">
                  <Icon name="sparkles" size={20} />
                  <div>
                    <strong>Ein guter nächster Schritt</strong>
                    <p>
                      Die Projektbeschreibung von {project} gemeinsam abstimmen
                      und anschließend die Website-Vorschau besprechen.
                    </p>
                  </div>
                </div>
              </>
            )}
            {tab === "contacts" && (
              <>
                <div className="dc-domain-section-head">
                  <h3>Menschen hinter {name}</h3>
                  <PresentationButton
                    title="Kontakt hinzufügen"
                    action={onPreviewAction}
                  >
                    Kontakt hinzufügen
                  </PresentationButton>
                </div>
                {["Mara Berger", "Jonas Leitner", "Lena Winter"].map(
                  (person, i) => (
                    <Row
                      key={person}
                      icon="users"
                      title={`${person} · Demo`}
                      detail={`${["Geschäftsführung", "Projektleitung", "Marketing"][i]} · ${context.id}-${selected}-${i}@example.com`}
                      end={
                        <Badge tone={i === 0 ? "info" : "neutral"}>
                          {i === 0 ? "Hauptkontakt" : "Kontakt"}
                        </Badge>
                      }
                    />
                  ),
                )}
                <DemoNote />
              </>
            )}
            {tab === "projects" && (
              <>
                <div className="dc-domain-section-head">
                  <h3>Gemeinsame Projekte</h3>
                  <Badge tone="neutral">2 Demo-Projekte</Badge>
                </div>
                <Row
                  icon="building"
                  title={project}
                  detail="Vermarktungsstart · nächster Meilenstein: Designabstimmung"
                  end={<Badge tone="info">Umsetzung</Badge>}
                />
                <Row
                  icon="layers"
                  title={`${project} · Markenauftritt`}
                  detail="Konzept & Positionierung · Verantwortlich: Demo-Team"
                  end={<Badge tone="violet">Konzeption</Badge>}
                />
                <div className="dc-domain-progress">
                  <span>
                    Beispielhafter Projektfortschritt<strong>68 %</strong>
                  </span>
                  <div>
                    <i style={{ width: "68%" }} />
                  </div>
                </div>
              </>
            )}
            {tab === "websites" && (
              <>
                <div className="dc-domain-mini-site">
                  <span>{name.toUpperCase()}</span>
                  <strong>
                    Raum für
                    <br />
                    neue Perspektiven.
                  </strong>
                  <p>{project} · Lokale Website-Illustration</p>
                  <span className="dc-domain-site-line" />
                </div>
                <Row
                  icon="globe"
                  title={`${project} · Projektwebsite`}
                  detail={`projekt-${context.id}.example.com · synthetische Beispieldomain`}
                  end={<Badge tone="warning">Entwurf</Badge>}
                />
                <PresentationButton
                  title="Website-Vorschau öffnen"
                  action={onPreviewAction}
                >
                  Website-Vorschau öffnen <Icon name="arrow" size={16} />
                </PresentationButton>
              </>
            )}
            {tab === "assistants" && (
              <>
                <Row
                  icon="sparkles"
                  title={`${name} Projektberater`}
                  detail={`Website-Assistent für ${project} · synthetischer Testbetrieb`}
                  end={<Badge tone="success">Demo aktiv</Badge>}
                />
                <Row
                  icon="chat"
                  title={`${name} Servicebegleiter`}
                  detail="Allgemeine Fragen & Orientierung · noch ohne produktive Anbindung"
                  end={<Badge tone="warning">Einrichtung</Badge>}
                />
                <DemoNote>
                  Assistenten beantworten in dieser Vorschau keine echten
                  Kundenanfragen.
                </DemoNote>
              </>
            )}
            {tab === "knowledge" && (
              <>
                <Row
                  icon="building"
                  title={`${name} · Unternehmensprofil`}
                  detail="Version 2.1 · veröffentlichter Beispielstand"
                  end={<Badge tone="success">Freigegeben · Demo</Badge>}
                />
                <Row
                  icon="file"
                  title={`${project} · Projektbeschreibung`}
                  detail="Version 1.3 · Änderungen im Entwurf"
                  end={<Badge tone="warning">Entwurf</Badge>}
                />
                <Row
                  icon="book"
                  title={`${project} · Häufige Fragen`}
                  detail="Version 1.0 · geprüfte Beispielinformationen"
                  end={<Badge tone="success">Freigegeben · Demo</Badge>}
                />
              </>
            )}
            {tab === "offers" && (
              <DataTable
                caption={`Synthetische Angebote für ${name}`}
                columns={[
                  { key: "offer", label: "Angebot" },
                  { key: "scope", label: "Leistung" },
                  { key: "total", label: "Netto" },
                  { key: "status", label: "Status" },
                ]}
                rows={[
                  {
                    id: `${context.id}-${selected}-offer-1`,
                    search: `${name} Website offen`,
                    status: "Offen",
                    sortValues: { total: 8400 },
                    cells: {
                      offer: `ANG-${context.id}-01`,
                      scope: `${project} · Website`,
                      total: "€ 8.400",
                      status: <Badge tone="info">Offen · Demo</Badge>,
                    },
                  },
                  {
                    id: `${context.id}-${selected}-offer-2`,
                    search: `${name} Betreuung angenommen`,
                    status: "Angenommen",
                    sortValues: { total: 490 },
                    cells: {
                      offer: `ANG-${context.id}-02`,
                      scope: "AI & Betreuung",
                      total: "€ 490 / Monat",
                      status: <Badge tone="success">Angenommen · Demo</Badge>,
                    },
                  },
                ]}
              />
            )}
            {tab === "invoices" && (
              <>
                <DataTable
                  caption={`Synthetische Rechnungen für ${name}`}
                  columns={[
                    { key: "number", label: "Rechnung" },
                    { key: "service", label: "Leistung" },
                    { key: "amount", label: "Betrag netto" },
                    { key: "status", label: "Status" },
                  ]}
                  rows={[
                    {
                      id: `${context.id}-${selected}-invoice-1`,
                      search: `${name} Website bezahlt`,
                      status: "Bezahlt",
                      sortValues: { amount: 4200 },
                      cells: {
                        number: `RE-${context.id}-101`,
                        service: "Website · erste Teilrechnung",
                        amount: "€ 4.200",
                        status: <Badge tone="success">Bezahlt · Demo</Badge>,
                      },
                    },
                    {
                      id: `${context.id}-${selected}-invoice-2`,
                      search: `${name} Oktober offen`,
                      status: "Offen",
                      sortValues: { amount: 490 },
                      cells: {
                        number: `RE-${context.id}-102`,
                        service: "Betreuung · Oktober 2026",
                        amount: "€ 490",
                        status: <Badge tone="warning">Offen · Demo</Badge>,
                      },
                    },
                  ]}
                />
                <DemoNote>
                  Keine Buchhaltung, Zahlungsanforderung oder steuerlich gültige
                  Rechnung.
                </DemoNote>
              </>
            )}
            {tab === "activities" && (
              <div className="dc-domain-timeline">
                {[
                  [
                    "Heute, 09:40",
                    "Website-Entwurf vorbereitet",
                    `Die nächste Ansicht für ${project} liegt zur Besprechung bereit.`,
                  ],
                  [
                    "Gestern, 14:20",
                    "Projektwissen ergänzt",
                    `Drei synthetische Dokumente wurden dem Kontext ${name} zugeordnet.`,
                  ],
                  [
                    "16. Oktober, 10:00",
                    "Auftaktgespräch dokumentiert",
                    "Ziele, Verantwortlichkeiten und nächste Schritte beispielhaft festgehalten.",
                  ],
                ].map(([time, title, detail]) => (
                  <div key={title}>
                    <span />
                    <div>
                      <small>{time} · simuliert</small>
                      <strong>{title}</strong>
                      <p>{detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export function TenantsView(props: DomainViewProps) {
  return (
    <TenantsInner key={`${props.context.id}:${props.portal}`} {...props} />
  );
}
function TenantsInner({ context, portal, onPreviewAction }: DomainViewProps) {
  if (portal)
    return (
      <PortalOverview
        context={context}
        portal={portal}
        onPreviewAction={onPreviewAction}
      />
    );
  return (
    <div className="dc-domain-view">
      <PageHeading
        eyebrow="KLAR GETRENNTE ARBEITSBEREICHE"
        title="Mandanten"
        description="Kundenkontexte, Projekte und Module auf einen Blick. Alle Einträge sind synthetische Beispiele."
        actions={
          <PresentationButton
            title="Mandanten einrichten"
            action={onPreviewAction}
            variant="primary"
          >
            <Icon name="plus" size={16} /> Mandant anlegen
          </PresentationButton>
        }
      />
      <ContextLine context={context} portal={portal} />
      <div className="dc-domain-metrics dc-domain-metrics-3">
        <Metric
          label="Demo-Arbeitsbereiche"
          value="3"
          detail={`Im Kontext ${context.name}`}
          icon="layers"
        />
        <Metric
          label="Beispielmodule"
          value="7"
          detail="Modulare Produktarchitektur"
          icon="grid"
        />
        <Metric
          label="Kontextstatus"
          value="Getrennt"
          detail="Nur simulierte UI-Kontexte"
          icon="shield"
        />
      </div>
      <div className="dc-domain-grid-3">
        {["Zentrale", "Projektteam", "Vermarktung"].map((unit, index) => (
          <Card key={unit} className="dc-tenant-card">
            <div className="dc-domain-section-head">
              <span className={`dc-domain-avatar dc-avatar-${index}`}>
                {initials(context.name)}
                {index + 1}
              </span>
              <Badge tone={index === 2 ? "warning" : "success"}>
                {index === 2 ? "Einrichtung · Demo" : "Aktiv · Demo"}
              </Badge>
            </div>
            <h2>
              {context.name}
              <br />
              <span>{unit}</span>
            </h2>
            <p>
              {context.project} ·{" "}
              {unit === "Zentrale"
                ? "Unternehmen & Betreuung"
                : unit === "Projektteam"
                  ? "Projektinhalte & Website"
                  : "Interessenten & Kommunikation"}
            </p>
            <div className="dc-tenant-modules">
              <Badge tone="neutral">Wissen</Badge>
              <Badge tone="neutral">
                {index === 0 ? "Studio" : "Immobilien"}
              </Badge>
              <Badge tone="neutral">Assistenten</Badge>
            </div>
            <DefinitionGrid
              items={[
                ["Beispielkennung", `${context.id}-${index + 1}`],
                ["Zugriff", "Nur visuelle Vorschau"],
              ]}
            />
            <PresentationButton
              title={`${unit} administrieren`}
              action={onPreviewAction}
            >
              Arbeitsbereich verwalten <Icon name="arrow" size={15} />
            </PresentationButton>
          </Card>
        ))}
      </div>
      <Card title="Kontext ist der Ausgangspunkt" eyebrow="MANDANTENMODELL">
        <div className="dc-domain-grid-3">
          <Row
            icon="building"
            title="Unternehmen"
            detail="Stammdaten und Markenprofil im jeweiligen Demo-Kontext."
          />
          <Row
            icon="layers"
            title="Projekt"
            detail="Projektbezogene Inhalte, Immobilien und Wissensquellen."
          />
          <Row
            icon="shield"
            title="Rollen & Sichtbarkeit"
            detail="Portal zeigt ausschließlich für Kunden bestimmte Beispielansichten."
          />
        </div>
        <DemoNote>
          Die Auswahl simuliert nur einen Kontextwechsel. Sie ist keine
          produktive Mandanten- oder Zugriffsverwaltung.
        </DemoNote>
      </Card>
    </div>
  );
}

export function StudioView(props: DomainViewProps) {
  return <StudioInner key={`${props.context.id}:${props.portal}`} {...props} />;
}
function StudioInner({ context, portal, onPreviewAction }: DomainViewProps) {
  const [tab, setTab] = useState("projects");
  const websiteSalesStatus = tab === "offers" ? "Offen" : "In Umsetzung";
  const assistantSalesStatus = tab === "offers" ? "Angenommen" : "Bestätigt";
  const tabs = portal
    ? [
        { id: "projects", label: "Meine Projekte" },
        { id: "orders", label: "Leistungen" },
        { id: "subscriptions", label: "Betreuung" },
      ]
    : [
        { id: "projects", label: "Projekte" },
        { id: "sales", label: "Sales-Pipeline" },
        { id: "leads", label: "Leads" },
        { id: "offers", label: "Angebote" },
        { id: "orders", label: "Aufträge" },
        { id: "subscriptions", label: "Abos" },
        { id: "portal", label: "Kundenportal" },
      ];
  return (
    <div className="dc-domain-view">
      <PageHeading
        eyebrow="EVELYN STUDIO"
        title={
          portal ? "Ihre digitale Zusammenarbeit" : "Von der Idee zum Erlebnis."
        }
        description={`${context.name} · Websites, Marken und AI-Erlebnisse aus einem gemeinsamen Arbeitsbereich.`}
        actions={
          !portal && (
            <PresentationButton
              title="Projekt starten"
              action={onPreviewAction}
              variant="primary"
            >
              <Icon name="plus" size={16} /> Projekt starten
            </PresentationButton>
          )
        }
      />
      <ContextLine context={context} portal={portal} />
      <div className="dc-studio-banner">
        <div className="dc-studio-symbol" aria-hidden="true">
          e<span>✳</span>
        </div>
        <div>
          <div className="dc-domain-eyebrow">DIGITAL MIT PERSÖNLICHKEIT</div>
          <h2>
            Gute Ideen verdienen
            <br />
            einen klaren Auftritt.
          </h2>
          <p>
            {context.project} · Wir verbinden Strategie, Design und hilfreiche
            AI.
          </p>
        </div>
        <Badge tone="violet">Studio · Designvorschau</Badge>
      </div>
      <Tabs
        label="Studio-Bereiche"
        items={tabs}
        value={tab}
        onChange={setTab}
      />
      {tab === "projects" && (
        <div className="dc-studio-layout">
          <Card className="dc-studio-project">
            <div className="dc-domain-mini-site">
              <span>{context.name.toUpperCase()}</span>
              <strong>
                Hier beginnt
                <br />
                etwas Besonderes.
              </strong>
              <p>{context.project} · lokale Website-Illustration</p>
              <span className="dc-domain-site-line" />
            </div>
            <div className="dc-studio-project-body">
              <div className="dc-domain-section-head">
                <Badge tone="info">Designphase · Demo</Badge>
                <span className="dc-domain-muted">Website & AI</span>
              </div>
              <h2>{context.project}</h2>
              <p>
                Ein digitaler Auftritt, der das Projekt greifbar macht und
                Menschen die richtige Orientierung gibt.
              </p>
              <div className="dc-domain-progress">
                <span>
                  Beispielhafter Projektstand<strong>68 %</strong>
                </span>
                <div>
                  <i style={{ width: "68%" }} />
                </div>
              </div>
              <div className="dc-studio-project-footer">
                <span>
                  <Icon name="calendar" size={15} /> Nächster Schritt:
                  Designreview
                </span>
                <PresentationButton
                  title="Projektdetails öffnen"
                  action={onPreviewAction}
                >
                  Projekt ansehen <Icon name="arrow" size={15} />
                </PresentationButton>
              </div>
            </div>
          </Card>
          <div className="dc-domain-stack">
            <Card title="Der nächste Meilenstein" eyebrow="GEMEINSAM WEITER">
              <div className="dc-studio-date">
                <span>23</span>
                <div>
                  Oktober 2026<small>Synthetischer Besprechungstermin</small>
                </div>
              </div>
              <h3>Design & Inhalte abstimmen</h3>
              <p className="dc-domain-muted">
                Website-Struktur, Projekttexte und die Rolle des Assistenten
                gemeinsam durchgehen.
              </p>
              <PresentationButton
                title="Besprechung anfragen"
                action={onPreviewAction}
              >
                Termin anfragen <Icon name="calendar" size={15} />
              </PresentationButton>
            </Card>
            <Card title="Ihr Projektteam">
              <Row
                icon="users"
                title="Mara · Studio Lead"
                detail={`Demo-Betreuung für ${context.name}`}
              />
              <Row
                icon="sparkles"
                title="Evelyn · AI-Begleitung"
                detail="Synthetische Unterstützung im Projektkontext"
              />
              <DemoNote />
            </Card>
          </div>
        </div>
      )}
      {tab === "sales" && (
        <div className="dc-domain-pipeline">
          {[
            {
              title: "Erstkontakt",
              value: "€ 6.800",
              badge: "1 Demo-Chance",
              text: "Digitale Positionierung",
              tone: "neutral" as Tone,
            },
            {
              title: "Konzept",
              value: "€ 12.400",
              badge: "1 Demo-Chance",
              text: `${context.project} · Markenwelt`,
              tone: "violet" as Tone,
            },
            {
              title: "Angebot",
              value: "€ 8.400",
              badge: "1 Demo-Chance",
              text: `${context.project} · Website`,
              tone: "info" as Tone,
            },
            {
              title: "Gewonnen",
              value: "€ 5.880",
              badge: "1 Demo-Chance",
              text: "AI-Betreuung · Jahreswert",
              tone: "success" as Tone,
            },
          ].map((column) => (
            <div key={column.title} className="dc-pipeline-column">
              <div className="dc-domain-section-head">
                <h3>{column.title}</h3>
                <Badge tone={column.tone}>1</Badge>
              </div>
              <Card>
                <Badge tone={column.tone}>{column.badge}</Badge>
                <h3>{column.text}</h3>
                <p>{context.name}</p>
                <strong className="dc-pipeline-value">{column.value}</strong>
                <small>Synthetischer Nettowert</small>
                <PresentationButton
                  title={`${column.title}: Verkaufschance öffnen`}
                  action={onPreviewAction}
                >
                  Details <Icon name="arrow" size={14} />
                </PresentationButton>
              </Card>
            </div>
          ))}
        </div>
      )}
      {tab === "leads" && (
        <Card
          title="Interessante neue Verbindungen"
          actions={
            <PresentationButton title="Lead erfassen" action={onPreviewAction}>
              Lead erfassen
            </PresentationButton>
          }
        >
          <DataTable
            caption={`Synthetische Studio-Leads · ${context.name}`}
            columns={[
              { key: "name", label: "Lead" },
              { key: "interest", label: "Interesse" },
              { key: "source", label: "Quelle" },
              { key: "status", label: "Status" },
            ]}
            rows={["Mara Berger", "Felix Sommer", "Lena Winter"].map(
              (name, index) => ({
                id: `${context.id}-studio-lead-${index}`,
                search: `${name} ${context.name} ${["Website", "AI-Assistent", "Markenauftritt"][index]}`,
                status: ["Neu", "Qualifiziert", "Gespräch"][index],
                cells: {
                  name: (
                    <>
                      <strong>{name} · Demo</strong>
                      <small className="dc-domain-cell-sub">
                        {context.name}
                      </small>
                    </>
                  ),
                  interest: ["Website", "AI-Assistent", "Markenauftritt"][
                    index
                  ],
                  source: [
                    "Website · Demo",
                    "Empfehlung · Demo",
                    "Kontaktformular · Demo",
                  ][index],
                  status: (
                    <Badge tone={["info", "success", "violet"][index] as Tone}>
                      {["Neu", "Qualifiziert", "Gespräch"][index]}
                    </Badge>
                  ),
                },
              }),
            )}
          />
        </Card>
      )}
      {(tab === "offers" || tab === "orders") && (
        <Card
          title={
            tab === "offers"
              ? "Angebote mit klarem Leistungsbild"
              : "Vereinbarte Leistungen"
          }
          actions={
            !portal && (
              <PresentationButton
                title={
                  tab === "offers" ? "Angebot erstellen" : "Auftrag anlegen"
                }
                action={onPreviewAction}
              >
                Neu anlegen
              </PresentationButton>
            )
          }
        >
          <DataTable
            caption={`${tab === "offers" ? "Angebote" : "Aufträge"} · ausschließlich synthetische Daten`}
            columns={[
              { key: "number", label: "Referenz" },
              { key: "project", label: "Projekt & Leistung" },
              { key: "value", label: "Wert netto" },
              { key: "status", label: "Status" },
            ]}
            rows={[
              {
                id: `${context.id}-${tab}-1`,
                search: `${context.name} ${context.project} Website ${websiteSalesStatus}`,
                status: websiteSalesStatus,
                sortValues: { value: 8400 },
                cells: {
                  number: `${tab === "offers" ? "ANG" : "AUF"}-${context.id}-01`,
                  project: `${context.project} · Website & Inhalte`,
                  value: "€ 8.400",
                  status: (
                    <Badge tone="info">
                      {websiteSalesStatus} · Demo
                    </Badge>
                  ),
                },
              },
              {
                id: `${context.id}-${tab}-2`,
                search: `${context.name} AI-Begleitung Assistent ${assistantSalesStatus}`,
                status: assistantSalesStatus,
                sortValues: { value: 490 },
                cells: {
                  number: `${tab === "offers" ? "ANG" : "AUF"}-${context.id}-02`,
                  project: `${context.name} · AI-Begleitung`,
                  value: "€ 490 / Monat",
                  status: (
                    <Badge tone="success">
                      {assistantSalesStatus} · Demo
                    </Badge>
                  ),
                },
              },
            ]}
          />
          <DemoNote>
            Diese Darstellung erzeugt keine verbindlichen Angebote, Aufträge
            oder Abrechnungen.
          </DemoNote>
        </Card>
      )}
      {tab === "subscriptions" && (
        <div className="dc-domain-grid-2">
          <Card
            title="Studio Care"
            eyebrow="BEGLEITUNG, DIE BLEIBT"
            actions={<Badge tone="success">Demo aktiv</Badge>}
          >
            <div className="dc-subscription-price">
              € 490<span>/ Monat netto · Beispielpreis</span>
            </div>
            <p className="dc-domain-muted">
              Website-Betreuung und AI-Begleitung für {context.name}.
            </p>
            {[
              "Website-Pflege & kleine Anpassungen",
              "Ein Projektassistent im Testbetrieb",
              "Wissenspflege & monatliche Abstimmung",
            ].map((item) => (
              <Row
                key={item}
                icon="check"
                title={item}
                detail="Synthetischer Leistungsumfang"
              />
            ))}
            <PresentationButton
              title="Betreuungspaket besprechen"
              action={onPreviewAction}
            >
              Paket besprechen
            </PresentationButton>
          </Card>
          <Card title="Zusammenarbeit im Überblick">
            <DefinitionGrid
              items={[
                ["Arbeitsbereich", context.name],
                ["Projekt", context.project],
                ["Beispielperiode", "01.–31. Oktober 2026"],
                ["Abrechnung", "Nur visualisiert · keine Zahlung"],
                ["Vertragsstatus", "Synthetischer Beispielvertrag"],
                ["Nächste Abstimmung", "23. Oktober 2026 · Demo"],
              ]}
            />
            <DemoNote>
              Kein Vertrag wird abgeschlossen, geändert oder gekündigt.
            </DemoNote>
          </Card>
        </div>
      )}
      {tab === "portal" && (
        <Card title="Ein ruhiger Ort für Ihre Kunden" eyebrow="KUNDENPORTAL">
          <div className="dc-domain-grid-2">
            <div>
              <h2>Zusammenarbeit wird übersichtlich.</h2>
              <p className="dc-domain-muted">
                Die Portalvorschau bündelt Projekte, freigegebene Inhalte und
                die gebuchten Leistungen von {context.name}.
              </p>
              <Row
                icon="building"
                title="Eigene Projekte"
                detail="Sichtbarer Fortschritt und nächste gemeinsame Schritte."
              />
              <Row
                icon="book"
                title="Freigegebene Informationen"
                detail="Kundensicht mit dafür vorgesehenen Beispielinhalten."
              />
              <PresentationButton
                title="Portalzugang einrichten"
                action={onPreviewAction}
              >
                Portalzugang vorbereiten
              </PresentationButton>
            </div>
            <div className="dc-portal-preview">
              <Badge tone="violet">Kundenansicht · Beispiel</Badge>
              <span className="dc-domain-avatar dc-domain-avatar-lg">
                {initials(context.name)}
              </span>
              <h3>Willkommen, {context.name}.</h3>
              <p>Ihr Projekt {context.project} macht Fortschritte.</p>
              <div>
                <Icon name="building" size={19} />
                <span>Projekt in Designphase</span>
                <Badge tone="info">68 % · Demo</Badge>
              </div>
              <div>
                <Icon name="book" size={19} />
                <span>3 freigegebene Inhalte</span>
                <Icon name="check" size={17} />
              </div>
            </div>
          </div>
          <DemoNote>
            Der Portalmodus kann über die Vorschau-Steuerung geöffnet werden. Es
            werden keine Einladungen versendet.
          </DemoNote>
        </Card>
      )}
    </div>
  );
}

export function PropertyArtwork({
  variant = 0,
  label,
}: {
  variant?: number;
  label: string;
}) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      className={`dc-property-art dc-property-art-${variant}`}
      viewBox="0 0 640 360"
      role="img"
      aria-label={`${label} · lokal gezeichnete, synthetische Architekturillustration`}
    >
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="1" y2="1">
          <stop
            stopColor={
              variant === 1
                ? "var(--dc-art-sky-alt)"
                : "var(--dc-art-sky-start)"
            }
          />
          <stop offset="1" stopColor="var(--dc-art-sky-end)" />
        </linearGradient>
        <linearGradient id={`${id}-wall`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--dc-art-wall-start)" />
          <stop offset="1" stopColor="var(--dc-art-wall-end)" />
        </linearGradient>
      </defs>
      <rect width="640" height="360" fill={`url(#${id}-sky)`} />
      <circle cx="517" cy="73" r="42" fill="var(--dc-art-sun)" opacity=".7" />
      <path
        d="M0 278Q95 209 191 263T389 253 640 246V360H0Z"
        fill="var(--dc-art-land-back)"
      />
      <path
        d="M0 308Q160 269 315 303T640 284V360H0Z"
        fill="var(--dc-art-land-front)"
      />
      <path d="m133 155 199-56 170 80v146H133Z" fill={`url(#${id}-wall)`} />
      <path
        d="m332 99 170 80-3 10-167-75-197 54-6-12Z"
        fill="var(--dc-art-wall-light)"
      />
      <path d="m332 114 167 75v136H332Z" fill="var(--dc-art-wall-side)" />
      <path d="m151 174 165-44v52l-165 36Z" fill="var(--dc-art-glass)" />
      <path d="m151 237 165-28v51l-165 23Z" fill="var(--dc-art-glass)" />
      <path d="m351 145 128 57v42l-128-50Z" fill="var(--dc-art-glass-side)" />
      <path d="m351 216 128 47v43l-128-38Z" fill="var(--dc-art-glass-side)" />
      {[193, 236, 278].map((x) => (
        <path
          key={x}
          d={`M${x} ${163 - (x - 151) * 0.26}v115`}
          stroke="var(--dc-art-frame)"
          strokeWidth="5"
        />
      ))}
      <path
        d="m141 226 184-37 163 64M141 289l184-27 163 51"
        stroke="var(--dc-art-balcony)"
        strokeWidth="10"
        fill="none"
      />
      <path d="m330 125 0 191" stroke="var(--dc-art-corner)" strokeWidth="8" />
      <path
        d="M95 327v-75m-15 25 15-38 18 40m-30 10 12-32 18 34M551 329v-93m-25 35 25-59 28 64m-43 13 15-36 20 44"
        stroke="var(--dc-art-tree)"
        strokeWidth="15"
        strokeLinecap="round"
      />
      <path d="m252 360 69-46 120 46" fill="var(--dc-art-path)" />
      <path d="M0 346h640" stroke="var(--dc-art-ground)" strokeWidth="5" />
    </svg>
  );
}

export function PropertiesView(props: DomainViewProps) {
  return (
    <PropertiesInner key={`${props.context.id}:${props.portal}`} {...props} />
  );
}
function PropertiesInner({
  context,
  portal,
  onPreviewAction,
}: DomainViewProps) {
  const [mode, setMode] = useState("gallery");
  const [detail, setDetail] = useState("units");
  const [selection, setSelection] = useState(0);
  const [status, setStatus] = useState("all");
  const projects = [
    context.project,
    `${context.project} · Gartenhöfe`,
    `${context.project} · Stadtvillen`,
  ];
  const propertyTabs = [
    { id: "gallery", label: "Galerie" },
    { id: "table", label: "Tabelle" },
    { id: "projects", label: "Projektansicht" },
    ...(!portal ? [{ id: "pipeline", label: "Pipeline" }] : []),
  ];
  const units = Array.from({ length: 6 }, (_, index) => ({
    id: `${context.id}-unit-${index}`,
    number: index + 1,
    name: `Top 0${index + 1}`,
    rooms: [2, 3, 3, 4, 2, 4][index],
    area: [58, 82, 91, 112, 64, 125][index],
    price: [348000, 492000, 546000, 672000, 384000, 750000][index],
    status: [
      "Verfügbar",
      "Reserviert",
      "Verfügbar",
      "Verkauft",
      "Verfügbar",
      "Reserviert",
    ][index],
  }));
  const filtered = units.filter(
    (unit) => status === "all" || unit.status === status,
  );
  return (
    <div className="dc-domain-view">
      <PageHeading
        eyebrow="EVELYN IMMOBILIEN"
        title={portal ? "Ihr Immobilienprojekt" : "Lebensräume. Klar im Blick."}
        description={`${context.name} · Projekte, Einheiten und Vermarktung in einer gemeinsamen Übersicht.`}
        actions={
          !portal && (
            <PresentationButton
              title="Immobilienprojekt anlegen"
              action={onPreviewAction}
              variant="primary"
            >
              <Icon name="plus" size={16} /> Neues Projekt
            </PresentationButton>
          )
        }
      />
      <ContextLine context={context} portal={portal} />
      {!portal && (
        <div className="dc-domain-metrics">
          <Metric
            label="Demo-Einheiten"
            value="24"
            detail={`${context.project} & Beispielphasen`}
            icon="building"
          />
          <Metric
            label="Verfügbar"
            value="14"
            detail="Synthetischer Vermarktungsstand"
            icon="key"
          />
          <Metric
            label="Demo-Interessenten"
            value="38"
            detail="Erfundene Kontaktdatensätze"
            icon="users"
          />
          <Metric
            label="Besichtigungen"
            value="6"
            detail="Simulierte Termine diese Woche"
            icon="calendar"
          />
        </div>
      )}
      <Tabs
        label="Immobilienansichten"
        items={propertyTabs}
        value={mode}
        onChange={setMode}
      />
      {mode === "gallery" && (
        <div className="dc-property-gallery">
          {projects.map((name, index) => (
            <Card className="dc-property-card" key={name}>
              <div className="dc-property-art-wrap">
                <PropertyArtwork variant={index} label={name} />
                <Badge
                  tone={
                    index === 0 ? "success" : index === 1 ? "info" : "warning"
                  }
                >
                  {["In Vermarktung", "Vorvermarktung", "In Planung"][index]} ·
                  Demo
                </Badge>
                <span>LOKALE ILLUSTRATION</span>
              </div>
              <div className="dc-property-card-body">
                <div className="dc-domain-eyebrow">WOHNEN MIT PERSPEKTIVE</div>
                <h2>{name}</h2>
                <p>
                  <Icon name="pin" size={14} /> Wien · synthetischer
                  Beispielstandort
                </p>
                <div className="dc-property-facts">
                  <div>
                    <strong>{[12, 8, 4][index]}</strong>
                    <span>Einheiten</span>
                  </div>
                  <div>
                    <strong>{[7, 5, 2][index]}</strong>
                    <span>verfügbar · Demo</span>
                  </div>
                  <div>
                    <strong>{["58–125", "64–118", "92–155"][index]} m²</strong>
                    <span>Wohnfläche</span>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSelection(index);
                    setMode("projects");
                  }}
                >
                  Projekt entdecken <Icon name="arrow" size={16} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {mode === "table" && (
        <Card title={`Einheiten · ${context.project}`}>
          <div className="dc-domain-filter-row">
            <label>
              Status
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="all">Alle Status</option>
                <option>Verfügbar</option>
                <option>Reserviert</option>
                <option>Verkauft</option>
              </select>
            </label>
            <DemoNote>
              Preise und Verfügbarkeiten sind synthetisch und unverbindlich.
            </DemoNote>
          </div>
          <DataTable
            caption={`Beispielhafte Einheiten · ${context.project}`}
            columns={[
              { key: "unit", label: "Einheit" },
              { key: "project", label: "Projekt" },
              { key: "rooms", label: "Zimmer" },
              { key: "area", label: "Wohnfläche" },
              { key: "price", label: "Beispielpreis" },
              { key: "status", label: "Status" },
            ]}
            rows={filtered.map((unit) => ({
              id: unit.id,
              search: `${unit.name} ${context.project} ${unit.status}`,
              status: unit.status,
              sortValues: { unit: unit.number, rooms: unit.rooms, area: unit.area, price: unit.price },
              cells: {
                unit: unit.name,
                project: context.project,
                rooms: unit.rooms,
                area: `${unit.area} m²`,
                price: `€ ${unit.price.toLocaleString("de-AT")}`,
                status: (
                  <Badge
                    tone={
                      unit.status === "Verfügbar"
                        ? "success"
                        : unit.status === "Reserviert"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {unit.status} · Demo
                  </Badge>
                ),
              },
            }))}
          />
        </Card>
      )}
      {mode === "projects" && (
        <div className="dc-domain-stack">
          <Card className="dc-property-detail">
            <PropertyArtwork variant={selection} label={projects[selection]} />
            <div>
              <Badge tone="success">In Vermarktung · Demo</Badge>
              <h2>{projects[selection]}</h2>
              <p>
                Durchdachte Architektur, helle Räume und ein neues Gefühl von
                Zuhause. Ein synthetisches Wohnprojekt im Kontext von{" "}
                {context.name}.
              </p>
              <DefinitionGrid
                items={[
                  ["Standort", "Wien · Beispieladresse"],
                  ["Einheiten", `${[12, 8, 4][selection]} Beispielwohnungen`],
                  ["Projektphase", "Vermarktung · simuliert"],
                  ["Übergabe", "Frühjahr 2027 · Beispieldatum"],
                ]}
              />
              <label className="dc-domain-project-select">
                Projekt auswählen
                <select
                  value={selection}
                  onChange={(event) => setSelection(Number(event.target.value))}
                >
                  {projects.map((name, index) => (
                    <option value={index} key={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Card>
          <Card>
            <Tabs
              label="Projektinformationen"
              items={[
                { id: "units", label: "Einheiten" },
                ...(!portal
                  ? [
                      { id: "interest", label: "Interessenten" },
                      { id: "viewings", label: "Besichtigungen" },
                      { id: "campaigns", label: "Kampagnen" },
                    ]
                  : [{ id: "documents", label: "Projektunterlagen" }]),
              ]}
              value={detail}
              onChange={setDetail}
            />
            {detail === "units" && (
              <DataTable
                caption={`Synthetischer Einheitenstand · ${projects[selection]}`}
                columns={[
                  { key: "unit", label: "Einheit" },
                  { key: "rooms", label: "Zimmer" },
                  { key: "area", label: "Fläche" },
                  { key: "status", label: "Status" },
                ]}
                rows={units.map((unit) => ({
                  id: `${unit.id}-${selection}`,
                  search: `${unit.name} ${projects[selection]} ${unit.status}`,
                  status: unit.status,
                  sortValues: { unit: unit.number, rooms: unit.rooms, area: unit.area },
                  cells: {
                    unit: unit.name,
                    rooms: unit.rooms,
                    area: `${unit.area} m²`,
                    status: (
                      <Badge
                        tone={
                          unit.status === "Verfügbar"
                            ? "success"
                            : unit.status === "Reserviert"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {unit.status} · Demo
                      </Badge>
                    ),
                  },
                }))}
              />
            )}
            {detail === "interest" && (
              <>
                {["Mara Berger", "Felix Sommer", "Lena Winter"].map(
                  (person, index) => (
                    <Row
                      key={person}
                      icon="users"
                      title={`${person} · synthetisch`}
                      detail={`${projects[selection]} · Interesse an Top 0${index + 1} · ${context.id}-${index}@example.com`}
                      end={
                        <Badge tone={index === 0 ? "info" : "violet"}>
                          {index === 0 ? "Neu" : "In Betreuung"} · Demo
                        </Badge>
                      }
                    />
                  ),
                )}
                <PresentationButton
                  title="Interessent erfassen"
                  action={onPreviewAction}
                >
                  Interessent erfassen
                </PresentationButton>
              </>
            )}
            {detail === "viewings" && (
              <>
                {[
                  "21. Oktober · 10:00",
                  "22. Oktober · 14:30",
                  "23. Oktober · 11:00",
                ].map((date, index) => (
                  <Row
                    key={date}
                    icon="calendar"
                    title={`${date} · Beispieldatum`}
                    detail={`${projects[selection]} · Top 0${index + 1} · ${["Mara Berger", "Felix Sommer", "Lena Winter"][index]} (Demo)`}
                    end={
                      <Badge tone={index === 0 ? "success" : "warning"}>
                        {index === 0 ? "Bestätigt" : "Angefragt"} · Demo
                      </Badge>
                    }
                  />
                ))}
                <PresentationButton
                  title="Besichtigung planen"
                  action={onPreviewAction}
                >
                  Besichtigung planen
                </PresentationButton>
              </>
            )}
            {detail === "campaigns" && (
              <div className="dc-domain-grid-2">
                {["Projektstart", "Wohnen im Grünen"].map((title, index) => (
                  <div key={title} className="dc-campaign-card">
                    <span className="dc-domain-icon">
                      <Icon name="globe" size={21} />
                    </span>
                    <h3>
                      {projects[selection]} · {title}
                    </h3>
                    <p>
                      {index === 0
                        ? "Website & Newsletter"
                        : "Social Media & Projektseite"}{" "}
                      · Beispielkampagne
                    </p>
                    <Badge tone={index === 0 ? "info" : "warning"}>
                      {index === 0 ? "In Vorbereitung" : "Entwurf"} · Demo
                    </Badge>
                    <PresentationButton
                      title="Kampagne ansehen"
                      action={onPreviewAction}
                    >
                      Kampagne ansehen
                    </PresentationButton>
                  </div>
                ))}
              </div>
            )}
            {detail === "documents" && (
              <>
                <Row
                  icon="file"
                  title={`${projects[selection]} · Projektbroschüre`}
                  detail="Freigegebener synthetischer Inhalt · kein echtes Exposé"
                  end={<Badge tone="success">Beispielinhalt</Badge>}
                />
                <PresentationButton
                  title="Projektunterlage öffnen"
                  action={onPreviewAction}
                >
                  Unterlage ansehen
                </PresentationButton>
              </>
            )}
            <DemoNote>
              Keine Echtzeitverfügbarkeit, Buchung, Kontaktaufnahme oder
              Kampagnenausspielung.
            </DemoNote>
          </Card>
        </div>
      )}
      {mode === "pipeline" && !portal && (
        <div className="dc-domain-pipeline">
          {["Neu", "Qualifiziert", "Besichtigung", "Reservierung"].map(
            (title, index) => (
              <div className="dc-pipeline-column" key={title}>
                <div className="dc-domain-section-head">
                  <h3>{title}</h3>
                  <Badge tone="neutral">1</Badge>
                </div>
                <Card>
                  <Badge tone={index === 3 ? "success" : "info"}>
                    Synthetischer Lead
                  </Badge>
                  <h3>
                    {
                      [
                        "Mara Berger",
                        "Felix Sommer",
                        "Lena Winter",
                        "Noah Hartmann",
                      ][index]
                    }
                  </h3>
                  <p>
                    {context.project} · Top 0{index + 1}
                  </p>
                  <Row
                    icon="building"
                    title={`${[58, 82, 91, 112][index]} m² · ${index > 1 ? 3 : 2} Zimmer`}
                    detail={`${context.name} · Demo-Kontext`}
                  />
                  <PresentationButton
                    title="Interessentenkarte öffnen"
                    action={onPreviewAction}
                  >
                    Details <Icon name="arrow" size={14} />
                  </PresentationButton>
                </Card>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function AssistantsView(props: DomainViewProps) {
  return (
    <AssistantsInner key={`${props.context.id}:${props.portal}`} {...props} />
  );
}
function AssistantsInner({
  context,
  portal,
  onPreviewAction,
}: DomainViewProps) {
  const [selected, setSelected] = useState(0);
  const [tab, setTab] = useState("overview");
  const [assistantName, setAssistantName] = useState(
    `${context.name} Projektberater`,
  );
  const [voice, setVoice] = useState("Freundlich & klar");
  const labels = [
    "Projektberater",
    "Website-Begleiter",
    "Service-Assistent",
    "Vertriebsbegleiter",
    "Projekt-Concierge",
  ];
  const states = ["Aktiv", "Inaktiv", "Test", "Einrichtung", "Fehler"];
  const tones: Tone[] = ["success", "neutral", "violet", "warning", "danger"];
  const name = `${context.name} ${labels[selected]}`;
  const tabs = portal
    ? assistantTabs.filter((item) =>
        ["overview", "sources", "conversations", "subscription"].includes(
          item.id,
        ),
      )
    : assistantTabs;
  return (
    <div className="dc-domain-view">
      <PageHeading
        eyebrow="EVELYN ASSISTENTEN"
        title={
          portal
            ? "Ihre digitalen Begleiter"
            : "Hilfreich. Im richtigen Kontext."
        }
        description={`Assistenten für ${context.name}: mit einer klaren Aufgabe, passendem Wissen und einem eigenen Charakter.`}
        actions={
          !portal && (
            <PresentationButton
              title="Assistenten einrichten"
              action={onPreviewAction}
              variant="primary"
            >
              <Icon name="plus" size={16} /> Neuer Assistent
            </PresentationButton>
          )
        }
      />
      <ContextLine context={context} portal={portal} />
      {!portal && (
        <div className="dc-assistant-status-strip">
          {states.map((status, index) => (
            <span key={status}>
              <Badge tone={tones[index]}>{status} · Demo</Badge>
              <small>1 synthetischer Assistent</small>
            </span>
          ))}
        </div>
      )}
      <div className="dc-assistant-layout">
        <Card
          title={portal ? "Ihre Assistenten" : "Assistenten auswählen"}
          className="dc-assistant-directory"
        >
          {labels.slice(0, portal ? 1 : 5).map((label, index) => (
            <button
              key={label}
              className={`dc-assistant-select ${selected === index ? "is-selected" : ""}`}
              onClick={() => {
                setSelected(index);
                setTab("overview");
                setAssistantName(`${context.name} ${label}`);
              }}
              aria-pressed={selected === index}
            >
              <span className={`dc-assistant-orb dc-orb-${index}`}>
                <Icon name="sparkles" size={21} />
              </span>
              <span>
                <strong>{label}</strong>
                <small>{context.name}</small>
                <Badge tone={tones[index]}>{states[index]} · Demo</Badge>
              </span>
            </button>
          ))}
          <DemoNote>Alle Status sind simuliert.</DemoNote>
        </Card>
        <Card className="dc-assistant-profile">
          <div className="dc-assistant-profile-head">
            <span
              className={`dc-assistant-orb dc-assistant-orb-lg dc-orb-${selected}`}
            >
              <Icon name="sparkles" size={32} />
            </span>
            <div>
              <div className="dc-domain-eyebrow">
                IHR DIGITALER BEGLEITER · DEMO
              </div>
              <h2>{name}</h2>
              <p>
                Orientierung geben. Fragen verstehen. Menschen weiterhelfen.
              </p>
            </div>
            <Badge tone={tones[selected]}>{states[selected]} · Demo</Badge>
          </div>
          <Tabs
            label="Assistentenbereiche"
            items={tabs}
            value={tab}
            onChange={setTab}
          />
          <div className="dc-assistant-panel">
            {tab === "overview" && (
              <>
                <div className="dc-domain-callout">
                  <Icon name="sparkles" size={22} />
                  <div>
                    <strong>Eine klare Aufgabe. Ein vertrauter Kontext.</strong>
                    <p>
                      {name} begleitet Besucher beispielhaft durch{" "}
                      {context.project} und gibt Orientierung anhand
                      freigegebener Demo-Inhalte.
                    </p>
                  </div>
                </div>
                <DefinitionGrid
                  items={[
                    ["Arbeitsbereich", context.name],
                    ["Projektkontext", context.project],
                    ["Aufgabe", "Projektfragen & erste Orientierung"],
                    ["Sprache", "Deutsch · Beispielkonfiguration"],
                    ["Wissensstand", "3 synthetische, freigegebene Quellen"],
                    ["Kanal", "Website-Widget · nicht verbunden"],
                  ]}
                />
                {selected === 4 && !portal && (
                  <div className="dc-domain-error">
                    <Icon name="info" size={19} />
                    <div>
                      <strong>Simulierter Verbindungsfehler</strong>
                      <p>
                        Eine Beispielquelle ist als nicht erreichbar markiert.
                        Es wurde kein externer Dienst kontaktiert.
                      </p>
                    </div>
                  </div>
                )}
                <PresentationButton
                  title="Assistent im Vorschau-Chat testen"
                  action={onPreviewAction}
                >
                  Assistenten testen <Icon name="chat" size={16} />
                </PresentationButton>
                <DemoNote>
                  Es läuft kein AI-Modell. Ein Test öffnet lediglich die
                  Erklärung zur Designvorschau.
                </DemoNote>
              </>
            )}
            {tab === "configuration" && !portal && (
              <>
                <div className="dc-domain-form-grid">
                  <label>
                    Anzeigename
                    <input
                      value={assistantName}
                      onChange={(event) => setAssistantName(event.target.value)}
                    />
                  </label>
                  <label>
                    Tonalität
                    <select
                      value={voice}
                      onChange={(event) => setVoice(event.target.value)}
                    >
                      <option>Freundlich & klar</option>
                      <option>Ruhig & beratend</option>
                      <option>Präzise & professionell</option>
                    </select>
                  </label>
                  <label className="dc-domain-form-wide">
                    Aufgabe
                    <textarea
                      defaultValue={`Hilf Interessenten, ${context.project} zu verstehen. Verwende ausschließlich die freigegebenen Beispielinformationen von ${context.name}.`}
                      rows={4}
                    />
                  </label>
                  <label>
                    Sprache
                    <select defaultValue="de">
                      <option value="de">Deutsch</option>
                      <option value="en">Englisch</option>
                    </select>
                  </label>
                  <label>
                    Beispielkanal
                    <select defaultValue="website">
                      <option value="website">Website-Widget</option>
                      <option value="portal">Kundenportal</option>
                    </select>
                  </label>
                </div>
                <DemoNote>
                  Änderungen bleiben nur im geöffneten Formular. Es gibt keine
                  Speicherung oder produktive Konfiguration.
                </DemoNote>
                <PresentationButton
                  title="Konfigurationsentwurf speichern"
                  action={onPreviewAction}
                  variant="primary"
                >
                  Entwurf speichern
                </PresentationButton>
              </>
            )}
            {tab === "sources" && (
              <>
                <h3>Wissen, auf das sich der Assistent bezieht</h3>
                <Row
                  icon="building"
                  title={`${context.name} · Unternehmensprofil`}
                  detail="Version 2.1 · synthetischer freigegebener Stand"
                  end={<Badge tone="success">Freigegeben · Demo</Badge>}
                />
                <Row
                  icon="file"
                  title={`${context.project} · Projektinformationen`}
                  detail="Version 1.2 · synthetischer freigegebener Stand"
                  end={<Badge tone="success">Freigegeben · Demo</Badge>}
                />
                <Row
                  icon="book"
                  title={`${context.project} · Fragen & Antworten`}
                  detail="Version 1.0 · synthetischer freigegebener Stand"
                  end={<Badge tone="success">Freigegeben · Demo</Badge>}
                />
                {!portal && (
                  <PresentationButton
                    title="Wissensquelle zuordnen"
                    action={onPreviewAction}
                  >
                    Quelle zuordnen
                  </PresentationButton>
                )}
                <DemoNote>
                  Kein Dokument wurde eingelesen und kein Modell mit diesen
                  Daten verbunden.
                </DemoNote>
              </>
            )}
            {tab === "conversations" && (
              <>
                <div className="dc-demo-conversation">
                  <div>
                    <span>Besucher · synthetisches Beispiel</span>
                    <p>Welche Wohnungen gibt es bei {context.project}?</p>
                  </div>
                  <div>
                    <span>{name} · vorformulierter Beispieltext</span>
                    <p>
                      Gerne gebe ich Ihnen einen ersten Überblick zu{" "}
                      {context.project}. In diesem Beispiel stehen
                      unterschiedliche Grundrisse zwischen 58 und 125 m² zur
                      Auswahl. Die Angaben sind synthetisch und unverbindlich.
                    </p>
                  </div>
                  <div>
                    <span>Besucher · synthetisches Beispiel</span>
                    <p>Kann ich einen Besichtigungstermin vereinbaren?</p>
                  </div>
                  <div>
                    <span>{name} · vorformulierter Beispieltext</span>
                    <p>
                      In einer produktiven Anwendung könnte das Team von{" "}
                      {context.name} Ihre Anfrage übernehmen. Diese
                      Designvorschau nimmt keine Anfragen entgegen und bucht
                      keine Termine.
                    </p>
                  </div>
                </div>
                <DemoNote>
                  Vollständig vorformulierter Dialog. Keine echten Personen,
                  gespeicherten Chats oder AI-Antworten.
                </DemoNote>
              </>
            )}
            {tab === "statistics" && !portal && (
              <>
                <div className="dc-domain-metrics dc-domain-metrics-3">
                  <Metric
                    label="Demo-Gespräche"
                    value="124"
                    detail="Simulierter Monatswert"
                    icon="chat"
                  />
                  <Metric
                    label="Beispielauflösung"
                    value="86 %"
                    detail="Keine gemessene AI-Qualität"
                    icon="check"
                  />
                  <Metric
                    label="Demo-Weitergaben"
                    value="18"
                    detail="Synthetischer Beispielwert"
                    icon="arrow"
                  />
                </div>
                <h3>Themen im Beispielmonat</h3>
                {[
                  ["Projekt & Lage", 74],
                  ["Verfügbarkeit & Grundrisse", 56],
                  ["Besichtigung & Kontakt", 32],
                ].map(([label, value]) => (
                  <div className="dc-domain-progress" key={label}>
                    <span>
                      {label}
                      <strong>{value} % · Demo</strong>
                    </span>
                    <div>
                      <i style={{ width: `${value}%` }} />
                    </div>
                  </div>
                ))}
                <DemoNote>
                  Alle Kennzahlen sind erfunden; es findet kein Tracking statt.
                </DemoNote>
              </>
            )}
            {tab === "integrations" && !portal && (
              <>
                <Row
                  icon="globe"
                  title="Website-Widget"
                  detail={`${context.id}.example.com · synthetische Beispieldomain`}
                  end={<Badge tone="neutral">Nicht verbunden</Badge>}
                />
                <Row
                  icon="users"
                  title="CRM-Übergabe"
                  detail="Kontaktübergabe an das Team · nur als Produktidee dargestellt"
                  end={<Badge tone="neutral">Nicht verbunden</Badge>}
                />
                <Row
                  icon="calendar"
                  title="Terminwünsche"
                  detail="Anfrageprozess ohne angebundenen Kalender"
                  end={<Badge tone="neutral">Nicht verbunden</Badge>}
                />
                <PresentationButton
                  title="Integration vorbereiten"
                  action={onPreviewAction}
                >
                  Anbindung vorbereiten
                </PresentationButton>
                <DemoNote>
                  Keine Zugangsdaten, API-Schlüssel oder externen Dienste werden
                  verwendet.
                </DemoNote>
              </>
            )}
            {tab === "subscription" && (
              <>
                <div className="dc-domain-section-head">
                  <div>
                    <div className="dc-domain-eyebrow">
                      BETREUUNGSPAKET · SYNTHETISCH
                    </div>
                    <h3>AI Companion</h3>
                  </div>
                  <Badge tone="success">Demo aktiv</Badge>
                </div>
                <div className="dc-subscription-price">
                  € 190<span>/ Monat netto · Beispielpreis</span>
                </div>
                <DefinitionGrid
                  items={[
                    ["Zugeordnet zu", context.name],
                    ["Projekt", context.project],
                    ["Enthalten", "1 Projektassistent · Beispielumfang"],
                    ["Betreuung", "Wissenspflege & Abstimmung"],
                    ["Beispielperiode", "Oktober 2026"],
                    ["Zahlung", "Keine Zahlungsfunktion verbunden"],
                  ]}
                />
                <PresentationButton
                  title="Assistentenpaket besprechen"
                  action={onPreviewAction}
                >
                  Paket besprechen
                </PresentationButton>
                <DemoNote>
                  Keine Buchung, Zahlung oder Vertragsänderung.
                </DemoNote>
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** A display-only projection. An authorized adapter can supply these fields later. */
export type KnowledgeSourcePresentation = {
  id: string;
  name: string;
  version: string;
  status: "Entwurf" | "Freigegeben";
};
export function KnowledgeSourceList({
  sources,
  onOpen,
}: {
  sources: KnowledgeSourcePresentation[];
  onOpen: (source: KnowledgeSourcePresentation) => void;
}) {
  return (
    <>
      {sources.map((source) => (
        <div className="dc-knowledge-source" key={source.id}>
          <span className="dc-domain-icon">
            <Icon name="file" size={20} />
          </span>
          <div>
            <strong>{source.name}</strong>
            <small>
              {source.status === "Entwurf"
                ? "Lokaler Beispielentwurf · noch nicht zur Nutzung freigegeben"
                : "Geprüfter Beispielstand · Freigabe ausschließlich simuliert"}
            </small>
            <span className="dc-knowledge-version">
              Version {source.version} · synthetisch
            </span>
          </div>
          <Badge tone={source.status === "Entwurf" ? "warning" : "success"}>
            {source.status} · Demo
          </Badge>
          <Button variant="ghost" onClick={() => onOpen(source)}>
            <Icon name="arrow" size={16} />
            <span className="dc-domain-sr-only">{source.name} ansehen</span>
          </Button>
        </div>
      ))}
    </>
  );
}

export function KnowledgeView(props: DomainViewProps) {
  return (
    <KnowledgeInner key={`${props.context.id}:${props.portal}`} {...props} />
  );
}
function KnowledgeInner({ context, portal, onPreviewAction }: DomainViewProps) {
  const [category, setCategory] = useState("company");
  const [tab, setTab] = useState("sources");
  const [sourceFilter, setSourceFilter] = useState("all");
  const categories = [
    {
      id: "company",
      name: "Unternehmenswissen",
      icon: "building",
      detail: context.name,
      count: 4,
    },
    {
      id: "project",
      name: "Projektwissen",
      icon: "layers",
      detail: context.project,
      count: 6,
    },
    {
      id: "website",
      name: "Website-Inhalte",
      icon: "globe",
      detail: "Seiten & strukturierte Inhalte",
      count: 3,
    },
    {
      id: "documents",
      name: "Dokumente",
      icon: "file",
      detail: "Broschüren & Unterlagen",
      count: 5,
    },
    ...(!portal
      ? [
          {
            id: "ai",
            name: "AI-Wissen",
            icon: "sparkles",
            detail: "Antworten & Kontextbausteine",
            count: 3,
          },
          {
            id: "scans",
            name: "Website-Scans",
            icon: "search",
            detail: "Simulierte Scan-Ergebnisse",
            count: 2,
          },
          {
            id: "suggestions",
            name: "AI-Vorschläge",
            icon: "sparkles",
            detail: "Zur redaktionellen Prüfung",
            count: 2,
          },
        ]
      : []),
  ];
  const current =
    categories.find((item) => item.id === category) || categories[0];
  const sourceNames: Record<string, string[]> = {
    company: [
      `${context.name} · Unternehmensprofil`,
      `${context.name} · Leistungen & Werte`,
      `${context.name} · Kontakt & Team`,
    ],
    project: [
      `${context.project} · Projektbeschreibung`,
      `${context.project} · Lage & Umgebung`,
      `${context.project} · Ausstattung`,
    ],
    website: [
      `${context.project} · Startseite`,
      `${context.project} · Projektseite`,
      `${context.name} · Kontaktseite`,
    ],
    documents: [
      `${context.project} · Projektbroschüre.pdf`,
      `${context.project} · Ausstattungsübersicht.pdf`,
      `${context.project} · Lageplan.pdf`,
    ],
    ai: [
      `${context.project} · Häufige Fragen`,
      `${context.name} · Tonalitätsleitfaden`,
      `${context.project} · Antwortbausteine`,
    ],
    scans: [
      `${context.id}.example.com · Projektseite`,
      `${context.id}.example.com · Kontaktseite`,
    ],
    suggestions: [
      `${context.project} · Lagebeschreibung präzisieren`,
      `${context.name} · Kontaktinformationen ergänzen`,
    ],
  };
  const sources = (sourceNames[category] || sourceNames.company)
    .map((name, index) => ({
      id: `${context.id}-${category}-${index}`,
      name,
      status: index === 1 ? ("Entwurf" as const) : ("Freigegeben" as const),
      version: index === 1 ? "1.3" : index === 0 ? "2.1" : "1.0",
    }))
    .filter((source) =>
      portal
        ? source.status === "Freigegeben"
        : sourceFilter === "all" || source.status === sourceFilter,
    );
  return (
    <div className="dc-domain-view">
      <PageHeading
        eyebrow="DAS WISSEN HINTER EVELYN"
        title={
          portal ? "Ihr freigegebenes Wissen" : "Gutes Wissen. Gute Antworten."
        }
        description={`${context.name} · Informationen strukturiert sammeln, redaktionell prüfen und nachvollziehbar weiterentwickeln.`}
        actions={
          !portal && (
            <PresentationButton
              title="Wissensquelle hinzufügen"
              action={onPreviewAction}
              variant="primary"
            >
              <Icon name="plus" size={16} /> Wissen hinzufügen
            </PresentationButton>
          )
        }
      />
      <ContextLine context={context} portal={portal} />
      {!portal && (
        <div className="dc-knowledge-flow">
          <span>
            <Icon name="file" size={16} /> Entwurf
          </span>
          <Icon name="arrow" size={15} />
          <span>
            <Icon name="users" size={16} /> Redaktionelle Prüfung
          </span>
          <Icon name="arrow" size={15} />
          <span>
            <Icon name="check" size={16} /> Freigegebene Version
          </span>
          <small>
            Alle Zustände sind simuliert. Veröffentlichen ist nicht verbunden.
          </small>
        </div>
      )}
      <div className="dc-knowledge-layout">
        <Card className="dc-knowledge-tree" title="Wissensbereiche">
          {categories.map((item) => (
            <button
              key={item.id}
              className={category === item.id ? "is-selected" : ""}
              onClick={() => {
                setCategory(item.id);
                setTab("sources");
                setSourceFilter("all");
              }}
              aria-pressed={category === item.id}
            >
              <Icon name={item.icon} size={20} />
              <span>
                <strong>{item.name}</strong>
                <small>{item.detail}</small>
              </span>
              <Badge tone="neutral">{portal ? "2" : item.count}</Badge>
            </button>
          ))}
          <DemoNote>
            {portal
              ? "Synthetische, für Kunden bestimmte Beispielinhalte."
              : "Ein universeller Wissensraum für Unternehmen, Projekte, Websites und AI."}
          </DemoNote>
        </Card>
        <div className="dc-domain-stack">
          <Card className="dc-knowledge-intro">
            <div>
              <span className="dc-domain-icon">
                <Icon name={current.icon} size={23} />
              </span>
              <div>
                <div className="dc-domain-eyebrow">
                  {portal ? "KUNDENINHALTE · DEMO" : "AKTIVER WISSENSKONTEXT"}
                </div>
                <h2>{current.name}</h2>
                <p>{current.detail}</p>
              </div>
            </div>
            <Badge tone="violet">
              {portal ? "Freigegebene Beispiele" : "Redaktionell begleitet"}
            </Badge>
          </Card>
          <Card>
            <div className="dc-domain-section-head">
              <h3>
                {category === "scans"
                  ? "Simulierte Website-Erfassung"
                  : category === "suggestions"
                    ? "Redaktionelle Vorschläge"
                    : "Quellen & Inhalte"}
              </h3>
              {!portal && (
                <label className="dc-knowledge-filter">
                  Ansicht
                  <select
                    aria-label="Wissensstatus filtern"
                    value={sourceFilter}
                    onChange={(event) => setSourceFilter(event.target.value)}
                  >
                    <option value="all">Alle Stände</option>
                    <option>Freigegeben</option>
                    <option>Entwurf</option>
                  </select>
                </label>
              )}
            </div>
            {!portal && (
              <Tabs
                label="Wissensverwaltung"
                items={[
                  { id: "sources", label: "Quellen" },
                  { id: "versions", label: "Versionen" },
                  { id: "approvals", label: "Freigaben" },
                ]}
                value={tab}
                onChange={setTab}
              />
            )}
            {tab === "sources" && (
              <>
                {category === "scans" && !portal && (
                  <div className="dc-domain-callout">
                    <Icon name="globe" size={20} />
                    <div>
                      <strong>Scan-Vorschau ohne Netzwerkzugriff</strong>
                      <p>
                        Diese Ergebnisse sind vorbereitet. Es wird keine Website
                        gecrawlt und kein Inhalt übernommen.
                      </p>
                    </div>
                  </div>
                )}
                {category === "suggestions" && !portal ? (
                  <>
                    {sourceNames.suggestions.map((name, index) => (
                      <div key={name} className="dc-knowledge-suggestion">
                        <Badge tone="violet">Synthetischer AI-Vorschlag</Badge>
                        <h3>{name}</h3>
                        <p>
                          {index === 0
                            ? `Für ${context.project} könnte eine kurze Beschreibung der Wege und Anbindungen ergänzt werden. Alle Aussagen müssen vor einer Freigabe fachlich geprüft werden.`
                            : `Die Kontaktmöglichkeiten für ${context.name} könnten an einer Stelle zusammengeführt werden. Es wurden keine echten Kontaktdaten geprüft.`}
                        </p>
                        <PresentationButton
                          title="Vorschlag als Entwurf übernehmen"
                          action={onPreviewAction}
                        >
                          Als Entwurf prüfen <Icon name="arrow" size={14} />
                        </PresentationButton>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <KnowledgeSourceList
                      sources={sources}
                      onOpen={(source) =>
                        onPreviewAction(
                          `${source.name} · Version ${source.version}`,
                        )
                      }
                    />
                    {sources.length === 0 && (
                      <EmptyState title="Keine Beispielquellen für diesen Filter">
                        Wählen Sie einen anderen Status, um die synthetischen
                        Quellen zu sehen.
                      </EmptyState>
                    )}
                  </>
                )}
                {!portal && (
                  <div className="dc-knowledge-upload">
                    <Icon name="upload" size={24} />
                    <strong>Ein Ort für Dokumente und neue Perspektiven</strong>
                    <p>
                      Datei-Upload, Website-Import und Texteingabe sind hier als
                      künftige Schnittstellen dargestellt.
                    </p>
                    <PresentationButton
                      title="Dokument hinzufügen"
                      action={onPreviewAction}
                    >
                      Dokument hinzufügen
                    </PresentationButton>
                  </div>
                )}
              </>
            )}
            {tab === "versions" && !portal && (
              <>
                <div className="dc-domain-timeline">
                  {[
                    {
                      version: "2.1",
                      title: "Freigegebener Beispielstand",
                      detail: `Unternehmensprofil und Projektbezug von ${context.name} redaktionell abgestimmt.`,
                      badge: "Freigegeben · Demo",
                      tone: "success" as Tone,
                    },
                    {
                      version: "2.2",
                      title: "Neuer Entwurf",
                      detail: `Ergänzungen zu ${context.project} gesammelt. Dieser Stand ist noch nicht freigegeben.`,
                      badge: "Entwurf",
                      tone: "warning" as Tone,
                    },
                    {
                      version: "2.0",
                      title: "Vorherige Version",
                      detail:
                        "Historischer, synthetischer Inhaltsstand für einen nachvollziehbaren Verlauf.",
                      badge: "Archiviert · Demo",
                      tone: "neutral" as Tone,
                    },
                  ].map((item) => (
                    <div key={item.version}>
                      <span />
                      <div>
                        <small>Version {item.version} · synthetisch</small>
                        <strong>{item.title}</strong>
                        <p>{item.detail}</p>
                        <Badge tone={item.tone}>{item.badge}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
                <DemoNote>
                  Ein Entwurf verändert die freigegebene Version erst nach einer
                  späteren, produktiven Freigabe. Hier gibt es keine Speicherung
                  oder Veröffentlichung.
                </DemoNote>
              </>
            )}
            {tab === "approvals" && !portal && (
              <>
                <div className="dc-domain-callout">
                  <Icon name="shield" size={22} />
                  <div>
                    <strong>
                      Wissen braucht einen bewussten Freigabeschritt.
                    </strong>
                    <p>
                      Die geprüfte Version bleibt erkennbar. Neue Inhalte liegen
                      zunächst als Entwurf vor.
                    </p>
                  </div>
                </div>
                <Row
                  icon="file"
                  title={`${context.project} · Lage & Umgebung`}
                  detail="Version 1.3 · Entwurf · zur fachlichen Prüfung vorgesehen"
                  end={<Badge tone="warning">Prüfung offen · Demo</Badge>}
                />
                <Row
                  icon="file"
                  title={`${context.name} · Unternehmensprofil`}
                  detail="Version 2.1 · durch Demo-Redaktion geprüft"
                  end={<Badge tone="success">Freigegeben · Demo</Badge>}
                />
                <PresentationButton
                  title="Freigabe vorbereiten"
                  action={onPreviewAction}
                >
                  Freigabe vorbereiten <Icon name="check" size={16} />
                </PresentationButton>
                <DemoNote>
                  Diese Schaltfläche erklärt den vorgesehenen Prozess. Sie
                  erteilt keine Freigabe und veröffentlicht keine Inhalte.
                </DemoNote>
              </>
            )}
          </Card>
          <div className="dc-domain-note dc-knowledge-footnote">
            <Icon name="shield" size={16} />
            <span>
              {portal
                ? `Nur synthetische Kundeninhalte für ${context.name}.`
                : "Verlässliche Antworten beginnen bei gepflegten Quellen. Entwürfe, Versionen und Freigaben bleiben getrennt sichtbar."}
            </span>
            <Badge tone="neutral">Designvorschau</Badge>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PortalOverview({ context, onPreviewAction }: DomainViewProps) {
  return (
    <div className="dc-domain-view">
      <PageHeading
        eyebrow="IHR EVELYN KUNDENPORTAL"
        title={`Willkommen, ${context.name}.`}
        description="Ihre Projekte, Ihre Leistungen und der nächste gemeinsame Schritt. Eine synthetische Kundensicht."
      />
      <div className="dc-portal-welcome">
        <span className="dc-assistant-orb dc-assistant-orb-lg">
          <Icon name="sparkles" size={30} />
        </span>
        <div>
          <Badge tone="violet">Portalvorschau · synthetisch</Badge>
          <h2>Schön, dass wir gemeinsam gestalten.</h2>
          <p>
            Hier finden Sie die für {context.name} vorgesehenen Beispielinhalte
            zu {context.project}.
          </p>
        </div>
      </div>
      <div className="dc-domain-grid-2">
        <Card
          title={context.project}
          eyebrow="IHR PROJEKT"
          actions={<Badge tone="info">Designphase · Demo</Badge>}
        >
          <PropertyArtwork label={context.project} />
          <div className="dc-domain-progress">
            <span>
              Beispielhafter Projektstand<strong>68 %</strong>
            </span>
            <div>
              <i style={{ width: "68%" }} />
            </div>
          </div>
          <p className="dc-domain-muted">
            Als Nächstes stimmen wir gemeinsam Design und Projektinhalte ab.
          </p>
          <PresentationButton
            title="Projektbesprechung anfragen"
            action={onPreviewAction}
          >
            Projektbesprechung anfragen <Icon name="calendar" size={15} />
          </PresentationButton>
        </Card>
        <div className="dc-domain-stack">
          <Card title="Ihre Leistungen">
            <Row
              icon="globe"
              title="Website & digitale Präsenz"
              detail={`${context.project} · Entwurf in Abstimmung`}
              end={<Badge tone="info">In Arbeit · Demo</Badge>}
            />
            <Row
              icon="sparkles"
              title="Projektassistent"
              detail="Kundenorientierung mit freigegebenen Beispielinhalten"
              end={<Badge tone="success">Demo aktiv</Badge>}
            />
            <Row
              icon="book"
              title="Freigegebenes Wissen"
              detail={`${context.name} · 3 synthetische Beispielinhalte`}
            />
          </Card>
          <Card title="Wir sind für Sie da">
            <Row
              icon="users"
              title="Mara · Ihre Projektbegleitung"
              detail={`Synthetische Betreuung für ${context.name}`}
            />
            <PresentationButton
              title="Nachricht an die Projektbegleitung"
              action={onPreviewAction}
            >
              Kontakt anfragen <Icon name="chat" size={15} />
            </PresentationButton>
            <DemoNote>Es wird keine Nachricht versendet.</DemoNote>
          </Card>
        </div>
      </div>
      <DemoNote>
        Portalmodus ist eine visuelle Vorschau ohne Anmeldung, produktive
        Berechtigungen oder Datenverbindung.
      </DemoNote>
    </div>
  );
}
