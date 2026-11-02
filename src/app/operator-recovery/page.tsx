"use client";
import { useState } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";

export default function OperatorRecoveryPage() {
  const [result, setResult] = useState(""); const [busy, setBusy] = useState(false);
  async function createCopy() {
    setBusy(true); setResult("");
    try {
      const response = await csrfFetch("/api/internal/operator-recovery", { method: "POST", cache: "no-store" });
      const body = await response.json();
      setResult(response.ok ? JSON.stringify(body) : "Die geschützte Kopie konnte nicht erstellt werden.");
    } catch { setResult("Die geschützte Kopie konnte nicht erstellt werden."); }
    finally { setBusy(false); }
  }
  return <main style={{ maxWidth: 900, margin: "4rem auto", padding: 24 }}>
    <h1>Geschützte Wiederherstellung</h1>
    <p>Nur für den festgelegten Novalure-Betreiber mit bestätigter Anmeldung. Die Kopie ist ausschließlich für den hinterlegten Wiederherstellungsschlüssel verschlüsselt.</p>
    <button type="button" disabled={busy} onClick={createCopy}>{busy ? "Kopie wird erstellt …" : "Geschützte Kopie erstellen"}</button>
    {result && <textarea aria-label="Verschlüsselte Wiederherstellungskopie" readOnly value={result} rows={14} style={{ width: "100%", marginTop: 24 }} />}
  </main>;
}
