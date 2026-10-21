"use client";

import { useRef, useState } from "react";
import type { DemoWorkspace, DesignView } from "../lib/types";
import { DEMO_WORKSPACES } from "../lib/demo";
import { visibleNavigation, type CommandNavItem } from "../lib/navigation";
import {
  AssistantsView,
  CustomersView,
  KnowledgeView,
  PropertiesView,
  StudioView,
  TenantsView,
} from "./domain-views";
import { CommandDashboard } from "./dashboard";
import {
  EvelynActivityFeed,
  EvelynChatPanel,
  EvelynTaskStatus,
} from "./evelyn";
import { ComponentGallery } from "./showcase";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Icon,
  IconButton,
  PageHeading,
  Select,
} from "./ui";

export function DesignPreview() {
  const [view, setView] = useState<DesignView>("dashboard");
  const [workspaceId, setWorkspaceId] = useState(DEMO_WORKSPACES[0].id);
  const [portal, setPortal] = useState(false);
  const [dark, setDark] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [action, setAction] = useState("");
  const [search, setSearch] = useState("");
  const mainRef = useRef<HTMLElement>(null);
  const context =
    DEMO_WORKSPACES.find((item) => item.id === workspaceId) ??
    DEMO_WORKSPACES[0];
  const capabilities = new Set([
    "customers",
    "studio",
    "assistants",
    "knowledge",
    ...(context.kind === "broker" || context.kind === "developer" || !portal
      ? ["properties"]
      : []),
  ]);
  const items = visibleNavigation(portal, capabilities);
  const labelFor = (item: CommandNavItem) =>
    portal ? (item.portalLabel ?? item.label) : item.label;
  const currentItem = items.find((item) => item.view === view);
  const currentLabel =
    view === "components"
      ? "Designsystem"
      : view === "tenants"
        ? "Mandantenübersicht"
        : currentItem
          ? labelFor(currentItem)
          : "Dashboard";
  function navigate(nextView: DesignView) {
    setView(nextView);
    setMobileOpen(false);
    setSearch("");
    requestAnimationFrame(() => {
      mainRef.current?.focus();
      window.scrollTo({ top: 0, behavior: "instant" });
    });
  }
  function resetContext(nextWorkspaceId: string, nextPortal: boolean) {
    setWorkspaceId(nextWorkspaceId);
    setPortal(nextPortal);
    setView("dashboard");
    setChatOpen(false);
    setAction("");
    setNotificationsOpen(false);
    setMobileOpen(false);
    setSearch("");
  }
  const navProps = { items, portal, view, onNavigate: navigate };
  const domainProps = { context, portal, onPreviewAction: setAction };
  return (
    <div className="design-c" data-theme={dark ? "dark" : "light"}>
      <a className="dc-skip-link" href="#dc-main">
        Zum Inhalt springen
      </a>
      <div className="dc-preview-bar">
        <span>
          <Badge tone="violet">Design C</Badge>
          <strong>Evelyn AI Command Center</strong>
          <span>Ausschließlich synthetische Demodaten</span>
        </span>
        <div className="dc-row">
          <Button
            variant="ghost"
            aria-pressed={portal}
            onClick={() => resetContext(workspaceId, !portal)}
          >
            <Icon name={portal ? "shield" : "users"} size={16} />
            {portal ? "Internes CRM zeigen" : "Kundenportal zeigen"}
          </Button>
          <IconButton
            aria-label={
              dark ? "Hellen Modus einschalten" : "Dunklen Modus einschalten"
            }
            title={dark ? "Light Mode" : "Dark Mode"}
            onClick={() => setDark(!dark)}
          >
            <Icon name={dark ? "sun" : "moon"} size={18} />
          </IconButton>
        </div>
      </div>
      <div className="dc-command-shell">
        <aside
          className="dc-rail"
          data-collapsed={collapsed}
          aria-label="Seitenleiste"
        >
          <button
            className="dc-logo"
            onClick={() => navigate("dashboard")}
            aria-label="Evelyn Dashboard"
          >
            e<span>✳</span>
          </button>
          <IconButton
            aria-label={
              collapsed ? "Navigation ausklappen" : "Navigation einklappen"
            }
            title={
              collapsed ? "Navigation ausklappen" : "Navigation einklappen"
            }
            onClick={() => setCollapsed(!collapsed)}
          >
            <Icon name="menu" size={18} />
          </IconButton>
          <NavigationContents {...navProps} />
          {!portal ? (
            <Button
              className="dc-library-link"
              variant="ghost"
              onClick={() => navigate("components")}
              title="Designsystem"
            >
              <Icon name="layers" size={19} />
              <span>Designsystem</span>
            </Button>
          ) : null}
          <button
            className="dc-rail-avatar"
            title="Demo-Profil"
            onClick={() => setAction("Demo-Profil")}
            aria-label="Demo-Benutzerprofil öffnen"
          >
            DE
          </button>
        </aside>
        <div className="dc-workspace">
          <header className="dc-topbar">
            <IconButton
              className="dc-mobile-trigger"
              aria-label="Mobile Navigation öffnen"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
            >
              <Icon name="menu" />
            </IconButton>
            <button
              className="dc-wordmark"
              onClick={() => navigate("dashboard")}
            >
              evelyn<span>✳</span>
              <small>AI OPERATING SYSTEM</small>
            </button>
            <form
              className="dc-global-search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                const match = items.find(
                  (item) =>
                    item.view &&
                    labelFor(item)
                      .toLocaleLowerCase("de")
                      .includes(search.trim().toLocaleLowerCase("de")),
                );
                if (search.trim() && match?.view) navigate(match.view);
              }}
            >
              <label className="dc-sr-only" htmlFor="dc-global-search">
                Bereich suchen
              </label>
              <Icon name="search" size={17} />
              <input
                id="dc-global-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Bereich suchen …"
                autoComplete="off"
              />
              <button type="submit" aria-label="Bereich öffnen">
                <Icon name="arrow" size={16} />
              </button>
              {search.trim() ? (
                <div
                  className="dc-search-results"
                  aria-label="Gefundene Bereiche"
                >
                  {items
                    .filter(
                      (item) =>
                        item.view &&
                        labelFor(item)
                          .toLocaleLowerCase("de")
                          .includes(search.toLocaleLowerCase("de")),
                    )
                    .map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() => item.view && navigate(item.view)}
                      >
                        {labelFor(item)}
                        <Icon name="arrow" size={14} />
                      </button>
                    ))}
                  {!items.some(
                    (item) =>
                      item.view &&
                      labelFor(item)
                        .toLocaleLowerCase("de")
                        .includes(search.toLocaleLowerCase("de")),
                  ) ? (
                    <p>Kein Bereich gefunden.</p>
                  ) : null}
                </div>
              ) : null}
            </form>
            <label className="dc-tenant-picker">
              <span>AKTIVER DEMO-MANDANT</span>
              <Select
                aria-label="Demo-Mandant auswählen"
                value={workspaceId}
                onChange={(event) => resetContext(event.target.value, portal)}
              >
                {DEMO_WORKSPACES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </label>
            <IconButton
              aria-label="Demo-Benachrichtigungen öffnen"
              title="Demo-Benachrichtigungen"
              onClick={() => setNotificationsOpen(true)}
            >
              <Icon name="bell" size={20} />
            </IconButton>
            <IconButton
              aria-label="Demo-Benutzerprofil öffnen"
              title="Demo-Benutzerprofil"
              onClick={() => setAction("Demo-Profil")}
            >
              <Icon name="users" size={19} />
            </IconButton>
          </header>
          <div className="dc-location">
            <span>
              <span className="dc-location-dot" />
              {portal ? "KUNDENPORTAL" : "INTERNES CRM"}
              <span>/</span>
              {currentLabel}
            </span>
            <span>VORSCHAU · KEINE LIVE-DATEN</span>
          </div>
          <main className="dc-main" id="dc-main" ref={mainRef} tabIndex={-1}>
            <div key={`${context.id}-${portal}-${view}`}>
              {view === "dashboard" ? (
                <CommandDashboard
                  {...domainProps}
                  onNavigate={navigate}
                  onChat={() => setChatOpen(true)}
                />
              ) : null}
              {view === "customers" && !portal ? (
                <>
                  <CustomersView {...domainProps} />
                  <div className="dc-mandant-link">
                    <Button
                      variant="secondary"
                      onClick={() => navigate("tenants")}
                    >
                      Mandantenübersicht öffnen <Icon name="arrow" size={16} />
                    </Button>
                  </div>
                </>
              ) : null}
              {view === "tenants" && !portal ? (
                <TenantsView {...domainProps} />
              ) : null}
              {view === "studio" ? <StudioView {...domainProps} /> : null}
              {view === "properties" && capabilities.has("properties") ? (
                <PropertiesView {...domainProps} />
              ) : null}
              {view === "assistants" ? (
                <AssistantsView {...domainProps} />
              ) : null}
              {view === "knowledge" ? <KnowledgeView {...domainProps} /> : null}
              {view === "activity" ? (
                <>
                  <PageHeading
                    eyebrow="DESIGNVORSCHAU"
                    title={
                      portal ? "Meine Aktivitäten" : "Evelyn Activity Center"
                    }
                    description={`Synthetischer Verlauf für ${context.name}.`}
                  />
                  <div className="dc-grid dc-grid-2">
                    <Card title="Aktivitäten">
                      <EvelynActivityFeed context={context} portal={portal} />
                    </Card>
                    <EvelynTaskStatus />
                  </div>
                </>
              ) : null}
              {view === "components" && !portal ? (
                <ComponentGallery onPreviewAction={setAction} />
              ) : null}
              {view === "settings" ? (
                <SettingsView
                  context={context}
                  portal={portal}
                  dark={dark}
                  onThemeChange={setDark}
                  onPreviewAction={setAction}
                />
              ) : null}
            </div>
          </main>
          <footer className="dc-footer">
            <span>
              <Icon name="shield" size={14} />
              {context.name} · {portal ? "Kundenportal" : "Interne Vorschau"}
            </span>
            <span>Alle Werte und Aktivitäten sind simuliert.</span>
          </footer>
        </div>
      </div>
      <button
        className="dc-chat-launcher"
        onClick={() => setChatOpen(true)}
        aria-label="Evelyn Chat-Vorschau öffnen"
      >
        <Icon name="sparkles" size={19} />
        <span>Evelyn</span>
        <Badge>Vorschau</Badge>
      </button>
      <Dialog
        open={mobileOpen}
        title="Navigation"
        onClose={() => setMobileOpen(false)}
      >
        <NavigationContents {...navProps} />
        {!portal ? (
          <Button variant="secondary" onClick={() => navigate("components")}>
            <Icon name="layers" size={19} />
            Designsystem
          </Button>
        ) : null}
        <p className="dc-muted">{context.name} · Demo-Kontext</p>
      </Dialog>
      <Dialog
        open={!!action}
        title={`${action} · Vorschau`}
        onClose={() => setAction("")}
      >
        <p>Diese Funktion ist in der Designvorschau noch nicht verbunden.</p>
        <p className="dc-muted">
          Sie können hier die Oberfläche ansehen. Es wurde nichts gespeichert,
          versendet, gebucht oder freigegeben.
        </p>
        <Button onClick={() => setAction("")}>Verstanden</Button>
      </Dialog>
      <Dialog
        open={notificationsOpen}
        title="Benachrichtigungen · Demo"
        onClose={() => setNotificationsOpen(false)}
      >
        <EvelynActivityFeed context={context} portal={portal} />
      </Dialog>
      <EvelynChatPanel
        key={`${context.id}-${portal}`}
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        context={context}
      />
    </div>
  );
}

export function NavigationContents({
  items,
  portal,
  view,
  onNavigate,
}: {
  items: CommandNavItem[];
  portal: boolean;
  view: DesignView;
  onNavigate: (view: DesignView) => void;
}) {
  return (
    <nav
      className="dc-navigation"
      aria-label={portal ? "Kundenportal-Navigation" : "CRM-Hauptnavigation"}
    >
      {items.map((item) =>
        item.view ? (
          <button
            key={item.id}
            onClick={() => onNavigate(item.view!)}
            title={portal ? (item.portalLabel ?? item.label) : item.label}
            aria-current={
              view === item.view ||
              (view === "tenants" && item.id === "customers")
                ? "page"
                : undefined
            }
          >
            <Icon name={item.icon} size={21} />
            <span>
              {portal ? (item.portalLabel ?? item.label) : item.label}
            </span>
          </button>
        ) : (
          <span
            className="dc-nav-planned"
            key={item.id}
            title={`${item.label} · Anbindung geplant`}
          >
            <Icon name={item.icon} size={19} />
            <span>
              {item.label}
              <small>Geplant</small>
            </span>
          </span>
        ),
      )}
    </nav>
  );
}

function SettingsView({
  context,
  portal,
  dark,
  onThemeChange,
  onPreviewAction,
}: {
  context: DemoWorkspace;
  portal: boolean;
  dark: boolean;
  onThemeChange: (dark: boolean) => void;
  onPreviewAction: (title: string) => void;
}) {
  return (
    <>
      <PageHeading
        eyebrow="DESIGNVORSCHAU"
        title="Einstellungen"
        description={context.name}
      />
      <div className="dc-grid dc-grid-2">
        <Card title="Darstellung">
          <p>Eine Designsprache für alle Bereiche.</p>
          <Button
            variant="secondary"
            aria-pressed={dark}
            onClick={() => onThemeChange(!dark)}
          >
            <Icon name={dark ? "sun" : "moon"} />
            {dark ? "Light Mode aktivieren" : "Dark Mode aktivieren"}
          </Button>
        </Card>
        <Card title={portal ? "Mein Abonnement" : "Unternehmensprofil"}>
          <p>{portal ? "Website und Webchat · Beispielpaket" : context.name}</p>
          <Badge tone="info">Synthetisches Beispiel</Badge>
          <p className="dc-muted">
            {portal
              ? "Keine Zahlungsfunktion verbunden."
              : "Die vorhandene Profilverwaltung wird bei der Integration angebunden."}
          </p>
          <Button
            variant="secondary"
            onClick={() =>
              onPreviewAction(
                portal ? "Abonnement verwalten" : "Profil bearbeiten",
              )
            }
          >
            Details ansehen
          </Button>
        </Card>
      </div>
    </>
  );
}
