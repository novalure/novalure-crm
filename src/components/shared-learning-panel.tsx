"use client";
import { useState } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";

type Snapshot = { signals: { eventId: string; issue: string; outcome: string; createdAt: string }[]; head: { version: number | null; revision: number } | null; retention: { status: string }; limit: number };
const issueLabels: Record<string, string> = { unclear_goal: "Ziel klären", misunderstood_correction: "Korrektur verstehen", missed_topic_switch: "Themenwechsel erkennen", language_mismatch: "Sprache anpassen", handoff_confusion: "Übergabe klären", unclear_next_step: "Nächsten Schritt erklären" };
export function SharedLearningPanel({ scopedPath }: { scopedPath: (path: string) => string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const endpoint = scopedPath("/api/knowledge-center/learning");
  const [loadedEndpoint, setLoadedEndpoint] = useState("");
  const visible = loadedEndpoint === endpoint ? snapshot : null;
  async function load() {
    setBusy(true); setMessage(""); setSelected(null);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error();
      setSnapshot(await response.json()); setLoadedEndpoint(endpoint);
    } catch { setSnapshot(null); setMessage("Lernhistorie ist derzeit nicht verfügbar oder nicht freigegeben."); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!selected || !visible) return;
    setBusy(true); setMessage("");
    try {
      const response = await csrfFetch(scopedPath("/api/knowledge-center/learning"), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: selected }) });
      if (!response.ok) throw new Error();
      const result = await response.json() as { deleted: boolean };
      setSnapshot(current => current ? { ...current, signals: current.signals.filter(signal => signal.eventId !== selected) } : current);
      setSelected(null); setMessage(result.deleted ? "Eigenes Lernsignal entfernt." : "Dieses eigene Lernsignal ist nicht mehr vorhanden.");
    } catch { setMessage("Löschen nicht bestätigt. Bitte den aktuellen Stand laden."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Gemeinsame Lernplattform" className="rounded-xl border border-stone-200 bg-white p-4">
    <h4 className="font-semibold">Gemeinsame Lernplattform</h4>
    <p className="my-2 text-sm">Gemeinsame Methoden enthalten keine Gespräche oder privaten Dokumente. Die Historie zeigt ausschließlich Ihre eigenen Lernsignale im ausgewählten Unternehmen, höchstens die letzten 100.</p>
    <p className="my-2 text-sm">Automatische Löschung bleibt vorerst auf ausdrückliche Entscheidung deaktiviert. Einzelne eigene Signale können Sie löschen; die gemeinsame Veröffentlichungshistorie bleibt erhalten.</p>
    <button type="button" className="min-h-11 rounded border px-3" disabled={busy} onClick={() => void load()}>Lernhistorie laden</button>
    <p role="status" className="my-2 text-sm">{message}</p>
    {visible ? <>
      <p>Aktive Methodenversion: {visible.head?.version ?? 0}, Revision {visible.head?.revision ?? 0}</p>
      {visible.signals.length === 0 ? <p>Keine eigenen Lernsignale vorhanden.</p> : <ul>{visible.signals.map(signal => <li key={signal.eventId} className="my-2 flex flex-wrap items-center gap-2 border-t py-2">
        <span>{issueLabels[signal.issue] ?? "Prüfhinweis"} · {signal.outcome === "pass" ? "Bestätigt" : "Verbesserungsbedarf"} · <time dateTime={signal.createdAt}>{signal.createdAt}</time></span>
        <button type="button" className="min-h-11 rounded border px-3" disabled={busy} onClick={() => setSelected(signal.eventId)}>Dieses Signal löschen</button>
      </li>)}</ul>}
      {selected ? <div className="rounded border p-3"><p>Dieses eigene Lernsignal dauerhaft löschen?</p><button type="button" className="min-h-11 rounded border px-3" disabled={busy} onClick={() => void remove()}>Löschung bestätigen</button><button type="button" className="min-h-11 px-3" disabled={busy} onClick={() => setSelected(null)}>Abbrechen</button></div> : null}
    </> : null}
  </section>;
}
