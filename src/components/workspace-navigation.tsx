"use client";

import type { ReactNode } from "react";
import {
  getWorkspaceNavigationGroups,
  getWorkspaceNavigationTarget,
  type WorkspaceNavigationGroup,
} from "@/lib/workspace-navigation";

type NavigationItem<T extends string> = { id: T; label: string };

export function WorkspaceNavigation<T extends string>({
  items, activeId, collapsed, language, onNavigate, onActiveNavigate, renderIcon, groups, area = "all",
}: {
  items: readonly NavigationItem<T>[];
  activeId: T;
  collapsed: boolean;
  language: string;
  onNavigate: (id: T) => void;
  onActiveNavigate?: () => void;
  renderIcon: (id: T) => ReactNode;
  groups?: readonly WorkspaceNavigationGroup<NavigationItem<T>>[];
  area?: "primary" | "utility" | "all";
}) {
  const navigationGroups = groups ?? getWorkspaceNavigationGroups(items, language);
  const visibleGroups = navigationGroups.filter((group) =>
    area === "all" || (area === "utility" ? group.isUtility : !group.isUtility),
  );

  return <>{visibleGroups.map((group) => {
    const target = getWorkspaceNavigationTarget(group, activeId);
    if (!target) return null;
    const active = group.items.some((item) => item.id === activeId);
    return <button
      key={group.id}
      type="button"
      aria-current={active ? "page" : undefined}
      aria-label={group.label}
      title={group.label}
      data-active={active ? "true" : "false"}
      data-crm-nav-item
      data-crm-nav-group={group.id}
      data-crm-nav-target={target.id}
      onClick={() => {
        if (target.id === activeId) onActiveNavigate?.();
        else onNavigate(target.id);
      }}
      className={`flex w-full items-center rounded-md text-left ${collapsed ? "justify-center" : "gap-3"}`}
    >
      {renderIcon(group.items[0].id)}
      {!collapsed ? <span className="min-w-0 truncate">{group.label}</span> : null}
    </button>;
  })}</>;
}
