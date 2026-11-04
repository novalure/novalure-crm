"use client";
import type { ReactNode } from "react";

const daily = new Set(["dashboard", "marketing", "dailyQueue", "properties", "leadInbox", "sellerLeads", "buyerLeads", "developerLeads", "pipelines", "projectPipeline", "tasks", "calendar"]);
export function WorkspaceNavigation<T extends string>({ items, activeId, collapsed, language, onNavigate, renderIcon }: {
  items: { id: T; label: string }[]; activeId: T; collapsed: boolean; language: string;
  onNavigate: (id: T) => void; renderIcon: (id: T) => ReactNode;
}) {
  const compact = items.length > 10;
  const primary = compact ? items.filter(item => daily.has(item.id)) : items;
  const secondary = compact ? items.filter(item => !daily.has(item.id)) : [];
  const render = (item: typeof items[number]) => <button key={item.id} type="button" aria-current={activeId === item.id ? "page" : undefined} aria-label={item.label} title={item.label}
    data-active={activeId === item.id ? "true" : "false"} data-crm-nav-item onClick={() => onNavigate(item.id)}
    className={`flex w-full items-center rounded-md py-2.5 text-left ${activeId === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-stone-100 hover:text-slate-950"} ${collapsed ? "justify-center px-0" : "justify-between px-3"}`}>
    {renderIcon(item.id)}{!collapsed ? <span className="min-w-0 break-words">{item.label}</span> : null}
  </button>;
  return <>{primary.map(render)}{secondary.length ? <details className="mt-3 border-t border-stone-200 pt-3" open={secondary.some(item => item.id === activeId) || undefined}>
    <summary className="cursor-pointer rounded-md px-3 py-2 text-xs font-semibold text-stone-600" title={language === "de" ? "Weitere Bereiche" : "More areas"}>{collapsed ? "•••" : language === "de" ? "Weitere Bereiche" : "More areas"}</summary>
    <div className="mt-2 space-y-1">{secondary.map(render)}</div>
  </details> : null}</>;
}
