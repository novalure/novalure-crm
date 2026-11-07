"use client";
import { useState } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";
import recipient from "../../../config/operator-recovery-recipient.json";

export default function OperatorRecoveryPage() {
  const [result, setResult] = useState(""); const [busy, setBusy] = useState(false);
  const [fileResult, setFileResult] = useState("");
  async function createCopy() {
    setBusy(true); setResult("");
    try {
      const response = await csrfFetch("/api/internal/operator-recovery", { method: "POST", cache: "no-store" });
      const body = await response.json();
      setResult(response.ok ? JSON.stringify(body) : JSON.stringify({ httpStatus: response.status, error: body.error ?? "Die geschützte Kopie konnte nicht erstellt werden.", code: body.code ?? null }));
    } catch { setResult("Die geschützte Kopie konnte nicht erstellt werden."); }
    finally { setBusy(false); }
  }
  async function checkRestoredFile() {
    setBusy(true); setFileResult("");
    try {
      // The ordinary authorized Knowledge route remains the sole authority.
      // No blob credential, document content, cookie or token is displayed.
      const response = await fetch(`/api/knowledge-center/sources/6a4b1ef0-9196-4bdc-a965-8c1aa832aac5/document?workspaceId=${recipient.workspaceId}`,
        { cache: "no-store", credentials: "same-origin", redirect: "error" });
      if (!response.ok) { setFileResult(JSON.stringify({ httpStatus: response.status, success: false })); return; }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== "953") { setFileResult(JSON.stringify({ httpStatus: response.status, contentLength, success: false })); return; }
      const reader = response.body?.getReader(); if (!reader) throw new Error("Missing body");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 953) throw new Error("Unexpected file size"); chunks.push(value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(value => value.toString(16).padStart(2, "0")).join("");
      bytes.fill(0);
      const contentType = response.headers.get("content-type"), disposition = response.headers.get("content-disposition");
      setFileResult(JSON.stringify({ route: "/api/knowledge-center/sources/6a4b1ef0-9196-4bdc-a965-8c1aa832aac5/document", httpStatus: response.status,
        contentType, contentLength, bytes: size, sha256, attachment: disposition?.startsWith("attachment;") === true,
        success: size === 953 && contentType?.split(";")[0] === "text/plain" && disposition?.startsWith("attachment;") === true &&
          sha256 === "cba9ef0599553fee7e5c15e883f63d4c66423e872b3d0c2fc1c202418dada170" }));
    } catch { setFileResult("Die berechtigte Datei-Prüfung konnte nicht abgeschlossen werden."); }
    finally { setBusy(false); }
  }
  return <main style={{ maxWidth: 900, margin: "4rem auto", padding: 24 }}>
    <h1>Geschützte Wiederherstellung</h1>
    <p>Nur für den festgelegten Novalure-Betreiber mit bestätigter Anmeldung. Die Kopie ist ausschließlich für den hinterlegten Wiederherstellungsschlüssel verschlüsselt.</p>
    <button type="button" disabled={busy} onClick={createCopy}>{busy ? "Kopie wird erstellt …" : "Geschützte Kopie erstellen"}</button>
    {result && <textarea aria-label="Verschlüsselte Wiederherstellungskopie" readOnly value={result} rows={14} style={{ width: "100%", marginTop: 24 }} />}
    <h2>Restaurierte Datei prüfen</h2>
    <p>Prüft die vorhandene TXT-Datei über ihren berechtigten App-Download. Angezeigt werden nur Status, Größe und Prüfsumme.</p>
    <button type="button" disabled={busy} onClick={checkRestoredFile}>Berechtigten TXT-Download prüfen</button>
    {fileResult && <textarea aria-label="Ergebnis der TXT-Prüfung" readOnly value={fileResult} rows={5} style={{ width: "100%", marginTop: 24 }} />}
  </main>;
}
