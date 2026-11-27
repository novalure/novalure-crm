"use client";

import {
  getWorkspaceNavigationGroups,
  type WorkspaceNavigationGroup,
} from "@/lib/workspace-navigation";

type NavigationItem<T extends string> = { id: T; label: string };

export function WorkspaceSectionTabs<T extends string>({
  items, activeId, language, onNavigate, groups,
}: {
  items: readonly NavigationItem<T>[];
  activeId: T;
  language: string;
  onNavigate: (id: T) => void;
  groups?: readonly WorkspaceNavigationGroup<NavigationItem<T>>[];
}) {
  const navigationGroups = groups ?? getWorkspaceNavigationGroups(items, language);
  const activeGroup = navigationGroups.find((group) => group.items.some((item) => item.id === activeId));
  if (!activeGroup || activeGroup.items.length < 2) return null;

  return <nav aria-label={activeGroup.label} data-crm-section-tabs data-crm-section-group={activeGroup.id}>
    {activeGroup.items.map((item) => <button
      key={item.id}
      type="button"
      aria-current={item.id === activeId ? "page" : undefined}
      data-active={item.id === activeId ? "true" : "false"}
      data-crm-section-entry={item.id}
      onClick={() => { if (item.id !== activeId) onNavigate(item.id); }}
    >{item.label}</button>)}
  </nav>;
}
