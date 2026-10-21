"use client";

import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  Button as BaseButton,
  IconButton as BaseIconButton,
} from "../../src/components/ui/button";
import type {
  ButtonProps,
  IconButtonProps,
} from "../../src/components/ui/button";
import { Surface } from "../../src/components/ui/surface";
import { StatusChip, Notice } from "../../src/components/ui/status";
import {
  EmptyState as BaseEmptyState,
  LoadingState as BaseLoadingState,
} from "../../src/components/ui/states";

export { Field, Input, Select, Textarea } from "../../src/components/ui/field";
export { Notice };

export function Button({
  className = "",
  variant = "primary",
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      {...props}
      className={`dc-button ${className}`}
      data-variant={variant}
      variant={variant}
    />
  );
}

export function IconButton({
  className = "",
  variant = "ghost",
  ...props
}: IconButtonProps) {
  return (
    <BaseIconButton
      {...props}
      className={`dc-button ${className}`}
      data-variant={variant}
      variant={variant}
    />
  );
}

const iconPaths: Record<string, ReactNode> = {
  home: (
    <>
      <path d="m3 11 9-8 9 8v10h-6v-7H9v7H3Z" />
    </>
  ),
  megaphone: (
    <>
      <path d="M3 9h5l12-5v16L8 15H3ZM8 15l2 6H6l-2-6M8 9v6" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3" y="7" width="18" height="14" rx="2" />
      <path d="M8 7V3h8v4M3 12a20 20 0 0 0 18 0M10 13h4v3h-4Z" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5" />
    </>
  ),
  layers: <path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5" />,
  sparkles: (
    <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4" />
  ),
  book: (
    <path d="M12 5C9 2 5 3 2 4v16c3-1 7-2 10 1 3-3 7-2 10-1V4c-3-1-7-2-10 1v16Z" />
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  plus: <path d="M12 4v16M4 12h16" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l4 2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
  file: <path d="M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 13h8M8 17h6" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 2v6M17 2v6M3 11h18M7 15h2m4 0h2" />
    </>
  ),
  settings: (
    <>
      <path d="m10 3-1 3-3 1-3 3 2 2-1 4 3 1 2 4 3-1 3 1 2-4 3-1-1-4 2-2-3-3-3-1-1-3Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  chat: (
    <>
      <path d="M21 11a9 9 0 0 1-9 9H3l1-5A9 9 0 1 1 21 11Z" />
      <path d="M8 10h8M8 14h5" />
    </>
  ),
  phone: <path d="m5 3 4 3-2 4 7 7 4-2 3 4c-4 8-23-11-16-16Z" />,
  chart: <path d="M3 3v18h18M7 16l4-5 4 2 6-8" />,
  building: (
    <path d="M4 21V5l8-3 8 3v16M2 21h20M9 21v-4h6v4M8 7h1m6 0h1M8 11h1m6 0h1" />
  ),
  wallet: (
    <>
      <rect x="3" y="5" width="18" height="15" rx="2" />
      <path d="M3 8V4l14-2v3M16 11h5v5h-5z" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  bell: <path d="M5 16h14l-2-4V9a5 5 0 0 0-10 0v3l-2 4ZM10 20h4" />,
  upload: <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />,
  download: <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" />,
  shield: (
    <>
      <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" />
    </>
  ),
  moon: <path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z" />,
  monitor: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M12 17v4M7 21h10" />
    </>
  ),
  mobile: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <path d="M10 18h4" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01" />
    </>
  ),
  activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 6 9 7 9-7" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {iconPaths[name] ?? iconPaths.sparkles}
    </svg>
  );
}

export function Card({
  title,
  eyebrow,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Surface className={`dc-card ${className}`}>
      {(title || eyebrow || actions) && (
        <div className="dc-card-heading">
          <div>
            {eyebrow && <p className="dc-eyebrow">{eyebrow}</p>}
            {title && <h2>{title}</h2>}
          </div>
          {actions && <div className="dc-row">{actions}</div>}
        </div>
      )}
      {children}
    </Surface>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "info" | "success" | "warning" | "danger" | "violet";
  children: ReactNode;
}) {
  return (
    <StatusChip
      className={`dc-badge dc-badge-${tone}`}
      tone={tone === "violet" ? "info" : tone}
    >
      {children}
    </StatusChip>
  );
}

/** Section navigation with pressed buttons; consumers do not need tab panels. */
export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: { id: string; label: string; disabled?: boolean }[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      container.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? [],
    );
    if (!buttons.length) return;
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
            buttons.length;
    event.preventDefault();
    buttons[target]?.focus();
  }
  return (
    <div
      aria-label={label}
      className="dc-tabs"
      onKeyDown={handleKeys}
      ref={container}
      role="group"
    >
      {items.map((item) => (
        <button
          aria-pressed={value === item.id}
          disabled={item.disabled}
          key={item.id}
          onClick={() => onChange(item.id)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export type DataTableColumn = { key: string; label: string };
export type DataTableRow = {
  id: string;
  cells: Record<string, ReactNode>;
  search: string;
  status?: string;
  /** Raw values preserve numeric order independently of localized cell text. */
  sortValues?: Record<string, string | number>;
};

function nodeText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? nodeText(child.props.children)
          : "",
    )
    .join(" ");
}

export function DataTable({
  caption,
  columns,
  rows,
  emptyMessage = "Keine Einträge gefunden.",
}: {
  caption: string;
  columns: DataTableColumn[];
  rows: DataTableRow[];
  emptyMessage?: string;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<{
    key: string;
    direction: "ascending" | "descending";
  } | null>(null);
  const [requestedPage, setPage] = useState(1);
  const pageSize = 6;
  const statuses = Array.from(
    new Set(
      rows
        .map((row) => row.status)
        .filter((item): item is string => Boolean(item)),
    ),
  );
  const effectiveStatus = statuses.includes(status) ? status : "";
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("de");
    const result = rows.filter(
      (row) =>
        (!needle || row.search.toLocaleLowerCase("de").includes(needle)) &&
        (!effectiveStatus || row.status === effectiveStatus),
    );
    if (sort)
      result.sort((a, b) => {
        const left = a.sortValues?.[sort.key] ?? nodeText(a.cells[sort.key]);
        const right = b.sortValues?.[sort.key] ?? nodeText(b.cells[sort.key]);
        const comparison =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right), "de", { numeric: true });
        return comparison * (sort.direction === "ascending" ? 1 : -1);
      });
    return result;
  }, [rows, query, effectiveStatus, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.max(1, Math.min(requestedPage, pages));
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
  const isFiltered = Boolean(query || status || sort);
  function changeSort(key: string) {
    setSort(
      sort?.key === key
        ? sort.direction === "ascending"
          ? { key, direction: "descending" }
          : null
        : { key, direction: "ascending" },
    );
    setPage(1);
  }
  function reset() {
    setQuery("");
    setStatus("");
    setSort(null);
    setPage(1);
  }

  return (
    <div className="dc-data-table">
      <div className="dc-table-toolbar">
        <label className="dc-table-search" htmlFor={`${id}-search`}>
          <Icon name="search" size={18} />
          <span className="dc-sr-only">{caption} durchsuchen</span>
          <input
            id={`${id}-search`}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Einträge durchsuchen …"
            type="search"
            value={query}
          />
        </label>
        {statuses.length > 0 && (
          <label className="dc-table-filter" htmlFor={`${id}-status`}>
            <span className="dc-sr-only">Nach Status filtern</span>
            <select
              id={`${id}-status`}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
              value={effectiveStatus}
            >
              <option value="">Alle Status</option>
              {statuses.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button disabled={!isFiltered} onClick={reset} variant="ghost">
          Zurücksetzen
        </Button>
      </div>
      <div
        aria-label={`${caption} – horizontal scrollbare Tabelle`}
        className="dc-table-scroll"
        role="region"
        tabIndex={0}
      >
        <table className="dc-table">
          <caption className="dc-sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  aria-sort={sort?.key === column.key ? sort.direction : "none"}
                  key={column.key}
                  scope="col"
                >
                  <button onClick={() => changeSort(column.key)} type="button">
                    {column.label}
                    <span aria-hidden="true">
                      {sort?.key === column.key
                        ? sort.direction === "ascending"
                          ? "↑"
                          : "↓"
                        : "↕"}
                    </span>
                    <span className="dc-sr-only">: sortieren</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id}>
                {columns.map((column) => (
                  <td key={column.key}>{row.cells[column.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <EmptyState title={emptyMessage}>
            Passe die Suche oder den Statusfilter an.
          </EmptyState>
        )}
      </div>
      <div className="dc-table-pagination">
        <p aria-live="polite" aria-atomic="true">
          {filtered.length === 0
            ? "0"
            : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, filtered.length)}`}{" "}
          von {filtered.length} Einträgen
        </p>
        <nav aria-label={`${caption}: Seiten`}>
          <Button
            aria-label="Vorherige Seite"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
            variant="secondary"
          >
            Zurück
          </Button>
          <span>
            Seite {page} von {pages}
          </span>
          <Button
            aria-label="Nächste Seite"
            disabled={page === pages}
            onClick={() => setPage(page + 1)}
            variant="secondary"
          >
            Weiter
          </Button>
        </nav>
      </div>
    </div>
  );
}

export function Dialog({
  open,
  title,
  onClose,
  closeLabel = "Dialog schließen",
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [open]);
  return (
    <dialog
      aria-labelledby={titleId}
      className="dc-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={ref}
    >
      <div className="dc-dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <IconButton aria-label={closeLabel} onClick={onClose}>
          <Icon name="close" />
        </IconButton>
      </div>
      <div className="dc-dialog-body">{children}</div>
    </dialog>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <BaseEmptyState
      className="dc-empty-state"
      description={children}
      title={title}
    />
  );
}

export function LoadingState({
  title = "Wird geladen …",
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <BaseLoadingState
      className="dc-loading-state"
      description={children}
      title={title}
    />
  );
}

export function MetricCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: string;
}) {
  return (
    <Surface className="dc-metric" padding="compact">
      <div className="dc-metric-label">
        <span>{label}</span>
        {icon && <Icon name={icon} size={18} />}
      </div>
      <strong>{value}</strong>
      {detail && <p>{detail}</p>}
    </Surface>
  );
}

export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="dc-page-heading">
      <div>
        {eyebrow && <p className="dc-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="dc-page-description">{description}</p>}
      </div>
      {actions && <div className="dc-row">{actions}</div>}
    </div>
  );
}
