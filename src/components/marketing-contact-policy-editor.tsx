"use client";
import { useEffect, useRef, useState } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";
import { defaultMarketingContactRules, normalizeMarketingContactRules, type MarketingContactPolicy, type MarketingContactRules } from "@/lib/marketing-contact-policy";
type Data = { workspaceId: string; installed: boolean; canEdit: boolean; policy: MarketingContactPolicy | null };
export function MarketingContactPolicyEditor(props: { workspaceId: string; language: "de" | "en" }) { return <Editor key={props.workspaceId} {...props} />; }
function Editor({ workspaceId, language }: { workspaceId: string; language: "de" | "en" }) {
  const t = (a: string, b: string) => language === "de" ? a : b;
  const [data, setData] = useState<Data | null>(null), [rules, setRules] = useState<MarketingContactRules>({ ...defaultMarketingContactRules });
  const [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [exceptions, setExceptions] = useState("");
  const pending = useRef<{ text: string; key: string; correlation: string } | null>(null);
  const endpoint = `/api/crm/marketing-contact-policy?workspaceId=${encodeURIComponent(workspaceId)}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      const result = await response.json() as Data & { error?: string };
      if (!response.ok || result.workspaceId !== workspaceId) throw new Error(result.error || "Versandregeln sind nicht verfügbar.");
      if (!controller.signal.aborted) { setData(result); setRules(result.policy?.rules ?? { ...defaultMarketingContactRules }); setExceptions(result.policy?.rules.excludedDates.join("\n") ?? ""); setNotice(""); }
    }).catch((error: unknown) => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Versandregeln sind nicht verfügbar."); });
    return () => controller.abort();
  }, [workspaceId, endpoint, reload]);
  async function save() {
    if (!data?.canEdit || busy) return;
    setBusy(true);
    try {
      const normalized = normalizeMarketingContactRules({ ...rules, excludedDates: exceptions.split(/[\s,]+/).filter(Boolean) });
      const text = JSON.stringify({ expectedRevision: data.policy?.revision ?? 0, rules: normalized });
      if (pending.current?.text !== text) pending.current = { text, key: crypto.randomUUID(), correlation: crypto.randomUUID() };
      const response = await csrfFetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": pending.current.key, "x-correlation-id": pending.current.correlation }, body: text });
      const result = await response.json() as { workspaceId: string; policy: MarketingContactPolicy; error?: string };
      if (!response.ok || result.workspaceId !== workspaceId || !result.policy) throw new Error(result.error || "Versandregeln konnten nicht gespeichert werden.");
      setData({ ...data, policy: result.policy }); setRules(result.policy.rules); setExceptions(result.policy.rules.excludedDates.join("\n")); pending.current = null;
      setNotice(t("Versandregeln gespeichert. Sie gelten für die nächsten tatsächlichen Versandprüfungen.", "Sending rules saved. They apply at the next actual sending checks."));
    } catch (error) { setNotice(error instanceof Error ? error.message : "Versandregeln konnten nicht gespeichert werden."); } finally { setBusy(false); }
  }
  const field = "min-h-11 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm disabled:bg-stone-100";
  const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const minute = (value: string) => { const [h, m] = value.split(":").map(Number); return h * 60 + m; };
  return <details className="mb-5 rounded-xl border border-stone-200 bg-white p-5"><summary className="cursor-pointer text-lg font-semibold">{t("Versandzeiten & Kontaktfrequenz", "Sending hours & contact frequency")}</summary>
    <p className="mt-3 text-sm leading-6 text-stone-600">{t("Gemeinsame Regel für Mailings und Flow-Nachrichten an denselben Originalkontakt. Eine laufende oder ungeklärte Sendung wird zuerst geklärt. Persönliche Testmails sind ausgenommen.", "Shared rule for mailings and flow messages to the same original contact. A pending or uncertain send must be resolved first. Personal test messages are excluded.")}</p>
    {notice ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
    {!data ? <p className="mt-3 text-sm">{t("Versandregeln werden geladen …", "Loading sending rules …")}</p> : !data.installed ? <p className="mt-3 text-sm">{t("Die gemeinsame Versandregel muss in diesem Zielsystem noch installiert werden.", "Shared sending rules need to be installed in this environment.")}</p> : <fieldset disabled={!data.canEdit || busy} className="mt-4 space-y-4">
      <label className="flex items-center gap-3 text-sm font-semibold"><input type="checkbox" checked={rules.enabled} onChange={event => setRules({ ...rules, enabled: event.target.checked })} />{t("Gemeinsame Versandregel anwenden", "Apply shared sending rule")}</label>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><label className="grid gap-1 text-sm">{t("Zeitzone", "Timezone")}<select className={field} value={rules.timezone} onChange={event => setRules({ ...rules, timezone: event.target.value })}>{[...new Set([rules.timezone, "Europe/Vienna", "Europe/Berlin", "Europe/Madrid", "Europe/Dublin"])].map(zone => <option key={zone}>{zone}</option>)}</select></label><label className="grid gap-1 text-sm">{t("Ab", "From")}<input type="time" step="900" className={field} value={time(rules.startMinute)} onChange={event => setRules({ ...rules, startMinute: minute(event.target.value) })} /></label><label className="grid gap-1 text-sm">{t("Bis", "Until")}<select className={field} value={rules.endMinute} onChange={event => setRules({ ...rules, endMinute: Number(event.target.value) })}>{Array.from({ length: 96 }, (_, index) => (index + 1) * 15).map(value => <option key={value} value={value}>{value === 1440 ? t("24:00 · Tagesende", "24:00 · end of day") : time(value)}</option>)}</select></label><label className="grid gap-1 text-sm">{t("Mindestabstand in Stunden", "Minimum gap in hours")}<input type="number" min="0" max="720" className={field} value={rules.minHours} onChange={event => setRules({ ...rules, minHours: Number(event.target.value) })} /></label></div>
      <div className="flex flex-wrap gap-4">{(language === "de" ? ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]).map((day, index) => <label className="flex min-h-11 items-center gap-2 text-sm" key={day}><input type="checkbox" checked={rules.days.includes(index)} onChange={event => setRules({ ...rules, days: event.target.checked ? [...rules.days, index] : rules.days.filter(value => value !== index) })} />{day}</label>)}</div>
      <label className="grid gap-1 text-sm">{t("Ausnahmetage / geprüfte Feiertage · JJJJ-MM-TT, ein Datum pro Zeile", "Excluded dates / reviewed holidays · YYYY-MM-DD, one date per line")}<textarea className={field} rows={3} value={exceptions} onChange={event => setExceptions(event.target.value)} /></label>
      <p className="text-xs leading-5 text-stone-500">{t("Die Zeitzone wird ausdrücklich für diesen Arbeitsbereich festgelegt. Feiertage werden nur über die eingetragenen Ausnahmetage berücksichtigt; ein Interesse-Tag oder Kontaktland ändert diese Regel nicht.", "The timezone is explicitly set for this workspace. Only entered exception dates are excluded; interest tags or contact country do not change this rule.")}</p>
      <button type="button" className="min-h-11 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void save()}>{busy ? t("Speichert …", "Saving …") : t("Versandregel speichern", "Save sending rule")}</button>
    </fieldset>}
    <button type="button" className="mt-3 min-h-11 text-sm underline" disabled={busy} onClick={() => setReload(value => value + 1)}>{t("Gespeicherten Stand neu laden", "Reload saved rules")}</button>
  </details>;
}
