import path from "node:path";
import { Worker } from "node:worker_threads";
import { KnowledgeCenterError } from "./policy";

export type KnowledgeDocumentExtraction = {
  content: string;
  status: "ready" | "needs_ocr";
  format: "pdf" | "docx" | "text" | "image";
  message: string | null;
};

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 150_000;
const MAX_CONCURRENT_PARSERS = 2;
let runningParsers = 0;
const formats: Record<string, { format: KnowledgeDocumentExtraction["format"]; extensions: string[] }> = {
  "application/pdf": { format: "pdf", extensions: [".pdf"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { format: "docx", extensions: [".docx"] },
  "text/plain": { format: "text", extensions: [".txt"] },
  "text/markdown": { format: "text", extensions: [".md", ".markdown"] },
  "text/csv": { format: "text", extensions: [".csv"] },
  "application/json": { format: "text", extensions: [".json"] },
  "image/png": { format: "image", extensions: [".png"] },
  "image/jpeg": { format: "image", extensions: [".jpg", ".jpeg"] },
  "image/webp": { format: "image", extensions: [".webp"] },
};

function invalid(message = "Die Datei ist beschädigt oder entspricht nicht dem angegebenen Dateiformat."): never {
  throw new KnowledgeCenterError("INVALID_DOCUMENT", message);
}
function limit(): KnowledgeCenterError {
  return new KnowledgeCenterError("DOCUMENT_LIMIT_EXCEEDED", "Die Datei überschreitet die Verarbeitungsgrenzen (10 MB, 100 PDF-Seiten oder 150.000 Textzeichen). Bitte die Datei verkleinern oder aufteilen.", 413);
}

/** Extract only local, untrusted text. This does not approve or publish knowledge. */
export async function extractKnowledgeDocument(input: { bytes: Uint8Array; fileName: string; mimeType: string }): Promise<KnowledgeDocumentExtraction> {
  if (!(input.bytes instanceof Uint8Array) || !input.bytes.byteLength) invalid("Bitte eine vollständige, nicht leere Datei hochladen.");
  if (input.bytes.byteLength > MAX_INPUT_BYTES) throw limit();
  if (typeof input.fileName !== "string" || !input.fileName.trim() || input.fileName.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(input.fileName)) invalid("Der Dateiname ist ungültig.");
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.toLowerCase().trim() : "";
  const descriptor = Object.hasOwn(formats, mimeType) ? formats[mimeType] : undefined;
  if (!descriptor) throw new KnowledgeCenterError("UNSUPPORTED_DOCUMENT", "Unterstützt werden PDF, DOCX, UTF-8-Text, Markdown, CSV, JSON sowie PNG-, JPEG- und WebP-Bilder.");
  if (!descriptor.extensions.includes(path.extname(input.fileName).toLowerCase())) invalid("Dateiendung und angegebener Dateityp stimmen nicht überein.");

  const bytes = input.bytes;
  if (descriptor.format === "text") {
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { invalid("Die Textdatei ist kein gültiger UTF-8-Text. Bitte als UTF-8 speichern."); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content!)) invalid("Die Datei enthält Binärdaten oder nicht unterstützte Steuerzeichen.");
    content = content!.replace(/\r\n?/g, "\n").trim();
    if (!content) invalid("Die Datei enthält keinen nutzbaren Text.");
    if (content.length > MAX_TEXT_CHARACTERS) throw limit();
    if (mimeType === "application/json") {
      try { JSON.parse(content); } catch { invalid("Die JSON-Datei enthält kein gültiges JSON."); }
    }
    return { content, status: "ready", format: "text", message: null };
  }

  const prefix = Buffer.from(bytes.subarray(0, 16));
  if (descriptor.format === "pdf" && (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/.test(prefix.toString("ascii")) || !/%%EOF\s*$/.test(Buffer.from(bytes.subarray(Math.max(0, bytes.length - 2048))).toString("latin1")))) invalid("Die Datei ist kein vollständiges, unterstütztes PDF.");
  if (descriptor.format === "docx" && !prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) invalid("Die Datei ist kein gültiges DOCX-Dokument.");
  if (mimeType === "image/png" && !prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) invalid();
  if (mimeType === "image/jpeg" && !(prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff)) invalid();
  if (mimeType === "image/webp" && !(prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WEBP")) invalid();
  if (runningParsers >= MAX_CONCURRENT_PARSERS) throw new KnowledgeCenterError("DOCUMENT_EXTRACTION_BUSY", "Die Dokumentverarbeitung ist ausgelastet. Bitte den Import in Kürze erneut versuchen.", 503);

  runningParsers++;
  try {
    return await new Promise<KnowledgeDocumentExtraction>((resolve, reject) => {
      const copy = Uint8Array.from(bytes);
      const worker = new Worker(path.join(process.cwd(), "src/lib/knowledge-center/document-extraction-worker.cjs"), {
        workerData: { bytes: copy, format: descriptor.format, mimeType }, transferList: [copy.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        execArgv: [], stdout: true, stderr: true,
      });
      // Uploaded text and parser diagnostics must never appear in server logs.
      worker.stdout?.resume(); worker.stderr?.resume();
      let finished = false;
      const finish = (error?: Error, result?: KnowledgeDocumentExtraction) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        void worker.terminate();
        if (error) reject(error); else resolve(result!);
      };
      const timer = setTimeout(() => finish(new KnowledgeCenterError("DOCUMENT_EXTRACTION_TIMEOUT", "Die Dokumentverarbeitung hat das Zeitlimit überschritten. Bitte eine kleinere oder einfachere Datei verwenden.", 413)), 12_000);
      worker.once("message", (result: { ok?: boolean; content?: string; code?: string; needsOcr?: boolean }) => {
        if (!result.ok) {
          if (result.code === "LIMIT") return finish(limit());
          const message = result.code === "EXTERNAL" ? "Das DOCX enthält externe Verweise oder eingebettete aktive Inhalte. Bitte eine eigenständige DOCX-Datei ohne diese Inhalte verwenden."
            : result.code === "ENCRYPTED" ? "Verschlüsselte oder passwortgeschützte Dokumente können nicht importiert werden. Bitte eine unverschlüsselte Kopie verwenden."
              : "Die Datei ist beschädigt, enthält nicht unterstützte Inhalte oder entspricht nicht dem angegebenen Dateiformat.";
          return finish(new KnowledgeCenterError("INVALID_DOCUMENT", message));
        }
        if (typeof result.content !== "string" || result.content.length > MAX_TEXT_CHARACTERS || result.content.includes("\u0000")) return finish(limit());
        const content = result.content.trim();
        const needsOcr = !content || result.needsOcr;
        finish(undefined, { content, status: needsOcr ? "needs_ocr" : "ready", format: descriptor.format,
          message: needsOcr ? content
            ? "Ein Teil des Dokuments besitzt keine lesbare Textebene. Der Text ist unvollständig; OCR ist für diese Seiten erforderlich und derzeit nicht verfügbar."
            : "Keine lesbare Textebene gefunden. Für diese Datei ist Texterkennung (OCR) erforderlich; OCR ist derzeit nicht verfügbar." : null });
      });
      worker.once("error", () => finish(new KnowledgeCenterError("INVALID_DOCUMENT", "Die Datei konnte innerhalb der Sicherheitsgrenzen nicht verarbeitet werden.")));
      worker.once("exit", () => { if (!finished) finish(new KnowledgeCenterError("INVALID_DOCUMENT", "Die Dokumentverarbeitung wurde vorzeitig beendet. Bitte eine kleinere oder neue Datei verwenden.")); });
    });
  } finally { runningParsers--; }
}
