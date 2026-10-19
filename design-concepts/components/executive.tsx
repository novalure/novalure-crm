"use client";

import { useState } from "react";
import type { DashboardProps, ShellProps, ViewId } from "./types";
import { NAV_ITEMS, TENANTS } from "./types";
import { Avatar, Brand, Icon, LineChart, Status, TenantSelect } from "./ui";
import "./executive.css";

const modules = [
  { label: "Vertrieb", icon: "chart" },
  { label: "Immobilien", icon: "building" },
  { label: "Marketing / Social", icon: "globe" },
  { label: "Finanzen", icon: "wallet" },
];

export function ExecutiveShell({ children, view, tenant, onNavigate, onTenantChange, onAction, portal }: ShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const current = NAV_ITEMS.find(item => item.id === view);
  const navigate = (id: ViewId) => { onNavigate(id); setMenuOpen(false); };
  const navItem = (id: ViewId) => {
    const item = NAV_ITEMS.find(item => item.id === id)!;
    return <button key={id} className={`exec-nav-item ${view === id ? "active" : ""}`} onClick={() => navigate(id)} aria-current={view === id ? "page" : undefined}><Icon name={item.icon} size={18}/><span>{portal && id === "studio" ? "Projekte" : item.label}</span>{id === "assistants" && <span className="exec-nav-badge">2</span>}</button>;
  };
  return <div className="executive">
    <aside className="exec-sidebar" aria-label="Hauptnavigation">
      <div className="exec-sidebar-brand"><button className="exec-brand-button" aria-label="Evelyn Übersicht" onClick={() => navigate("dashboard")}><Brand/></button><button className="exec-mobile-toggle" aria-expanded={menuOpen} aria-controls="exec-navigation" aria-label={menuOpen ? "Navigation schließen" : "Navigation öffnen"} onClick={() => setMenuOpen(!menuOpen)}><Icon name={menuOpen ? "close" : "menu"}/></button></div>
      <TenantSelect tenant={tenant} onChange={onTenantChange}/>
      <div id="exec-navigation" className={`exec-navigation ${menuOpen ? "is-open" : ""}`}>
        <nav>
          <p className="exec-nav-heading">{portal ? "Dein Portal" : "Geschäft"}</p>
          {navItem("dashboard")}{!portal && navItem("customers")}
          {!portal && modules.map(item => <button className="exec-nav-item" key={item.label} onClick={() => onAction(item.label)}><Icon name={item.icon} size={18}/><span>{item.label}</span></button>)}
          {!portal && <p className="exec-nav-heading">Intelligenz</p>}
          {navItem("studio")}{navItem("assistants")}
          {!portal && <button className="exec-nav-item" onClick={() => onAction("KI-Telefonie")}><Icon name="phone" size={18}/><span>KI-Telefonie</span></button>}
          {navItem("knowledge")}
          {!portal && <><p className="exec-nav-heading">Organisation</p>
          <button className="exec-nav-item" onClick={() => onAction("Aufgaben / Kalender")}><Icon name="calendar" size={18}/><span>Aufgaben / Kalender</span><span className="exec-nav-dot"/></button>
          <button className="exec-nav-item" onClick={() => onAction("Einstellungen")}><Icon name="settings" size={18}/><span>Einstellungen</span></button></>}
        </nav>
        <div className="exec-sidebar-bottom">{!portal && <div className="exec-workspace-note"><span className="exec-note-icon"><Icon name="sparkles" size={18}/></span><strong>Raum für mehr.</strong><p>Dein Business. Deine Ideen.<br/>Alles an einem Ort.</p><button onClick={() => onAction("Workspace entdecken")}>Workspace entdecken <Icon name="arrow" size={15}/></button></div>}<button className="exec-profile" onClick={() => onAction("Mein Profil")}><Avatar name="AM"/><span><strong>Alex Morgan</strong><small>{portal ? "Kundenportal" : "Workspace Admin"} · Demo</small></span><Icon name="chevron" size={16}/></button></div>
      </div>
    </aside>
    <div className="exec-main">
      <header className="exec-topbar"><div className="exec-breadcrumb"><span>Workspace</span><span>/</span><strong>{current?.label}</strong></div><div className="exec-topbar-actions"><button className="exec-search" onClick={() => onAction("Globale Suche")} aria-label="Workspace durchsuchen"><Icon name="search" size={17}/><span>Suchen</span><kbd>⌘ K</kbd></button><span className="exec-topbar-divider"/><button className="exec-icon-button" onClick={() => onAction("Benachrichtigungen")} aria-label="Demo-Benachrichtigungen"><Icon name="bell" size={20}/><span className="exec-notification-dot"/></button><button className="exec-account-button" onClick={() => onAction("Mein Profil")} aria-label="Profil von Alex Morgan"><Avatar name="AM"/></button></div></header>
      <main className="exec-content" id="workspace" tabIndex={-1}>{children}</main>
      <footer className="exec-footer"><span>Mit Klarheit nach vorne.</span><span>evelyn · Executive Edition</span></footer>
    </div>
  </div>;
}

export function ExecutiveDashboard({ tenant, onNavigate, onAction }: DashboardProps) {
  const workspace = TENANTS[tenant];
  const [completed, setCompleted] = useState<string[]>([]);
  const tasks = [
    { id: "briefing", title: `Briefing mit ${workspace.contact.split(" ")[0]}`, time: "Heute, 10:30", icon: "users" },
    { id: "feedback", title: "Design-Feedback freigeben", time: "Heute, 14:00", icon: "layers" },
    { id: "angebot", title: "Angebot finalisieren", time: "Morgen, 09:00", icon: "file" },
  ];
  const projects = tenant === "atelier"
    ? [{ name: workspace.project, type: "Webdesign & Entwicklung", progress: 72, status: "In Arbeit", tone: "green", icon: "globe" }, { name: "Neue Markenwelt", type: "Strategie & Brand Design", progress: 48, status: "Feedback", tone: "amber", icon: "layers" }, { name: "Portfolio Frühjahr", type: "Content & Kommunikation", progress: 24, status: "Geplant", tone: "neutral", icon: "file" }]
    : [{ name: workspace.project, type: "Exposé & Vermarktung", progress: 72, status: "In Arbeit", tone: "green", icon: "building" }, { name: "Haven Markenwelt", type: "Strategie & Brand Design", progress: 48, status: "Feedback", tone: "amber", icon: "layers" }, { name: "Immobilien-Portfolio", type: "Content & Kommunikation", progress: 24, status: "Geplant", tone: "neutral", icon: "file" }];
  const isCompleted = (id: string) => completed.includes(`${tenant}-${id}`);
  const toggleTask = (id: string) => { const key = `${tenant}-${id}`; setCompleted(items => items.includes(key) ? items.filter(item => item !== key) : [...items, key]); };
  return <div className="exec-dashboard">
    <div className="exec-welcome"><div><p className="eyebrow">DEIN WORKSPACE. DEIN ÜBERBLICK.</p><h1>Guten Morgen, Alex<span> ✳</span></h1><p>Alles im Blick. Mehr Raum für das, was zählt.</p></div><button className="button button-primary" onClick={() => onAction("Demo-Projekt anlegen")}><Icon name="plus" size={17}/>Neues Projekt</button></div>
    <div className="exec-context"><span><span className="exec-context-dot"/>{workspace.name}<span className="exec-context-separator">/</span>Demo-Übersicht</span><span>Montag, 19. Oktober 2026</span></div>
    <section className="exec-metrics" aria-label={`Demo-Kennzahlen für ${workspace.name}`}>
      <button className="exec-metric panel" onClick={() => onAction("Demo-Umsatzbericht")}><span className="exec-metric-top">Demo-Umsatz<Icon name="wallet" size={19}/></span><strong>48.250<span> €</span></strong><span className="exec-metric-bottom"><span className="exec-trend">↗ 12,8 %</span><span>zum Vormonat</span></span></button>
      <button className="exec-metric panel" onClick={() => onNavigate("customers")}><span className="exec-metric-top">Aktive Kunden<Icon name="users" size={19}/></span><strong>24</strong><span className="exec-metric-bottom"><span className="exec-trend">+4 Demo-Leads</span><span>diesen Monat</span></span></button>
      <button className="exec-metric panel" onClick={() => onNavigate("studio")}><span className="exec-metric-top">Laufende Projekte<Icon name="layers" size={19}/></span><strong>8</strong><span className="exec-metric-bottom"><span className="exec-project-dots"><i/><i/><i/></span><span>3 in der finalen Phase</span></span></button>
      <button className="exec-metric panel" onClick={() => onNavigate("assistants")}><span className="exec-metric-top">KI-Dialoge<Icon name="sparkles" size={19}/></span><strong>1.284</strong><span className="exec-metric-bottom"><span className="exec-trend">↗ 24,6 %</span><span>diesen Monat</span></span></button>
    </section>
    <div className="exec-dashboard-grid">
      <section className="panel exec-revenue"><div className="exec-section-heading"><div><h2>Wachstum, das sichtbar wird.</h2><p>Deine Demo-Umsatzentwicklung im Überblick</p></div><button className="exec-period" onClick={() => onAction("Umsatzbericht Mai bis Oktober 2026")}>Mai – Okt 2026<Icon name="chevron" size={14}/></button></div><div className="exec-chart-summary"><strong>48.250 <span>€</span></strong><span className="exec-trend">↗ 12,8 %</span><span className="muted">im Oktober</span></div><div className="exec-chart"><div className="exec-y-axis"><span>60 Tsd.</span><span>40 Tsd.</span><span>20 Tsd.</span><span>0</span></div><LineChart color="#486a50"/></div><div className="exec-chart-footer"><span><i/>Demo-Umsatz</span><button onClick={() => onAction("Demo-Umsatzbericht")}>Bericht ansehen<Icon name="arrow" size={15}/></button></div></section>
      <section className="panel exec-tasks"><div className="exec-section-heading"><div><h2>Dein nächster Schritt</h2><p>Ein klarer Kopf beginnt hier.</p></div><span className="exec-count">{tasks.filter(task => !isCompleted(task.id)).length}</span></div><div className="exec-task-list">{tasks.map(task => <label className={`exec-task ${isCompleted(task.id) ? "completed" : ""}`} key={`${tenant}-${task.id}`}><input type="checkbox" checked={isCompleted(task.id)} onChange={() => toggleTask(task.id)}/><span className="exec-checkbox"><Icon name="check" size={13}/></span><span className="exec-task-copy"><strong>{task.title}</strong><small><Icon name="clock" size={12}/>{task.time}</small></span></label>)}</div><button className="exec-text-link" onClick={() => onAction("Aufgaben / Kalender")}>Alle Aufgaben ansehen<Icon name="arrow" size={15}/></button><div className="exec-task-note"><Icon name="sun" size={17}/><span>Ein Schritt nach dem anderen.<br/><strong>Du bist auf einem guten Weg.</strong></span></div></section>
      <section className="panel exec-projects"><div className="exec-section-heading"><div><h2>Projekte im Fokus</h2><p>Gute Ideen nehmen Form an.</p></div><button className="exec-text-link" onClick={() => onNavigate("studio")}>Alle Projekte<Icon name="arrow" size={15}/></button></div><div className="exec-project-table"><div className="exec-project-labels"><span>PROJEKT</span><span>FORTSCHRITT</span><span>STATUS</span></div>{projects.map(project => <button className="exec-project-row" key={project.name} onClick={() => onAction(`${workspace.name}: ${project.name}`)}><span className="exec-project-name"><span className={`exec-project-icon ${project.icon}`}><Icon name={project.icon} size={20}/></span><span><strong>{project.name}</strong><small>{project.type}</small></span></span><span className="exec-progress"><span><i style={{ width: `${project.progress}%` }}/></span><small>{project.progress}%</small></span><Status tone={project.tone}>{project.status}</Status><Icon name="arrow" size={16}/></button>)}</div></section>
      <section className="exec-assistant"><div className="exec-assistant-top"><span className="exec-assistant-badge"><Icon name="sparkles" size={14}/>EVELYN INTELLIGENCE</span><span className="exec-assistant-orbit"><Icon name="sparkles" size={25}/></span></div><h2>Mehr Freiraum.<br/>Mit deiner KI.</h2><p>Von der ersten Idee bis zum letzten Feinschliff. Deine Assistenten denken mit.</p><button className="button" onClick={() => onNavigate("assistants")}>Assistenten öffnen<Icon name="arrow" size={16}/></button><span className="exec-assistant-caption"><span/>2 Assistenten im Demo-Workspace</span><span className="exec-ai-activity">Demo: Evelyn hat 3 Anfragen für {workspace.name} sortiert.</span></section>
    </div>
    <p className="exec-data-note"><Icon name="shield" size={13}/>Alle Kennzahlen, Aufgaben und Projekte sind synthetische Demodaten für {workspace.name}.</p>
  </div>;
}
