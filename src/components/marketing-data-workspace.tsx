"use client";
import { useEffect, useRef, useState } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";
import {
  emptyMarketingSelection,
  starterMarketingVariants,
  missingNewsletterVariables,
  type MarketingAudience,
  type MarketingLanguage,
  type MarketingTemplate,
  type MarketingSource,
  type MarketingSelection,
} from "@/lib/marketing-domain";
import {
  emptyNewsletterDraft,
  normalizeNewsletterDraft,
  renderApprovedNewsletter,
} from "@/lib/newsletter-workspace";
import type { readMarketingWorkspace } from "@/lib/db/marketing-repository";
type Data = Awaited<ReturnType<typeof readMarketingWorkspace>>;
const marketingSourceStatusLabels: Record<string,string> = { active: "Aktiv", paused: "Pausiert", draft: "Entwurf", entwurf: "Entwurf", bereit: "Bereit", gesendet: "Versand abgeschlossen" };
type Props = {
  workspaceId: string;
  projectId?: string | null;
  language: "de" | "en";
  area?: "campaigns" | "audiences" | "templates";
  country?: "AT" | "DE" | "ES" | "IE" | null;
  onOpenSource?: (source: {
    kind: MarketingSource["kind"];
    id: string;
    propertyId?: string;
    projectId: string;
  }) => void;
};
const field =
  "min-h-11 w-full rounded-md border border-stone-300 bg-white p-2 text-sm";
const button =
  "min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm disabled:opacity-50";
const panel = "space-y-3 rounded-xl border border-stone-200 bg-white p-4";
const reasonLabels: Record<string, string> = {
  allowed_opt_in: "Einwilligung bestätigt",
  missing_opt_in: "Keine bestätigte Newslettereinwilligung",
  opt_out: "Abgemeldet",
  newsletter_suppression: "Versandsperre",
  duplicate_email: "Mehrdeutige E-Mail-Dublette",
  missing_address: "E-Mail fehlt oder ungültig",
};
export function MarketingDataWorkspace(props: Props) {
  return (
    <MarketingDataContent
      key={`${props.workspaceId}:${props.projectId ?? ""}:${props.area ?? "campaigns"}:${props.country ?? ""}`}
      {...props}
    />
  );
}
function MarketingDataContent({
  workspaceId,
  projectId,
  language,
  area = "campaigns",
  country,
  onOpenSource,
}: Props) {
  const t = (de: string, en: string) => (language === "de" ? de : en);
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [project, setProject] = useState(projectId ?? "");
  const [retry, setRetry] = useState(0),
    [hasPending, setHasPending] = useState(false);
  const pending = useRef<{
      body: string;
      key: string;
      correlation: string;
    } | null>(null),
    inFlight = useRef(false);
  const [reportDays, setReportDays] = useState<30 | 90 | 365>(30);
  const query = new URLSearchParams({ workspaceId });
  if (project) query.set("projectId", project);
  query.set("days", String(reportDays));
  const endpoint = `/api/crm/marketing?${query}`;
  async function reload() {
    const response = await fetch(endpoint, { cache: "no-store" });
    const result = (await response.json()) as Data & { error?: string };
    if (
      !response.ok ||
      result.source !== "database" ||
      result.workspaceId !== workspaceId
    )
      throw new Error(
        result.error ||
          t(
            "Marketingdaten konnten nicht geladen werden.",
            "Marketing data could not be loaded.",
          ),
      );
    setData(result);
    return result;
  }
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const value = (await response.json()) as Data & { error?: string };
        if (!response.ok || value.source !== "database")
          throw new Error(
            value.error || "Marketingdaten sind nicht verfügbar.",
          );
        if (!controller.signal.aborted) {
          setData(value);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e.message));
      });
    return () => controller.abort();
  }, [endpoint, retry]);
  async function mutate(body: Record<string, unknown>) {
    if (inFlight.current) return;
    const encoded = JSON.stringify(body);
    if (pending.current && pending.current.body !== encoded) {
      setNotice(
        t(
          "Bitte zuerst den ungeklärten Vorgang erneut prüfen.",
          "Please retry the unknown operation first.",
        ),
      );
      return;
    }
    pending.current ??= {
      body: encoded,
      key: crypto.randomUUID(),
      correlation: crypto.randomUUID(),
    };
    const operation = pending.current;
    setHasPending(true);
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    try {
      const response = await csrfFetch(
        `/api/crm/marketing?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": operation.key,
            "X-Correlation-Id": operation.correlation,
          },
          body: operation.body,
        },
      );
      if (response.status >= 500)
        throw new Error(
          t(
            "Ergebnis ungeklärt. Den gleichen Vorgang erneut prüfen.",
            "Unknown result. Retry the same operation.",
          ),
        );
      const result = await response.json();
      if (!response.ok) {
        pending.current = null;
        setHasPending(false);
        throw new Error(result.error || "Änderung abgelehnt.");
      }
      if (!result.persisted)
        throw new Error("Speicherung noch nicht bestätigt.");
      pending.current = null;
      setHasPending(false);
      await reload();
      setNotice(t("Gespeichert.", "Saved."));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Speicherung fehlgeschlagen.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function retryPending() {
    const operation = pending.current;
    if (operation) void mutate(JSON.parse(operation.body));
  }
  if (!data)
    return (
      <section className={panel} role="status">
        {error ||
          t("Marketingdaten werden geladen…", "Loading marketing data…")}
        {error && (
          <button className={button} onClick={() => setRetry((n) => n + 1)}>
            {t("Erneut laden", "Reload")}
          </button>
        )}
      </section>
    );
  const canEdit = data.canEdit && !busy && !hasPending;
  return (
    <div className="space-y-4">
      <div className={panel}>
        <label className="block max-w-md text-sm">
          {t(
            "Projekt für diese Marketingdaten",
            "Project for this marketing data",
          )}
          <select
            className={field}
            value={project}
            disabled={busy || Boolean(projectId) || hasPending}
            onChange={(e) => {
              setProject(e.target.value);
              setData(null);
            }}
          >
            <option value="">
              {t(
                "Alle freigegebenen Projekte ansehen",
                "View all accessible projects",
              )}
            </option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {!project && (
          <p className="text-sm text-stone-600">
            {t(
              "Zum Anlegen oder Bearbeiten ein Projekt auswählen. Kontakte behalten ihre Originalakte.",
              "Select a project to create or edit. Contacts keep their original record.",
            )}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {hasPending && (
          <button className={button} disabled={busy} onClick={retryPending}>
            {t("Gleichen Vorgang erneut prüfen", "Retry the same operation")}
          </button>
        )}
      </div>
      {area === "audiences" && (
        <AudienceEditor
          key={project}
          data={
            country
              ? {
                  ...data,
                  contacts: data.contacts.filter(
                    (c) => c.countryCode === country,
                  ),
                  audiences: data.audiences.filter(
                    (a) =>
                      !a.selection.countries.length ||
                      a.selection.countries.includes(country),
                  ),
                }
              : data
          }
          projectId={project}
          workspaceId={workspaceId}
          country={country}
          canEdit={canEdit && !!project}
          mutate={mutate}
        />
      )}
      {area === "templates" && (
        <TemplateEditor
          key={project}
          data={data}
          projectId={project}
          canEdit={canEdit && !!project}
          mutate={mutate}
        />
      )}
      {area === "campaigns" && (
        <>
        <label className="grid max-w-xs gap-1 text-sm font-semibold">{t("Ergebnisse im Zeitraum", "Results in period")}<select className={field} value={reportDays} onChange={event => setReportDays(Number(event.target.value) as 30 | 90 | 365)}>{[30,90,365].map(days => <option key={days} value={days}>{days} {t("Tage", "days")}</option>)}</select></label>
        <InitiativeEditor
          key={project}
          data={data}
          projectId={project}
          canEdit={canEdit && !!project}
          mutate={mutate}
          onOpenSource={onOpenSource}
        />
        </>
      )}
    </div>
  );
}
type EditorProps = {
  data: Data;
  projectId: string;
  canEdit: boolean;
  mutate: (body: Record<string, unknown>) => Promise<void>;
};
function AudienceEditor({
  data,
  projectId,
  workspaceId,
  country: countryFilter,
  canEdit,
  mutate,
}: EditorProps & { workspaceId: string; country?: Props["country"] }) {
  const [name, setName] = useState(""),
    [selection, setSelection] = useState<MarketingSelection>(() => ({
      ...emptyMarketingSelection(),
      countries: countryFilter ? [countryFilter] : [],
    })),
    [audience, setAudience] = useState("Alle"),
    [editing, setEditing] = useState<MarketingAudience | null>(null),
    [tagName, setTagName] = useState(""),
    [subject, setSubject] = useState(""),
    [tag, setTag] = useState(""),
    [preview, setPreview] = useState<{
      recipients: Array<{
        contactId: string;
        name: string;
        email: string;
        reason: string;
      }>;
      eligible: number;
      excluded: number;
    } | null>(null),
    [error, setError] = useState("");
  const [profile, setProfile] = useState("");
  const contact = data.contacts.find((c) => c.id === profile);
  const [country, setCountry] = useState(""),
    [locale, setLocale] = useState(""),
    [timezone, setTimezone] = useState("");
  const change = (
    key: "countries" | "languages" | "tagIds",
    value: string,
    checked: boolean,
  ) =>
    setSelection((old) => ({
      ...old,
      [key]: checked
        ? [...old[key], value]
        : old[key].filter((v) => v !== value),
    }));
  async function showPreview(row: MarketingAudience) {
    setError("");
    try {
      const query = new URLSearchParams({
        workspaceId,
        projectId: row.projectId,
        segmentId: row.id,
      });
      const response = await fetch(`/api/crm/newsletter?${query}`, {
        cache: "no-store",
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error || "Vorschau nicht verfügbar.");
      setPreview(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Vorschau nicht verfügbar.");
    }
  }
  const targetType = subject.startsWith("lead:") ? "lead" : "contact",
    targetId = subject.split(":")[1],
    assignment = data.assignments.find(
      (a) =>
        a.tagId === tag &&
        (targetType === "lead"
          ? a.leadId === targetId
          : a.contactId === targetId),
    );
  return (
    <div className="space-y-4">
      <section className={panel}>
        <h3 className="text-lg font-semibold">Zielgruppen</h3>
        {countryFilter && (
          <p className="text-sm text-blue-900">
            Länderansicht {countryFilter}: Kontaktlisten verwenden das gespeicherte
            Kontaktland. Zielgruppen erscheinen, wenn ihre Regel dieses Land
            einschließt. Die Empfängervorschau prüft immer die vollständige
            gespeicherte Zielgruppe.
          </p>
        )}
        <p className="text-sm text-stone-600">
          Projekt, Interesse, Land und bevorzugte Sprache wirken gemeinsam. Jede
          Vorschau und jeder tatsächliche Versand prüfen aktuelle Einwilligung
          und Sperren. Leere Länder-/Sprachlisten bedeuten alle, einschließlich
          unbekannter Angaben.
        </p>
        <fieldset disabled={!canEdit} className="space-y-3">
          <input
            aria-label="Zielgruppenname"
            className={field}
            placeholder="Name der Zielgruppe"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            className={field}
            aria-label="Kontaktart"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
          >
            {[
              "Alle",
              "Käufer",
              "Verkäufer",
              "Investor",
              "Bauträger",
              "Makler",
            ].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <div className="flex flex-wrap gap-4">
            {["AT", "DE", "ES", "IE"].map((x) => (
              <label key={x}>
                <input
                  type="checkbox"
                  checked={selection.countries.includes(x as never)}
                  onChange={(e) => change("countries", x, e.target.checked)}
                />{" "}
                {x}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-4">
            {[
              ["de", "Deutsch"],
              ["en", "English"],
              ["es", "Español"],
            ].map(([x, label]) => (
              <label key={x}>
                <input
                  type="checkbox"
                  checked={selection.languages.includes(x as never)}
                  onChange={(e) => change("languages", x, e.target.checked)}
                />{" "}
                {label}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-4">
            {data.tags
              .filter((x) => x.projectId === projectId)
              .map((x) => (
                <label key={x.id}>
                  <input
                    type="checkbox"
                    checked={selection.tagIds.includes(x.id)}
                    onChange={(e) => change("tagIds", x.id, e.target.checked)}
                  />{" "}
                  {x.name}
                </label>
              ))}
          </div>
          <select
            aria-label="Tagverknüpfung"
            className={field}
            value={selection.tagMatch}
            onChange={(e) =>
              setSelection((old) => ({
                ...old,
                tagMatch: e.target.value as "all" | "any",
              }))
            }
          >
            <option value="all">Alle ausgewählten Tags erforderlich</option>
            <option value="any">Mindestens ein ausgewählter Tag</option>
          </select>
          <button
            className={button}
            disabled={!name.trim()}
            onClick={() =>
              void mutate({
                action: "audience",
                projectId,
                ...(editing ? { id: editing.id } : {}),
                expectedRevision:
                  data.audiences.find((a) => a.id === editing?.id)?.revision ??
                  0,
                name,
                audience,
                selection,
              })
            }
          >
            {editing ? "Zielgruppe aktualisieren" : "Zielgruppe speichern"}
          </button>
          {editing && (
            <button
              className={button}
              onClick={() => {
                setEditing(null);
                setName("");
                setSelection(emptyMarketingSelection());
              }}
            >
              Neue Zielgruppe
            </button>
          )}
        </fieldset>
        <div className="divide-y">
          {data.audiences.map((row) => (
            <div
              className="flex flex-wrap items-center gap-2 py-3"
              key={row.id}
            >
              <span className="grow text-sm">
                {row.name} · Version {row.revision} ·{" "}
                {row.selection.countries.join(", ") || "Alle Länder"} ·{" "}
                {row.selection.languages.join(", ") || "Alle Sprachen"}
              </span>
              <button className={button} onClick={() => void showPreview(row)}>
                Aktuelle Empfänger prüfen
              </button>
              {projectId === row.projectId && (
                <button
                  disabled={!canEdit}
                  className={button}
                  onClick={() => {
                    setEditing(row);
                    setName(row.name);
                    setSelection(row.selection);
                    setAudience(row.audience);
                  }}
                >
                  Bearbeiten
                </button>
              )}
            </div>
          ))}
        </div>
        {error && <p role="alert">{error}</p>}
        {preview && (
          <div className="space-y-2">
            <p>
              {preview.eligible} aktuell berechtigt · {preview.excluded}{" "}
              ausgeschlossen
            </p>
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>E-Mail</th>
                    <th>Ergebnis</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.recipients.map((row) => (
                    <tr key={row.contactId}>
                      <td className="p-2">{row.name}</td>
                      <td>{row.email}</td>
                      <td>{reasonLabels[row.reason] ?? row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
      <section className={panel}>
        <h3 className="font-semibold">
          Interessen-Tags am Originalkontakt oder Lead
        </h3>
        <p className="text-sm text-stone-600">
          Ein Leadtag wirkt nur für den mit diesem Originallead verbundenen
          Kontakt im gleichen Projekt. Tags erteilen keine Einwilligung.
        </p>
        <fieldset disabled={!canEdit} className="space-y-2">
          <div className="flex gap-2">
            <input
              className={field}
              aria-label="Neuer Tag"
              placeholder="z. B. Spanien-Interesse"
              value={tagName}
              onChange={(e) => setTagName(e.target.value)}
            />
            <button
              className={button}
              disabled={!tagName.trim()}
              onClick={() =>
                void mutate({
                  action: "tag",
                  projectId,
                  expectedRevision: 0,
                  name: tagName,
                })
              }
            >
              Tag anlegen
            </button>
          </div>
          <select
            aria-label="Originalkontakt oder Lead"
            className={field}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          >
            <option value="">Kontakt oder Lead wählen</option>
            {data.contacts
              .filter((c) => c.projectId === projectId)
              .map((c) => (
                <option key={c.id} value={`contact:${c.id}`}>
                  Kontakt · {c.name} · {c.email}
                </option>
              ))}
            {data.leads
              .filter((l) => l.projectId === projectId)
              .map((l) => (
                <option key={l.id} value={`lead:${l.id}`}>
                  Lead · {l.name} · {l.id.slice(0, 8)}
                </option>
              ))}
          </select>
          <select
            aria-label="Tag auswählen"
            className={field}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          >
            <option value="">Tag wählen</option>
            {data.tags
              .filter((x) => x.projectId === projectId)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
          <button
            disabled={!subject || !tag}
            className={button}
            onClick={() =>
              void mutate({
                action: "assignTag",
                projectId,
                expectedRevision: assignment?.revision ?? 0,
                tagId: tag,
                subjectType: targetType,
                subjectId: targetId,
                active: !assignment?.active,
                source: "Bewusste Zuordnung im Marketingbereich",
              })
            }
          >
            {assignment?.active ? "Tag entfernen" : "Tag zuordnen"}
          </button>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          {data.assignments
            .filter((a) => a.active)
            .map((a) => (
              <span
                key={a.id}
                className="rounded-full bg-stone-100 px-3 py-1 text-xs"
              >
                {data.tags.find((t) => t.id === a.tagId)?.name} ·{" "}
                {a.contactId
                  ? data.contacts.find((c) => c.id === a.contactId)?.name
                  : data.leads.find((l) => l.id === a.leadId)?.name}
              </span>
            ))}
        </div>
      </section>
      <section className={panel}>
        <h3 className="font-semibold">Land, Sprache und Zeitzone</h3>
        <p className="text-sm text-stone-600">
          Verbindliche eigene Kontaktfelder. Ein Immobilieninteresse in Spanien
          setzt das Wohnsitzland nicht automatisch auf Spanien.
        </p>
        <fieldset disabled={!canEdit} className="grid gap-2 md:grid-cols-2">
          <select
            className={field}
            aria-label="Kontaktprofil"
            value={profile}
            onChange={(e) => {
              const c = data.contacts.find((x) => x.id === e.target.value);
              setProfile(e.target.value);
              setCountry(c?.countryCode ?? "");
              setLocale(c?.preferredLanguage ?? "");
              setTimezone(c?.timezone ?? "");
            }}
          >
            <option value="">Kontakt wählen</option>
            {data.contacts
              .filter((c) => c.projectId === projectId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.email}
                </option>
              ))}
          </select>
          <select
            className={field}
            aria-label="Land"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          >
            <option value="">Land unbekannt</option>
            {["AT", "DE", "ES", "IE"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <select
            className={field}
            aria-label="Bevorzugte Kontaktsprache"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
          >
            <option value="">Sprache unbekannt</option>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
          <select
            className={field}
            aria-label="Kontaktzeitzone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            <option value="">Zeitzone unbekannt</option>
            {[
              ...new Set([
                timezone,
                ...[
                  "Europe/Vienna",
                  "Europe/Berlin",
                  "Europe/Madrid",
                  "Atlantic/Canary",
                  "Europe/Dublin",
                ],
              ]),
            ]
              .filter(Boolean)
              .map((x) => (
                <option key={x}>{x}</option>
              ))}
          </select>
          <button
            disabled={!contact}
            className={button}
            onClick={() =>
              contact &&
              void mutate({
                action: "profile",
                projectId,
                contactId: contact.id,
                expectedRevision: contact.revision,
                countryCode: country || null,
                preferredLanguage: locale || null,
                timezone: timezone || null,
              })
            }
          >
            Kontaktangaben speichern
          </button>
        </fieldset>
        {(data.contactsTruncated || data.leadsTruncated) && (
          <p className="text-sm text-amber-800">
            Die Auswahlliste zeigt höchstens 1.000 Originalkontakte/Leads. Die
            serverseitige Mailingprüfung berücksichtigt weiterhin bis zu 10.000
            passende Kontakte.
          </p>
        )}
      </section>
    </div>
  );
}
function TemplateEditor({ data, projectId, canEdit, mutate }: EditorProps) {
  const [editing, setEditing] = useState<MarketingTemplate | null>(null),
    [name, setName] = useState("Projektinformation"),
    [variants, setVariants] = useState<MarketingTemplate["variants"]>(
      starterMarketingVariants,
    ),
    [language, setLanguage] = useState<MarketingLanguage>("de"),
    [contactId, setContactId] = useState("");
  const variant = variants[language],
    contact = data.contacts.find((c) => c.id === contactId),
    project = data.projects.find((p) => p.id === projectId),
    context = {
      contactName: contact?.name,
      projectName: project?.name,
      agentName: data.agentName,
    };
  let html = "",
    missing: string[] = [];
  try {
    if (variant) {
      const draft = normalizeNewsletterDraft({
        ...emptyNewsletterDraft(),
        ...variant,
        language,
      });
      missing = missingNewsletterVariables(draft, context);
      html = renderApprovedNewsletter(draft, {
        contactName: context.contactName ?? "",
        projectName: context.projectName ?? "",
        agentName: context.agentName,
        unsubscribeUrl: "",
        test: true,
      });
    }
  } catch {
    missing = ["Vorlageninhalt ist ungültig."];
  }
  function update(field: "subject" | "previewText" | "body", value: string) {
    setVariants((old) => ({
      ...old,
      [language]: {
        subject: old[language]?.subject ?? "",
        previewText: old[language]?.previewText ?? "",
        contentBlocks:
          field === "body"
            ? [{ id: "text", type: "text" as const, text: value }]
            : (old[language]?.contentBlocks ?? []),
        ...(field === "body" ? {} : { [field]: value }),
      },
    }));
  }
  return (
    <section className={panel}>
      <h3 className="text-lg font-semibold">Gespeicherte Mailingvorlagen</h3>
      <p className="text-sm text-stone-600">
        DE, EN und ES werden getrennt gespeichert. Ein Mailing übernimmt eine
        konkrete Vorlagenrevision und Sprache; spätere Vorlagenänderungen ändern
        den Mailingentwurf nicht. Pflichtvariablen: {"{{contact.name}}"},{" "}
        {"{{project.name}}"}, {"{{agent.name}}"}.
      </p>
      <div className="flex flex-wrap gap-2">
        {data.templates.map((row) => (
          <button
            key={row.id}
            className={button}
            onClick={() => {
              setEditing(row);
              setName(row.name);
              setVariants(row.variants);
              setLanguage(
                (Object.keys(row.variants)[0] ?? "de") as MarketingLanguage,
              );
            }}
          >
            {row.name} · V{row.revision}
          </button>
        ))}
      </div>
      <fieldset disabled={!canEdit} className="space-y-2">
        <input
          className={field}
          aria-label="Vorlagenname"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className={field}
          aria-label="Vorlagensprache"
          value={language}
          onChange={(e) => setLanguage(e.target.value as MarketingLanguage)}
        >
          <option value="de">Deutsch</option>
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
        {!variant ? (
          <button
            className={button}
            onClick={() =>
              setVariants((old) => ({
                ...old,
                [language]: starterMarketingVariants()[language],
              }))
            }
          >
            Sprachvariante hinzufügen
          </button>
        ) : (
          <>
            <input
              aria-label="Vorlagenbetreff"
              className={field}
              placeholder="Betreff"
              value={variant.subject}
              onChange={(e) => update("subject", e.target.value)}
            />
            <input
              aria-label="Vorlagenvorschautext"
              className={field}
              placeholder="Vorschautext"
              value={variant.previewText}
              onChange={(e) => update("previewText", e.target.value)}
            />
            <textarea
              aria-label="Textvorlage"
              className={`${field} min-h-44`}
              value={variant.contentBlocks
                .filter((b) => b.type === "text" || b.type === "heading")
                .map((b) => ("text" in b ? b.text : ""))
                .join("\n\n")}
              onChange={(e) => update("body", e.target.value)}
            />
            {variant.contentBlocks.some(
              (b) => !["text", "heading"].includes(b.type),
            ) && (
              <p className="text-sm text-amber-800">
                Diese Vorlage enthält weitere Inhaltsblöcke. Eine Bearbeitung im
                Textfeld ersetzt sie durch eine Textvorlage. Für Bilder und
                Buttons den Mailingeditor verwenden und dort als Vorlage
                speichern.
              </p>
            )}
          </>
        )}
        <button
          className={button}
          disabled={!name.trim()}
          onClick={() =>
            void mutate({
              action: "template",
              projectId,
              ...(editing ? { id: editing.id } : {}),
              expectedRevision:
                data.templates.find((t) => t.id === editing?.id)?.revision ?? 0,
              name,
              variants,
            })
          }
        >
          {editing ? "Neue Vorlagenrevision speichern" : "Vorlage speichern"}
        </button>
        <button
          className={button}
          onClick={() => {
            setEditing(null);
            setName("Neue Projektinformation");
            setVariants(starterMarketingVariants());
          }}
        >
          Neue Vorlage
        </button>
      </fieldset>
      <label className="block text-sm">
        Variablenvorschau mit Originalkontakt
        <select
          className={field}
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
        >
          <option value="">Kontakt für Vorschau wählen</option>
          {data.contacts
            .filter((c) => c.projectId === projectId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      {missing.length > 0 && (
        <p className="text-sm text-amber-800" role="status">
          Fehlende Pflichtvariablen: {missing.join(", ")}. Die Mailingfreigabe
          blockiert fehlende Werte.
        </p>
      )}
      {html && (
        <iframe
          title="Mailingvorlage mit Variablenvorschau"
          sandbox=""
          srcDoc={html}
          className="h-80 w-full rounded-md border border-stone-200"
        />
      )}
    </section>
  );
}
function InitiativeEditor({
  data,
  projectId,
  canEdit,
  mutate,
  onOpenSource,
}: EditorProps & Pick<Props, "onOpenSource">) {
  const [selected, setSelected] = useState(""),
    [name, setName] = useState(""),
    [goal, setGoal] = useState(""),
    [source, setSource] = useState("");
  const current = data.initiatives.find((i) => i.id === selected);
  const sourceRow = data.sources.find((s) => `${s.kind}:${s.id}` === source),
    link =
      sourceRow &&
      data.links.find(
        (l) =>
          l.initiativeId === selected &&
          l.kind === sourceRow.kind &&
          l.sourceId === sourceRow.id,
      );
  return (
    <section className={panel}>
      <h3 className="text-lg font-semibold">
        Marketingvorhaben und Originalquellen
      </h3>
      {data.unavailableSources.length ? <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm">Einige Originalbereiche sind im Zielsystem noch nicht lesbar oder eingerichtet: {data.unavailableSources.map(kind=>({newsletter:"Mailings",automation:"Flows",funnel:"Landingpages",form:"Formulare",expose:"Exposéwebsites"}[kind])).join(", ")}. Die übrigen Quellen bleiben verfügbar.</p> : null}
      <p className="text-sm text-stone-600">
        Ein Vorhaben verbindet die vorhandenen Mailings, Flows, Formulare,
        Landingpages und Immobilienwebsites. Ergebnisse bleiben an ihrer
        Originalquelle. Es werden keine Kontakte, Einwilligungen oder
        Anzeigenkennzahlen kopiert.
      </p>
      <div className="flex flex-wrap gap-2">
        {data.initiatives.map((i) => (
          <button
            className={button}
            key={i.id}
            onClick={() => {
              setSelected(i.id);
              setName(i.name);
              setGoal(i.goal);
            }}
          >
            {i.name}
          </button>
        ))}
      </div>
      <fieldset disabled={!canEdit} className="space-y-2">
        <input
          className={field}
          placeholder="Name des Marketingvorhabens"
          aria-label="Marketingvorhabenname"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          className={field}
          placeholder="Ziel und Verantwortlichkeit"
          aria-label="Marketingziel"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        <button
          className={button}
          disabled={!name.trim()}
          onClick={() =>
            void mutate({
              action: "initiative",
              projectId,
              ...(current ? { id: current.id } : {}),
              expectedRevision: current?.revision ?? 0,
              name,
              goal,
            })
          }
        >
          {current ? "Vorhaben aktualisieren" : "Vorhaben anlegen"}
        </button>
        <button
          className={button}
          onClick={() => {
            setSelected("");
            setName("");
            setGoal("");
          }}
        >
          Neues Vorhaben
        </button>
        {current && (
          <>
            <select
              className={field}
              aria-label="Originalquelle verbinden"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">Originalquelle wählen</option>
              {data.sources
                .filter((s) => s.projectId === current.projectId)
                .map((s) => (
                  <option key={`${s.kind}:${s.id}`} value={`${s.kind}:${s.id}`}>
                    {{newsletter:"Mailing",automation:"Flow",funnel:"Landingpage",expose:"Exposéwebsite",form:"Formular"}[s.kind]} · {s.name} · {marketingSourceStatusLabels[s.status] ?? s.status}
                  </option>
                ))}
            </select>
            <button
              className={button}
              disabled={!sourceRow}
              onClick={() =>
                sourceRow &&
                void mutate({
                  action: "sourceLink",
                  projectId,
                  expectedRevision: link?.revision ?? 0,
                  initiativeId: current.id,
                  kind: sourceRow.kind,
                  sourceId: sourceRow.id,
                  active: !link?.active,
                })
              }
            >
              {link?.active ? "Quelle lösen" : "Quelle verbinden"}
            </button>
          </>
        )}
      </fieldset>
      <div className="divide-y">
        {data.links
          .filter((l) => l.active && (!selected || l.initiativeId === selected))
          .map((l) => {
            const s = data.sources.find(
              (s) => s.kind === l.kind && s.id === l.sourceId,
            );
            return (
              <div key={l.id} className="space-y-1 py-3">
                <p className="font-medium">
                  {data.initiatives.find((i) => i.id === l.initiativeId)?.name}{" "}
                  · {s?.name ?? "Originalquelle aktuell nicht verfügbar"}
                </p>
                {s && (
                  <>
                    <p className="text-sm">
                      {{newsletter:"Mailing",automation:"Flow",funnel:"Landingpage",expose:"Exposéwebsite",form:"Formular"}[s.kind]} · {marketingSourceStatusLabels[s.status] ?? s.status}
                    </p>
                    <p className="text-sm text-stone-600">
                      {!data.report.canReadResults ? "Für Ergebnisse fehlt die aktuelle Auswertungsberechtigung." : !Object.keys(s.results).length && s.kind!=="automation" ? "Die Ergebnisquelle ist noch nicht verfügbar bzw. enthält keine gespeicherten Versandbelege." : s.kind === "newsletter"
                        ? `${s.results.accepted ?? 0} vom Versanddienst angenommen · ${s.results.suppressed ?? 0} vor Versand ausgeschlossen · ${s.results["provider:email.delivered"] ?? 0} signierte Zustellbelege · ${s.results["provider:email.bounced"] ?? 0} Bounce-Belege; Annahme ist kein Zustell- oder Lesebeleg.`
                        : s.kind === "expose"
                          ? `${s.results.inquiries ?? 0} gespeicherte Anfragen · ${s.results.measuredVisits ?? 0} gemessene Besuche mit Statistikeinwilligung · ${Math.round((s.results.activeMs ?? 0)/1000)} aktive Abschnittssekunden · ${s.results.actions ?? 0} gemessene Aktionen. Messung belegt keine Identität und kein Lesen.`
                          : s.kind === "form" || s.kind === "funnel" ? `${s.results.incomingSubmissions ?? 0} gespeicherte öffentliche Einreichungen; mehrere Einreichungen können zum selben Lead gehören.`
                          : `${s.results["run:completed"] ?? 0} abgeschlossene Läufe · ${(s.results["run:review"] ?? 0)+(s.results["run:blocked"] ?? 0)+(s.results["run:failed"] ?? 0)} Läufe zu prüfen.`}
                    </p>
                    {onOpenSource && (
                      <button
                        className={button}
                        onClick={() => onOpenSource(s)}
                      >
                        Originalvorgang öffnen
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
      </div>
      {data.report.canReadResults ? <section className="space-y-3 border-t border-stone-200 pt-4"><h4 className="font-semibold">Gespeicherte Herkunft und Folgeanfragen</h4><p className="text-sm leading-6 text-stone-600">Letzte {data.report.days} Tage · Stand {new Date(data.report.asOf).toLocaleString("de-AT")}. „Erste“ bezeichnet die erste gespeicherte öffentliche Einreichung dieses sichtbaren CRM-Leads. Weitere Einreichungen werden getrennt gezählt; dies ist kein Nachweis einer Werbeeinblendung oder vollständigen Werbewirkung. UTM-Werte stammen aus der gespeicherten Anfrage, Exposékanäle aus dem verwendeten Link.</p><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["Originalquelle","Quelle / Medium","UTM-Kampagne","Einreichungen","Erste","Weitere"].map(title=><th className="p-2" key={title}>{title}</th>)}</tr></thead><tbody>{data.attribution.filter(row => !selected || data.links.some(link=>link.active&&link.initiativeId===selected&&link.kind===row.kind&&link.sourceId===row.sourceId)).map((row,index)=><tr key={`${row.kind}:${row.sourceId}:${index}`} className="border-t border-stone-100"><td className="p-2">{data.sources.find(source=>source.kind===row.kind&&source.id===row.sourceId)?.name??"Originalquelle"}</td><td className="p-2">{row.source} / {row.medium}</td><td className="p-2">{row.campaign}</td><td className="p-2">{row.submissions}</td><td className="p-2">{row.firstRecorded}</td><td className="p-2">{row.subsequent}</td></tr>)}</tbody></table></div>{!data.attribution.length?<p className="text-sm text-stone-500">Keine gespeicherten öffentlichen Anfragen im Zeitraum.</p>:null}{data.attributionTruncated?<p className="text-xs text-stone-500">Die ersten200 Herkunftsgruppen sind sichtbar. Bitte den Projektbereich oder Zeitraum eingrenzen.</p>:null}<p className="text-xs leading-5 text-stone-500">Quellen werden einzeln ausgewertet und können sich auf dieselben Personen beziehen. Kosten und ROAS benötigen belegte Anbieterdaten. Termine, Reservierungen und bestätigte Verkäufe stehen im ursprünglichen Projektbericht; sie werden hier keiner Werbung zugerechnet.</p></section>:null}
      {data.report.canReadResults ? <RelatedOutcomeSummary data={data} selectedInitiativeId={selected} /> : null}
    </section>
  );
}

function RelatedOutcomeSummary({data,selectedInitiativeId}:{data:Data;selectedInitiativeId:string}) {
  const rows=data.relatedOutcomes.filter(row=>selectedInitiativeId?data.links.some(link=>link.active&&link.initiativeId===selectedInitiativeId&&link.kind===row.kind&&link.sourceId===row.sourceId):(row.cohortLeads??0)>0);
  const number=(value:number|null)=>value===null?"—":value.toLocaleString("de-AT",{maximumFractionDigits:1});
  return <section className="space-y-3 border-t border-stone-200 pt-4">
    <h4 className="font-semibold">Bearbeitung und zugehörige Originalergebnisse</h4>
    <p className="text-sm leading-6 text-stone-600">Ausgangspunkt sind eindeutig zugeordnete Leads mit einer öffentlichen Anfrage oder einem Flowstart in den letzten {data.report.days} Tagen. Jede Zeile zeigt eigene Originaldatensätze. Dieselben Leads und Ergebnisse können zu mehreren Quellen gehören; die Zeilen werden nicht addiert und belegen keine Werbewirkung.</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-left text-sm"><thead><tr>{["Originalquelle","Zugeordnete Leads","Bestätigte Termine · aktuell","Verbindliche Reservierungen · aktuell","Bestätigte Verkäufe · danach","Datierte gewonnene Vorgänge · danach","Zeit bis zur ersten belegten Flowmail-Annahme · Minuten"].map(title=><th className="p-2 align-top" key={title}>{title}</th>)}</tr></thead><tbody>{rows.map(row=><tr className="border-t border-stone-100" key={`${row.kind}:${row.sourceId}`}><td className="p-2 align-top">{data.sources.find(source=>source.kind===row.kind&&source.id===row.sourceId)?.name??"Originalquelle"}{row.kind==="newsletter"?<p className="mt-1 text-xs text-stone-500">Die Mailingempfänger haben hier keinen eindeutigen Leadbezug.</p>:null}</td><td className="p-2 align-top">{number(row.cohortLeads)}</td><td className="p-2 align-top">{number(row.confirmedViewings)}</td><td className="p-2 align-top">{number(row.bindingReservations)}</td><td className="p-2 align-top">{number(row.confirmedSalesAfterEnquiry)}</td><td className="p-2 align-top">{number(row.datedWonDealsAfterEnquiry)}{row.wonDealsWithoutDate?<p className="mt-1 text-xs text-stone-500">{number(row.wonDealsWithoutDate)} weitere gewonnene Vorgänge ohne Abschlussdatum; zeitlich nicht zugerechnet.</p>:null}</td><td className="p-2 align-top">{number(row.averageFirstFlowMailMinutes)}<p className="mt-1 text-xs text-stone-500">{row.flowMailSampleLeads===null?"Mailquelle nicht verfügbar.":`${number(row.flowMailSampleLeads)} Leads mit Annahmebeleg · ${number(row.leadsWithoutFlowMailEvidence)} ohne solchen Beleg.`}</p></td></tr>)}</tbody></table></div>
    {!rows.length?<p className="text-sm text-stone-500">Für diese Auswahl sind keine eindeutig zugeordneten Leadereignisse gespeichert. Verknüpfe Originalquellen oder grenze ein Vorhaben ein.</p>:null}
    <p className="text-xs leading-5 text-stone-500">Termine und belegte, noch gültige Reservierungen sind der aktuelle Bestand dieser Leads; ein unbekanntes Bestätigungsdatum wird keinem Zeitraum zugerechnet. Verkäufe und gewonnene Vorgänge zählen nur mit bestätigtem Abschlusszeitpunkt nach der ersten Anfrage bzw. dem Flowstart dieses Leads im gewählten Zeitraum. „—“ bedeutet nicht verfügbar oder bei Zeitwerten kein Annahmebeleg.</p>
    <p className="text-xs leading-5 text-stone-500">Die Zeitkennzahl ist der Durchschnitt vom ersten zugehörigen Ereignis im Zeitraum bis zur ersten danach belegten Anbieterannahme einer ausdrücklich diesem Lead zugeordneten Flowmail. Sie ist keine allgemeine Erstreaktionszeit und kein Zustell-/Lesebeleg. Newsletter, Eingänge, Aufgaben, Notizen und Telefonprotokolle zählen dafür nicht. Im Projektbericht bleiben Bestand und Vertrieb unabhängig von dieser Quellenauswahl erreichbar.</p>
  </section>;
}
