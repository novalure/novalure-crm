import path from "node:path";
import { Worker } from "node:worker_threads";

export class PropertyExposePdfError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PropertyExposePdfError";
    this.code = code;
  }
}

/** Parse untrusted PDFs off the request thread, without rewriting the original. */
export async function validatePropertyExposePdf(bytes: Uint8Array): Promise<{ pageCount: number }> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 64 || bytes.byteLength > 10 * 1024 * 1024) {
    throw new PropertyExposePdfError("PDF_SIZE", "Bitte ein vollständiges PDF mit maximal 10 MB hochladen.");
  }
  const header = Buffer.from(bytes.subarray(0, 16)).toString("ascii");
  const ending = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 2048))).toString("latin1");
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/.test(header) || !/%%EOF\s*$/.test(ending)) {
    throw new PropertyExposePdfError("PDF_INVALID", "Die Datei ist kein vollständiges, unterstütztes PDF.");
  }
  const input = Uint8Array.from(bytes);
  return new Promise((resolve, reject) => {
    let done = false;
    const worker = new Worker(path.join(process.cwd(), "src/lib/property-expose-pdf-worker.cjs"), {
      workerData: { bytes: input }, transferList: [input.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      execArgv: [], stdout: true, stderr: true,
    });
    // Parser warnings must not leak uploaded document content into server logs.
    worker.stdout?.resume();
    worker.stderr?.resume();
    const finish = (error?: Error, result?: { pageCount: number }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => finish(new PropertyExposePdfError("PDF_LIMIT", "Die PDF-Prüfung überschreitet das Zeitlimit. Bitte ein kleineres, vereinfachtes PDF verwenden.")), 8000);
    worker.once("message", (result: { ok?: boolean; pageCount?: number; code?: string }) => {
      if (result.ok && Number.isInteger(result.pageCount) && result.pageCount! > 0 && result.pageCount! <= 100) {
        finish(undefined, { pageCount: result.pageCount! });
      } else {
        const unsafe = result.code === "PDF_UNSAFE";
        finish(new PropertyExposePdfError(unsafe ? "PDF_UNSAFE" : "PDF_INVALID", unsafe
          ? "Dieses PDF enthält aktive Inhalte, eingebettete Dateien, Formulare oder Verschlüsselung. Bitte eine statische PDF-Version ohne diese Funktionen hochladen."
          : "Das PDF ist beschädigt, zu komplex oder umfasst mehr als 100 Seiten. Bitte eine neue PDF-Version verwenden."));
      }
    });
    worker.once("error", () => finish(new PropertyExposePdfError("PDF_VALIDATION_UNAVAILABLE", "Die PDF-Prüfung konnte nicht abgeschlossen werden. Es wurde kein Exposé aktiviert.")));
    worker.once("exit", () => { if (!done) finish(new PropertyExposePdfError("PDF_LIMIT", "Das PDF konnte innerhalb der Sicherheitsgrenzen nicht geprüft werden.")); });
  });
}
