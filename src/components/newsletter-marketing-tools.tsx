"use client";
import { useState } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";
import type { readNewsletterWorkspace } from "@/lib/db/newsletter-workspace-repository";
type Data = Awaited<ReturnType<typeof readNewsletterWorkspace>>;
export function NewsletterMarketingTools({
  data,
  campaignId,
  workspaceId,
  disabled,
  onSelect,
  onConfigure,
  onChanged,
}: {
  data: Data;
  campaignId: string;
  workspaceId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onConfigure: (body: Record<string, unknown>) => Promise<void>;
  onChanged: () => Promise<unknown>;
}) {
  const [templateId, setTemplateId] = useState(""),
    [templateLanguage, setTemplateLanguage] = useState<"de" | "en" | "es">(
      "de",
    ),
    [segmentId, setSegmentId] = useState(""),
    [name, setName] = useState(""),
    [notice, setNotice] = useState(""),
    [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<{
    body: string;
    key: string;
    correlation: string;
  } | null>(null);
  const draft = data.drafts.find((d) => d.campaignId === campaignId),
    template = data.templates.find(
      (t) => t.id === templateId && t.projectId === draft?.projectId,
    ),
    binding = data.templateBindings.find((b) => b.campaignId === campaignId);
  const field =
      "min-h-11 rounded-md border border-stone-300 bg-white p-2 text-sm",
    button =
      "min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm disabled:opacity-50";
  async function saveTemplate() {
    if (!draft || saving || !name.trim()) return;
    setSaving(true);
    setNotice("");
    const body = JSON.stringify({
      action: "template",
      projectId: draft.projectId,
      expectedRevision: 0,
      name,
      variants: {
        [draft.input.language]: {
          subject: draft.input.subject,
          previewText: draft.input.previewText,
          contentBlocks: draft.input.contentBlocks,
        },
      },
    });
    if (pending && pending.body !== body) {
      setNotice("Bitte zuerst denselben ungeklärten Vorlagenvorgang prüfen.");
      setSaving(false);
      return;
    }
    const operation = pending ?? {
      body,
      key: crypto.randomUUID(),
      correlation: crypto.randomUUID(),
    };
    setPending(operation);
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
          "Ergebnis ungeklärt. Bitte denselben Vorgang erneut prüfen.",
        );
      const result = await response.json();
      if (!response.ok) {
        setPending(null);
        throw new Error(result.error || "Vorlage abgelehnt.");
      }
      if (!result.persisted)
        throw new Error("Speicherung noch nicht bestätigt.");
      setPending(null);
      await onChanged();
      setNotice(
        "Gespeicherte Mailingfassung als Vorlage angelegt. Weitere Sprachvarianten können im Vorlagenbereich ergänzt werden.",
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Vorlage konnte nicht gespeichert werden.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-4">
      <h3 className="font-semibold">
        Zielgruppe und Vorlagenrevision verbinden
      </h3>
      <p className="text-sm text-stone-600">
        Die Auswahl ändert die gespeicherte Mailingfassung und benötigt eine
        neue Versandfreigabe. Bitte eigene Editoränderungen zuerst speichern.
        Die Vorschau und der Versand nutzen die aktuellen Zielgruppenregeln und
        Einwilligungen.
      </p>
      <fieldset
        disabled={disabled || saving || Boolean(pending)}
        className="flex flex-wrap gap-2"
      >
        <select
          aria-label="Mailing für Marketingauswahl"
          className={field}
          value={campaignId}
          onChange={(e) => {
            onSelect(e.target.value);
            setTemplateId("");
            setSegmentId("");
          }}
        >
          <option value="">Gespeichertes Mailing wählen</option>
          {data.drafts.map((d) => (
            <option key={d.campaignId} value={d.campaignId}>
              {d.name} · Version {d.revision}
            </option>
          ))}
        </select>
        {draft && (
          <>
            <select
              className={field}
              aria-label="Gespeicherte Zielgruppe verbinden"
              value={segmentId || draft.segmentId || ""}
              onChange={(e) => setSegmentId(e.target.value)}
            >
              <option value="">Zielgruppe wählen</option>
              {data.segments
                .filter((s) => s.projectId === draft.projectId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.optIns} aktuell berechtigt
                  </option>
                ))}
            </select>
            <button
              className={button}
              disabled={!segmentId}
              onClick={() =>
                void onConfigure({
                  action: "configure",
                  campaignId,
                  expectedRevision: draft.revision,
                  segmentId,
                })
              }
            >
              Zielgruppe übernehmen
            </button>
            <select
              aria-label="Gespeicherte Mailingvorlage"
              className={field}
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">Vorlage wählen</option>
              {data.templates
                .filter((t) => t.projectId === draft.projectId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · Version {t.revision}
                  </option>
                ))}
            </select>
            <select
              className={field}
              aria-label="Vorlagensprache übernehmen"
              value={templateLanguage}
              onChange={(e) =>
                setTemplateLanguage(e.target.value as typeof templateLanguage)
              }
            >
              <option value="de">Deutsch</option>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
            <button
              className={button}
              disabled={!template?.variants[templateLanguage]}
              onClick={() =>
                void onConfigure({
                  action: "configure",
                  campaignId,
                  expectedRevision: draft.revision,
                  templateId,
                  templateRevision: template!.revision,
                  language: templateLanguage,
                })
              }
            >
              Diese Vorlagenrevision übernehmen
            </button>
          </>
        )}
      </fieldset>
      {binding && (
        <p className="text-sm">
          Vorlagenbasis dieser gespeicherten Fassung:{" "}
          {data.templates.find((t) => t.id === binding.templateId)?.name ??
            binding.templateId}{" "}
          · Revision {binding.revision} · {binding.language.toUpperCase()}.
          Eigene Änderungen werden im Mailingentwurf gespeichert.
        </p>
      )}
      {draft && (
        <div className="flex flex-wrap gap-2">
          <input
            className={field}
            aria-label="Name für neue Vorlage aus Mailing"
            placeholder="Vorlagenname aus gespeicherter Fassung"
            value={name}
            disabled={disabled || saving || Boolean(pending)}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className={button}
            disabled={disabled || saving || !name.trim()}
            onClick={() => void saveTemplate()}
          >
            {pending
              ? "Gleiche Vorlagenspeicherung erneut prüfen"
              : "Gespeicherte Fassung als Vorlage anlegen"}
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
