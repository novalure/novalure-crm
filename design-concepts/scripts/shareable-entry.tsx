import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Demo } from "../components/demo";
import Home from "../app/page";
import { Brand, Icon } from "../components/ui";
import { NAV_ITEMS, type TenantId, type VariantId, type ViewId } from "../components/types";

type PreviewContext = {
  route: "home" | "compare" | VariantId;
  view: ViewId;
  tenant: TenantId;
  frame?: boolean;
  dark?: boolean;
  portal?: boolean;
};

declare global {
  interface Window {
    __EVELYN_INIT?: PreviewContext;
    __EVELYN_CONTEXT?: PreviewContext;
    __EVELYN_JS: string;
    __EVELYN_CSS: string;
    __EVELYN_FRAME: (context: PreviewContext) => string;
  }
}

const defaults: PreviewContext = { route: "home", view: "dashboard", tenant: "atelier" };
const names = ["Modern Executive", "Friendly Smart Workspace", "Evelyn AI Command Center"];
const safeJSON = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

window.__EVELYN_FRAME = context => {
  const bootstrap = `window.__EVELYN_INIT=${safeJSON(context)};window.__EVELYN_JS=${safeJSON(window.__EVELYN_JS)};window.__EVELYN_CSS=${safeJSON(window.__EVELYN_CSS)};`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evelyn Designvorschau</title><style>${window.__EVELYN_CSS}</style></head><body><div id="root"></div><script>${bootstrap}${window.__EVELYN_JS.replace(/<\/script/gi, "<\\/script")}<\/script></body></html>`;
};

function Compare({ context }: { context: PreviewContext }) {
  const [view, setView] = useState(context.view);
  const [tenant, setTenant] = useState(context.tenant);
  useEffect(() => { window.__EVELYN_CONTEXT = { ...context, view, tenant }; }, [context, view, tenant]);
  return <main className="compare-page">
    <header className="home-header"><a href="/" aria-label="Zur Konzeptauswahl"><Brand/></a><span className="demo-chip">Demodaten · Vergleich</span><a href="/" className="button button-quiet">Zur Auswahl <Icon name="arrow" size={16}/></a></header>
    <div className="compare-heading"><p className="eyebrow">DREI PERSPEKTIVEN. DERSELBE KONTEXT.</p><h1>Welcher Arbeitsplatz passt zu Ihnen?</h1><p>Identische Demo-Mandanten und Kennzahlen. Wählen Sie eine Ansicht für den direkten Vergleich.</p>
      <div className="tabs" role="tablist" aria-label="Vergleichsansicht">{NAV_ITEMS.map(n => <button role="tab" aria-selected={view === n.id} key={n.id} onClick={() => setView(n.id)}>{n.label}</button>)}</div>
      <label className="small" style={{ display: "inline-flex", alignItems: "center", gap: 8, margin: "16px 0 0" }}>Demo-Unternehmen <select value={tenant} onChange={e => setTenant(e.target.value as TenantId)} style={{ font: "inherit", padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "white", color: "var(--text)" }}><option value="atelier">Atelier Nord</option><option value="haven">Haven Estates</option></select></label>
    </div>
    <div className="compare-grid">{(["a", "b", "c"] as const).map((v, i) => <section className={`compare-card compare-${v}`} key={v}><header><span>{v.toUpperCase()}</span><h2>{names[i]}</h2><a href={`/${v}/?tenant=${tenant}#${view}`} className="icon-button" aria-label={`${names[i]} vollständig öffnen`}><Icon name="arrow"/></a></header><div className="compare-viewport"><iframe key={`${v}-${view}-${tenant}`} title={`${names[i]} – ${view}`} srcDoc={window.__EVELYN_FRAME({ ...context, route: v, view, tenant, frame: true })}/></div><a href={`/${v}/?tenant=${tenant}#${view}`} className="concept-open">In voller Größe ausprobieren <Icon name="arrow" size={16}/></a></section>)}</div>
    <p className="compare-note">Alle drei Vorschauen sind interaktiv. Über „In voller Größe ausprobieren“ öffnen Sie das jeweilige Konzept. Alle Daten sind synthetisch.</p>
  </main>;
}

function App() {
  const [context, setContext] = useState<PreviewContext>(() => ({ ...defaults, ...window.__EVELYN_INIT }));
  useEffect(() => {
    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") || "";
      if (!/^\/(?:[abc]\/?)?(?:[?#].*)?$/.test(href) && !/^\/compare\/?(?:[?#].*)?$/.test(href)) return;
      event.preventDefault();
      const url = new URL(href, "https://evelyn-preview.invalid");
      const target = url.pathname.replace(/^\/|\/$/g, "") || "home";
      const current = { ...context, ...window.__EVELYN_CONTEXT };
      const next = { ...current, route: target as PreviewContext["route"] };
      const view = url.hash.slice(1) || url.searchParams.get("view");
      if (NAV_ITEMS.some(item => item.id === view)) next.view = view as ViewId;
      if (url.searchParams.has("tenant")) next.tenant = url.searchParams.get("tenant") === "haven" ? "haven" : "atelier";
      window.__EVELYN_INIT = next;
      window.__EVELYN_CONTEXT = next;
      setContext(next);
      window.scrollTo({ top: 0, behavior: "instant" });
    };
    document.addEventListener("click", navigate);
    return () => document.removeEventListener("click", navigate);
  }, [context]);
  if (context.route === "home") return <Home/>;
  if (context.route === "compare") return <Compare key="compare" context={context}/>;
  return <Demo key={context.route} variant={context.route}/>;
}

createRoot(document.getElementById("root")!).render(<App/>);
