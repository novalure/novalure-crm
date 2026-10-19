"use client";

import type { DemoWorkspace, DesignView, PreviewAction } from "../lib/types";
import { Badge, Button, Card, Icon, MetricCard, PageHeading } from "./ui";
import {
  EvelynActivityFeed,
  EvelynApprovalRequests,
  EvelynBriefingCard,
  EvelynRecommendations,
  EvelynTaskStatus,
} from "./evelyn";

export function CommandDashboard({
  context,
  portal,
  onChat,
  onNavigate,
  onPreviewAction,
}: {
  context: DemoWorkspace;
  portal: boolean;
  onChat: () => void;
  onNavigate: (view: DesignView) => void;
  onPreviewAction: PreviewAction;
}) {
  const metrics = portal
    ? [
        {
          label: "Meine Projekte",
          value: "3",
          detail: "1 Designreview",
          icon: "layers",
        },
        {
          label: "Meine Websites",
          value: "2",
          detail: "Beispielbestand",
          icon: "globe",
        },
        {
          label: "Meine Assistenten",
          value: "1",
          detail: "Demo-Testbetrieb",
          icon: "chat",
        },
        {
          label: "Offenes Feedback",
          value: "2",
          detail: "Beispielaufgaben",
          icon: "check",
        },
      ]
    : [
        {
          label: "Neue Anfragen",
          value: "12",
          detail: "+4 in der Demowoche",
          icon: "users",
        },
        {
          label: "Offene Aufgaben",
          value: "8",
          detail: "2 mit Priorität",
          icon: "check",
        },
        {
          label: "Aktive Projekte",
          value: "6",
          detail: "1 Designreview",
          icon: "layers",
        },
        {
          label: "Offene Angebote",
          value: "4",
          detail: "Beispielpipeline",
          icon: "file",
        },
        {
          label: "Termine",
          value: "3",
          detail: "Heute · Demozeit",
          icon: "calendar",
        },
        {
          label: "Umsatz · Demo",
          value: "48.250 €",
          detail: "Synthetischer Monatswert",
          icon: "wallet",
        },
      ];
  return (
    <>
      <PageHeading
        eyebrow={
          portal
            ? "IHR KUNDENPORTAL · DESIGNVORSCHAU"
            : "EVELYN AI COMMAND CENTER · DESIGN C"
        }
        title={portal ? "Ihr Projekt. Alles im Blick." : "Alles verbunden."}
        description={
          portal
            ? `Willkommen bei ${context.name}.`
            : "Den nächsten Schritt im Blick."
        }
        actions={
          <span className="dc-system-state">
            <span />
            Designvorschau<small>Kein Live-Monitoring</small>
          </span>
        }
      />
      <div className="dc-dashboard">
        <div className="dc-stack">
          <EvelynBriefingCard
            context={context}
            portal={portal}
            onChat={onChat}
            onNavigate={onNavigate}
          />
          <section aria-label="Synthetische Kennzahlen" className="dc-kpi-grid">
            {metrics.map((metric) => (
              <MetricCard key={metric.label} {...metric} />
            ))}
          </section>
          <Card
            eyebrow={
              portal
                ? "IHRE GEBUCHTEN MODULE · DEMO"
                : "DIE ABTEILUNGEN IM ZUSAMMENSPIEL"
            }
            title={
              portal
                ? "Ihr digitaler Arbeitsplatz"
                : "Ein Team. Klare Zuständigkeiten."
            }
            actions={<Badge>Vorschau</Badge>}
          >
            <div className="dc-department-grid">
              {[
                {
                  id: "studio" as const,
                  icon: "layers",
                  label: portal ? "Meine Websites" : "Novalure Studio",
                  detail: "Projekt in Umsetzung",
                },
                {
                  id: "assistants" as const,
                  icon: "chat",
                  label: portal ? "Meine KI-Assistenten" : "Webchat & Support",
                  detail: "Lokaler Beispielassistent",
                },
                {
                  id: "knowledge" as const,
                  icon: "book",
                  label: "Wissen & Qualität",
                  detail: portal ? "Freigegebene Beispielinhalte" : "1 Entwurf zur Prüfung",
                },
              ].map((item) => (
                <button key={item.id} onClick={() => onNavigate(item.id)}>
                  <span className="dc-icon-tile">
                    <Icon name={item.icon} />
                  </span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                  <Icon name="arrow" size={16} />
                </button>
              ))}
            </div>
            {!portal ? (
              <p className="dc-future-note">
                Weitere Bereiche: Vertrieb, Marketing, Organisation und Finanzen
                · Anbindung geplant
              </p>
            ) : null}
          </Card>
          {portal ? (
            <EvelynTaskStatus />
          ) : (
            <Card
              title="Wachstum mit Überblick"
              eyebrow="ENTWICKLUNG · SYNTHETISCHE WERTE"
              actions={<span className="dc-muted">Mai – Oktober</span>}
            >
              <RevenueChart />
            </Card>
          )}
          <Card
            title="Schnell zum nächsten Schritt"
            eyebrow="SCHNELLZUGRIFFE · VORSCHAU"
          >
            <div className="dc-quick-actions">
              {[
                ...(!portal
                  ? [
                      {
                        label: "Kunde hinzufügen",
                        icon: "users",
                        action: () => onPreviewAction("Kunde hinzufügen"),
                      },
                    ]
                  : []),
                {
                  label: "Projekt öffnen",
                  icon: "layers",
                  action: () => onNavigate("studio"),
                },
                {
                  label: "Chatbot verwalten",
                  icon: "chat",
                  action: () => onNavigate("assistants"),
                },
                {
                  label: portal ? "Wissen ansehen" : "Wissen ergänzen",
                  icon: "book",
                  action: () => onNavigate("knowledge"),
                },
                ...(!portal
                  ? [
                      {
                        label: "Angebot erstellen",
                        icon: "file",
                        action: () => onPreviewAction("Angebot erstellen"),
                      },
                    ]
                  : []),
              ].map((item) => (
                <Button
                  key={item.label}
                  variant="secondary"
                  onClick={item.action}
                >
                  <Icon name={item.icon} size={17} />
                  {item.label}
                </Button>
              ))}
            </div>
          </Card>
        </div>
        <aside
          className="dc-context dc-stack"
          aria-label="Entscheidungen und Aktivitäten"
        >
          <EvelynRecommendations
            context={context}
            portal={portal}
            onNavigate={onNavigate}
          />
          <Card
            title="Aktivitätsstrom"
            actions={<Badge tone="violet">Demo</Badge>}
          >
            <EvelynActivityFeed context={context} portal={portal} compact />
            <Button variant="ghost" onClick={() => onNavigate("activity")}>
              Alle Aktivitäten <Icon name="arrow" size={16} />
            </Button>
          </Card>
          <div className="dc-meeting">
            <Icon name="calendar" />
            <div>
              <span>NÄCHSTER DEMO-TERMIN</span>
              <strong>Website Design Review</strong>
              <p>Heute · 14:00 – 14:30</p>
            </div>
            <Button
              variant="ghost"
              aria-label="Demo-Termin ansehen"
              onClick={() => onPreviewAction("Website Design Review")}
            >
              <Icon name="arrow" size={16} />
            </Button>
          </div>
          <EvelynApprovalRequests
            portal={portal}
            onPreviewAction={onPreviewAction}
          />
        </aside>
      </div>
    </>
  );
}

function RevenueChart() {
  return (
    <figure className="dc-revenue-chart">
      <svg
        viewBox="0 0 640 180"
        role="img"
        aria-labelledby="revenue-title revenue-description"
      >
        <title id="revenue-title">Synthetische Umsatzentwicklung</title>
        <desc id="revenue-description">
          Mai 22.000, Juni 28.000, Juli 25.000, August 35.000, September 39.000,
          Oktober 48.250 Euro. Keine echten Umsätze.
        </desc>
        {[30, 75, 120].map((y) => (
          <line
            key={y}
            x1="16"
            y1={y}
            x2="624"
            y2={y}
            className="dc-chart-grid"
          />
        ))}
        <path
          d="M16 128 L138 104 L260 115 L382 77 L504 61 L624 25 L624 148 L16 148Z"
          className="dc-chart-area"
        />
        <path
          d="M16 128 L138 104 L260 115 L382 77 L504 61 L624 25"
          className="dc-chart-line"
        />
        {["Mai", "Jun", "Jul", "Aug", "Sep", "Okt"].map((month, index) => (
          <text
            key={month}
            x={16 + index * 120}
            y="172"
            textAnchor={index === 0 ? "start" : index === 5 ? "end" : "middle"}
          >
            {month}
          </text>
        ))}
      </svg>
      <figcaption>Beispieldarstellung · keine Live-Daten</figcaption>
    </figure>
  );
}
