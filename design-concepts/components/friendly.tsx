"use client";

import type { DashboardProps, ShellProps } from "./types";
import { NAV_ITEMS, TENANTS } from "./types";
import { Avatar, Brand, Icon, TenantSelect } from "./ui";
import "./friendly.css";

const moreItems = [
  { label: "Vertrieb", icon: "chart" },
  { label: "Immobilien", icon: "building" },
  { label: "Finanzen", icon: "wallet" },
  { label: "Marketing / Social", icon: "globe" },
  { label: "Aufgaben / Kalender", icon: "calendar" },
  { label: "Telefonie", icon: "phone" },
  { label: "Einstellungen", icon: "settings" },
];

export function FriendlyShell({ children, view, tenant, portal, onNavigate, onTenantChange, onAction }: ShellProps) {
  return (
    <div className="friendly" data-tenant={tenant}>
      <header className="friendly-header">
        <div className="friendly-header-top">
          <button type="button" className="friendly-brand-button" onClick={() => onNavigate("dashboard")} aria-label="Evelyn Übersicht"><Brand /></button>
          <span className="friendly-header-divider" aria-hidden="true" />
          <TenantSelect tenant={tenant} onChange={onTenantChange} />
          <div className="friendly-header-tools">
            <button type="button" className="friendly-search-button" onClick={() => onAction("Workspace durchsuchen")}><Icon name="search" size={17} /><span>Suchen</span><kbd>⌘ K</kbd></button>
            <button type="button" className="friendly-icon-button friendly-notifications" aria-label="Demo-Benachrichtigungen öffnen" onClick={() => onAction("Benachrichtigungen")}><Icon name="bell" size={20} /><span /></button>
            <button type="button" className="friendly-profile-button" aria-label="Demoprofil öffnen" onClick={() => onAction("Demoprofil")}><Avatar name="JL" /></button>
          </div>
        </div>
        <div className="friendly-nav-row">
          <nav className="friendly-nav" aria-label="Hauptnavigation">
            {NAV_ITEMS.filter(item => !portal || item.id !== "customers").map(item => <button key={item.id} type="button" className={view === item.id ? "friendly-nav-item is-active" : "friendly-nav-item"} aria-current={view === item.id ? "page" : undefined} onClick={() => onNavigate(item.id)}><Icon name={item.icon} size={18} /><span>{portal && item.id === "studio" ? "Projekte" : item.label}</span></button>)}
          </nav>
          {!portal && <details className="friendly-more">
            <summary><span>Weitere Bereiche</span><Icon name="chevron" size={15} /></summary>
            <div className="friendly-more-menu">
              <span className="friendly-menu-heading">Dein Workspace wächst mit dir</span>
              {moreItems.map(item => <button key={item.label} type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); onAction(item.label); }}><Icon name={item.icon} size={17} /><span>{item.label}</span><small>Geplant</small></button>)}
            </div>
          </details>}
          {portal && <span className="friendly-portal-label"><Icon name="shield" size={14} />Kundenportal</span>}
        </div>
      </header>
      <main className="friendly-main" id="workspace" tabIndex={-1}>{children}</main>
      <footer className="friendly-helper">
        <span className="friendly-helper-symbol" aria-hidden="true">✳</span>
        <div><strong>Ein guter Gedanke beginnt mit einer Frage.</strong><span>Evelyn begleitet dich durch {TENANTS[tenant].name}. <span className="friendly-helper-demo">Demo-Assistentin</span></span></div>
        <button type="button" onClick={() => onAction("Evelyn Demo-Chat")}><Icon name="sparkles" size={17} />Evelyn fragen<Icon name="arrow" size={17} /></button>
      </footer>
    </div>
  );
}

function FriendlyIllustration({ type }: { type: "architecture" | "identity" }) {
  return <div className={`friendly-project-art friendly-art-${type}`} aria-hidden="true">{type === "architecture" ? <><span className="friendly-art-sun" /><span className="friendly-art-hill" /><span className="friendly-art-building"><i /><i /><i /><i /><i /><i /></span><span className="friendly-art-caption">A NEW<br />PERSPECTIVE.</span><span className="friendly-art-tree" /></> : <><span className="friendly-identity-word">a little<br /><em>different.</em></span><span className="friendly-art-flower">✳</span><span className="friendly-art-swatch friendly-swatch-one" /><span className="friendly-art-swatch friendly-swatch-two" /><span className="friendly-art-swatch friendly-swatch-three" /><span className="friendly-identity-caption">IDEAS WITH CHARACTER</span></>}</div>;
}

export function FriendlyDashboard({ tenant, onNavigate, onAction }: DashboardProps) {
  const company = TENANTS[tenant];
  const isAtelier = tenant === "atelier";
  const secondProject = isAtelier ? "Eine Marke mit Charakter" : "Ein Zuhause mit Charakter";
  const secondCustomer = company.name;
  return (
    <div className="friendly-dashboard">
      <section className="friendly-greeting" aria-labelledby="friendly-dashboard-title">
        <div><p className="friendly-kicker"><span />DEIN MONTAG BEI {company.name.toUpperCase()}</p><h1 id="friendly-dashboard-title">Schön, dass du da bist<span className="friendly-greeting-sun" aria-hidden="true">✳</span></h1><p>Ein neuer Tag. Viel Raum für deine Ideen.</p></div>
        <div className="friendly-greeting-actions"><span className="friendly-date"><Icon name="calendar" size={15} />19. Oktober 2026</span><button type="button" className="button button-primary friendly-primary" onClick={() => onNavigate("studio")}><Icon name="plus" size={17} />Projekt starten</button></div>
      </section>

      <section className="friendly-metrics" aria-label="Kennzahlen mit synthetischen Demodaten">
        <div className="friendly-metric"><span>Umsatz · Oktober <span className="friendly-demo-dot">Demo</span></span><div><strong>48.250<span> €</span></strong><span className="friendly-metric-trend">↗ 12,8 %</span></div></div>
        <button type="button" className="friendly-metric" onClick={() => onNavigate("customers")}><span>Kunden<Icon name="arrow" size={14} /></span><div><strong>24</strong><span className="friendly-metric-detail">+4 Demo-Leads</span></div></button>
        <button type="button" className="friendly-metric" onClick={() => onNavigate("studio")}><span>Aktive Projekte<Icon name="arrow" size={14} /></span><div><strong>8</strong><span className="friendly-metric-detail">Ideen in Bewegung</span></div></button>
        <button type="button" className="friendly-metric" onClick={() => onNavigate("assistants")}><span>KI-Gespräche<Icon name="arrow" size={14} /></span><div><strong>1.284</strong><span className="friendly-metric-detail">kleine Helfer im Alltag</span></div></button>
      </section>

      <div className="friendly-hero-grid">
        <section className="friendly-brief" aria-labelledby="friendly-brief-title">
          <div className="friendly-brief-top"><span className="friendly-evelyn-tag"><span aria-hidden="true">✳</span>Ein Moment mit Evelyn</span><span className="friendly-brief-demo">Demo-Briefing</span></div>
          <div className="friendly-brief-content"><div className="friendly-brief-copy"><h2 id="friendly-brief-title">Dein Kopf ist für<br />große Ideen da.</h2><p>Den Überblick übernehme ich. Für <strong>{company.name}</strong> habe ich schon ein paar Dinge sortiert.</p><ul><li><span><Icon name="check" size={12} /></span>2 Kunden warten auf deine Rückmeldung.</li><li><span><Icon name="check" size={12} /></span><strong>{company.project}</strong> ist bereit für dein Feedback.</li></ul><button type="button" onClick={() => onAction("Evelyn Demo-Tagesbriefing")} className="friendly-brief-button">Lass uns den Tag planen<Icon name="arrow" size={17} /></button></div><div className="friendly-evelyn-art" aria-hidden="true"><span className="friendly-orbit friendly-orbit-one" /><span className="friendly-orbit friendly-orbit-two" /><span className="friendly-note-art friendly-note-back"><i /><i /><i /></span><span className="friendly-note-art friendly-note-front"><span>made for<br /><em>your flow.</em></span><i /><b>✳</b></span><span className="friendly-art-star">✳</span><span className="friendly-art-dot" /></div></div>
          <span className="friendly-brief-footer"><span />Gute Zusammenarbeit beginnt mit einem klaren Kopf.</span>
        </section>

        <section className="friendly-agenda" aria-labelledby="friendly-agenda-title">
          <div className="friendly-card-heading"><div><p>DEIN TAG</p><h2 id="friendly-agenda-title">Alles zur richtigen Zeit.</h2></div><button type="button" className="friendly-icon-button" aria-label="Demo-Kalender öffnen" onClick={() => onAction("Aufgaben / Kalender")}><Icon name="arrow" size={18} /></button></div>
          <div className="friendly-week" aria-label="Woche vom 19. Oktober 2026">{[{ d: "Mo", n: 19 }, { d: "Di", n: 20 }, { d: "Mi", n: 21 }, { d: "Do", n: 22 }, { d: "Fr", n: 23 }].map((day, index) => <button key={day.d} type="button" className={index === 0 ? "is-today" : ""} onClick={() => onAction(`Demo-Kalender ${day.n}. Oktober`)} aria-label={`${day.d}, ${day.n}. Oktober${index === 0 ? ", heute" : ""}`}><span>{day.d}</span><strong>{day.n}</strong><i /></button>)}</div>
          <div className="friendly-agenda-events"><button type="button" onClick={() => onAction(`Demo-Termin mit ${company.contact}`)}><time>10:00</time><span className="friendly-event-line friendly-event-lavender" /><span><strong>Ein guter Austausch</strong><small>Projektgespräch mit {company.contact}</small></span><Icon name="chevron" size={15} /></button><button type="button" onClick={() => onAction(`Demo-Aufgabe ${company.project} Feedback`)}><time>14:30</time><span className="friendly-event-line friendly-event-orange" /><span><strong>Zeit für dein Feedback</strong><small>{company.project}</small></span><Icon name="chevron" size={15} /></button></div>
          <button type="button" className="friendly-agenda-add" onClick={() => onAction("Neue Demo-Aufgabe")}><Icon name="plus" size={15} />Etwas auf die Liste setzen</button>
        </section>
      </div>

      <div className="friendly-work-grid">
        <section className="friendly-projects" aria-labelledby="friendly-projects-title">
          <div className="friendly-section-heading"><div><p>MIT LIEBE IN ARBEIT</p><h2 id="friendly-projects-title">Deine Projekte nehmen Form an.</h2></div><button type="button" onClick={() => onNavigate("studio")}>Zum Studio<Icon name="arrow" size={16} /></button></div>
          <div className="friendly-project-grid">
            <article className="friendly-project-card"><button type="button" className="friendly-project-preview" onClick={() => onAction(`${company.project} – Demo-Projektvorschau`)} aria-label={`${company.project}, Demo-Vorschau öffnen`}><FriendlyIllustration type="architecture" /><span className="friendly-project-type"><Icon name="globe" size={12} />{isAtelier ? "Website" : "Immobilien-Website"}</span></button><div className="friendly-project-information"><div><span>{company.name}</span><span className="friendly-project-stage"><i />Im Flow</span></div><button type="button" className="friendly-project-title" onClick={() => onAction(`${company.project} – Demo-Projektdetails`)}>{company.project}<Icon name="arrow" size={16} /></button><div className="friendly-progress" aria-label="Demo-Projektfortschritt 72 Prozent"><span style={{ width: "72%" }} /></div><div className="friendly-project-bottom"><span><Avatar name={company.short} color={company.color} /><Avatar name="JL" /></span><small>72 % geschafft</small></div></div></article>
            <article className="friendly-project-card"><button type="button" className="friendly-project-preview" onClick={() => onAction(`${secondProject} – Demo-Projektvorschau`)} aria-label={`${secondProject}, Demo-Vorschau öffnen`}><FriendlyIllustration type="identity" /><span className="friendly-project-type"><Icon name="layers" size={12} />{isAtelier ? "Brand Design" : "Exposé Design"}</span></button><div className="friendly-project-information"><div><span>{secondCustomer}</span><span className="friendly-project-stage friendly-stage-peach"><i />In Gestaltung</span></div><button type="button" className="friendly-project-title" onClick={() => onAction(`${secondProject} – Demo-Projektdetails`)}>{secondProject}<Icon name="arrow" size={16} /></button><div className="friendly-progress friendly-progress-peach" aria-label="Demo-Projektfortschritt 45 Prozent"><span style={{ width: "45%" }} /></div><div className="friendly-project-bottom"><span><Avatar name={company.short} color={company.color} /><Avatar name="JL" /></span><small>45 % geschafft</small></div></div></article>
          </div>
          <span className="friendly-projects-note"><Icon name="shield" size={12} />Alle Projekte und Fortschritte sind Beispieldaten für {company.name}.</span>
        </section>

        <aside className="friendly-right-column">
          <section className="friendly-activity" aria-labelledby="friendly-activity-title"><div className="friendly-card-heading"><div><p>GUTE VERBINDUNGEN</p><h2 id="friendly-activity-title">Bei deinen Kunden.</h2></div><button type="button" className="friendly-icon-button" aria-label="Kunden öffnen" onClick={() => onNavigate("customers")}><Icon name="arrow" size={18} /></button></div><button type="button" className="friendly-activity-row" onClick={() => onNavigate("customers")}><Avatar name={company.contact.split(" ").map(part => part[0]).join("")} color={company.color} /><span><strong>{company.contact}</strong><small>Hat dir neues Feedback geschickt.</small><em>Vor 25 Min. · Demo</em></span><span className="friendly-activity-unread" /></button><button type="button" className="friendly-activity-row" onClick={() => onAction(`Demo-Dokumente für ${secondCustomer}`)}><Avatar name={company.short} color={company.color} /><span><strong>{secondCustomer}</strong><small>Neue Unterlagen sind da.</small><em>Vor 1 Std. · Demo</em></span><Icon name="file" size={17} /></button></section>
          <section className="friendly-assistant-card"><span className="friendly-assistant-icon"><Icon name="sparkles" size={22} /></span><div><p>KLEINE HILFE, GROSSE WIRKUNG</p><h2>Mehr Zeit fürs Wesentliche.</h2><span>Deine KI-Assistenten helfen beim Schreiben, Sortieren und Weiterdenken.</span><button type="button" onClick={() => onNavigate("assistants")}>Dein Team kennenlernen<Icon name="arrow" size={15} /></button></div></section>
        </aside>
      </div>
    </div>
  );
}
