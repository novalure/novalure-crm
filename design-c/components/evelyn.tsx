"use client";

import { useState } from "react";
import type { DemoWorkspace, DesignView, PreviewAction } from "../lib/types";
import { demoActivities } from "../lib/demo";
import { Badge, Button, Card, Dialog, Icon, Input } from "./ui";

export function EvelynBriefingCard({
  context,
  portal = false,
  onChat,
  onNavigate,
}: {
  context: DemoWorkspace;
  portal?: boolean;
  onChat: () => void;
  onNavigate: (view: DesignView) => void;
}) {
  return (
    <section
      className="dc-intelligence"
      aria-labelledby="evelyn-briefing-title"
    >
      <div className="dc-intelligence-head">
        <span className="dc-orb">
          <Icon name="sparkles" size={25} />
        </span>
        <div>
          <strong>Evelyn</strong>
          <span>Ihr intelligenter Überblick</span>
        </div>
        <Badge tone="violet">Demo-Briefing</Badge>
      </div>
      <h2 id="evelyn-briefing-title">
        Guten Morgen.
        <br />
        Ihr Fokus schafft Fortschritt.
      </h2>
      <p>
        {portal ? (
          <>
            Für <strong>{context.name}</strong> stehen beispielhaft Ihre
            Projektübersicht und freigegebenen Inhalte bereit. Das Projekt{" "}
            <strong>{context.project}</strong> wartet auf Ihr Designfeedback.
          </>
        ) : (
          <>
            Für <strong>{context.name}</strong> liegt ein Wissensentwurf bereit.
            Das Projekt <strong>{context.project}</strong> wartet auf
            Designfeedback. Hier sehen Sie beispielhaft die nächsten Schritte.
          </>
        )}
      </p>
      <button className="dc-prompt-launch" onClick={onChat}>
        <Icon name="sparkles" size={18} />
        <span>Was möchten Sie heute voranbringen?</span>
        <Icon name="arrow" size={18} />
      </button>
      <div className="dc-prompt-suggestions">
        <button onClick={() => onNavigate("studio")}>
          Projekte überblicken <Icon name="arrow" size={14} />
        </button>
        <button onClick={() => onNavigate("knowledge")}>
          {portal ? "Wissen ansehen" : "Wissen prüfen"}{" "}
          <Icon name="arrow" size={14} />
        </button>
        <button onClick={onChat}>
          Mit Evelyn sprechen <Icon name="arrow" size={14} />
        </button>
      </div>
      <small>
        Beispieltext · keine Live-Auswertung und keine aktiven KI-Aktionen
      </small>
    </section>
  );
}

export function EvelynActivityFeed({
  context,
  portal = false,
  compact = false,
}: {
  context: DemoWorkspace;
  portal?: boolean;
  compact?: boolean;
}) {
  return (
    <ol className="dc-feed" aria-label="Synthetische Aktivitäten">
      {demoActivities(context, portal)
        .slice(0, compact ? 3 : 4)
        .map((item) => (
          <li key={item.id}>
            <span className={`dc-feed-icon dc-feed-${item.tone}`}>
              <Icon name={item.icon} size={17} />
            </span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
              <time>{item.time} · Demozeit</time>
            </div>
          </li>
        ))}
    </ol>
  );
}

export function EvelynRecommendations({
  context,
  portal = false,
  onNavigate,
}: {
  context: DemoWorkspace;
  portal?: boolean;
  onNavigate: (view: DesignView) => void;
}) {
  return (
    <Card title="Ihre nächsten Schritte" eyebrow="EMPFEHLUNGEN · VORSCHAU">
      <button className="dc-decision" onClick={() => onNavigate("knowledge")}>
        <span>
          {portal ? "WISSEN · FREIGEGEBENE BEISPIELE" : "WISSEN · DEMO-ENTWURF"}
        </span>
        <strong>Gute Antworten beginnen mit aktuellen Grundlagen.</strong>
        <p>
          {portal
            ? "Ihre freigegebenen Leistungen & Informationen"
            : "Leistungen & Öffnungszeiten · Version 4"}
        </p>
        <b>
          {portal ? "Inhalte ansehen" : "Änderungen ansehen"}{" "}
          <Icon name="arrow" size={15} />
        </b>
      </button>
      <button
        className="dc-decision dc-decision-soft"
        onClick={() => onNavigate("studio")}
      >
        <span>PROJEKT · DESIGNREVIEW</span>
        <strong>{context.project}</strong>
        <p>Der nächste Meilenstein braucht Ihr Feedback.</p>
        <b>
          Projekt ansehen <Icon name="arrow" size={15} />
        </b>
      </button>
    </Card>
  );
}

export function EvelynApprovalRequests({
  portal,
  onPreviewAction,
}: {
  portal: boolean;
  onPreviewAction: PreviewAction;
}) {
  return (
    <Card
      title={portal ? "Ihr Feedback" : "Offene Freigaben"}
      eyebrow="DESIGNVORSCHAU"
    >
      <div className="dc-approval-row">
        <div>
          <strong>
            {portal ? "Websitegestaltung ansehen" : "Wissensversion 4 prüfen"}
          </strong>
          <p>
            {portal
              ? "Ein Beispiel für die spätere Projektabnahme."
              : "Entwurf und aktive Wissensversion bleiben getrennt."}
          </p>
        </div>
        <Badge tone="warning">Ausstehend · Demo</Badge>
      </div>
      <Button
        variant="secondary"
        onClick={() =>
          onPreviewAction(portal ? "Designfeedback" : "Wissensfreigabe")
        }
      >
        Details ansehen <Icon name="arrow" size={15} />
      </Button>
    </Card>
  );
}

export function EvelynTaskStatus() {
  return (
    <Card title="Aufgaben im Blick" eyebrow="SYNTHETISCHER ARBEITSSTAND">
      <ul className="dc-task-list">
        <li>
          <span>Websitegestaltung</span>
          <Badge tone="success">Abgeschlossen</Badge>
        </li>
        <li>
          <span>Inhalte abstimmen</span>
          <Badge tone="warning">In Bearbeitung</Badge>
        </li>
        <li>
          <span>Wissensquelle prüfen</span>
          <Badge tone="info">Vorgeschlagen</Badge>
        </li>
      </ul>
      <p className="dc-muted">
        Diese Liste zeigt ausschließlich Beispielzustände.
      </p>
    </Card>
  );
}

export function EvelynChatPanel({
  open,
  onClose,
  context,
}: {
  open: boolean;
  onClose: () => void;
  context: DemoWorkspace;
}) {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<
    { role: "user" | "assistant"; text: string }[]
  >([]);
  function simulate(text: string) {
    if (!text.trim()) return;
    setMessages((previous) => [
      ...previous,
      { role: "user", text: text.trim() },
      {
        role: "assistant",
        text: `Designvorschau für ${context.name}: Diese Antwort ist ein festes lokales Beispiel. Eine geprüfte KI-Schnittstelle ist hier nicht verbunden. Es wurde keine Anfrage, Aufgabe oder Geschäftshandlung ausgeführt.`,
      },
    ]);
    setPrompt("");
  }
  return (
    <Dialog
      open={open}
      title="Mit Evelyn sprechen · Vorschau"
      onClose={onClose}
    >
      <p className="dc-muted">
        Lokale Simulation · kein Modellaufruf · Kontext: {context.name}
      </p>
      <div
        className="dc-chat-messages"
        role="log"
        aria-label="Simulierter Gesprächsverlauf"
        aria-live="polite"
      >
        <p className="dc-chat-assistant">
          Willkommen. Hier können Sie das Gesprächsinterface ausprobieren. Alle
          Antworten sind fest hinterlegte Beispieltexte.
        </p>
        {messages.map((message, index) => (
          <p key={index} className={`dc-chat-${message.role}`}>
            <strong>
              {message.role === "user" ? "Sie" : "Evelyn · Simulation"}
            </strong>
            {message.text}
          </p>
        ))}
      </div>
      <div className="dc-row dc-wrap">
        {["Zeige mir neue Anfragen.", "Welche Aufgaben sind noch offen?"].map(
          (text) => (
            <Button
              key={text}
              variant="secondary"
              onClick={() => simulate(text)}
            >
              {text}
            </Button>
          ),
        )}
      </div>
      <form
        className="dc-chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          simulate(prompt);
        }}
      >
        <label className="dc-sr-only" htmlFor="evelyn-prompt">
          Beispielfrage an Evelyn
        </label>
        <Input
          id="evelyn-prompt"
          maxLength={1000}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Ihre Beispielfrage …"
        />
        <Button
          type="submit"
          disabled={!prompt.trim()}
          aria-label="Beispielfrage senden"
        >
          <Icon name="arrow" />
        </Button>
      </form>
    </Dialog>
  );
}
