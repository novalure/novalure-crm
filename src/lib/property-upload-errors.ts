import type { PropertyAttachmentError } from "./property-interactions";

const copy = {
  de: {
    content: "Die Datei ist beschädigt oder ihr Inhalt passt nicht zum Dateityp. Bitte eine gültige Datei auswählen; bloßes Umbenennen der Endung reicht nicht aus.",
    imageSize: "Das Bild ist zu groß: höchstens 40 Millionen Pixel insgesamt, 16.384 Pixel pro Seite und 100 Einzelbilder bei Animationen. Bitte das Bild verkleinern oder als Einzelbild exportieren.",
    fileSize: "Die Datei ist zu groß. Pro Datei sind höchstens 10 MB erlaubt. Bitte die Datei verkleinern.",
    fileType: "Dieser Dateityp wird nicht unterstützt. Erlaubt sind JPG, PNG, WebP, GIF, AVIF, PDF, DOC und DOCX mit passender Dateiendung.",
    imageType: "Dieser Bildtyp wird nicht unterstützt. Bitte JPG, PNG, WebP, GIF oder AVIF mit passender Dateiendung auswählen.",
    quota: "Der Speicherplatz dieses Workspaces ist ausgeschöpft. Bitte den verfügbaren Speicher prüfen, bevor weitere Dateien hochgeladen werden.",
    missingFile: "Es wurde keine Datei übermittelt. Bitte eine Datei auswählen.",
    invalidForm: "Die Upload-Anfrage war unvollständig oder ungültig. Bitte die Datei erneut auswählen.",
    authentication: "Die Anmeldung ist abgelaufen oder fehlt. Bitte erneut anmelden und vor einem erneuten Upload die Medienablage prüfen.",
    forbidden: "Für diesen Upload fehlen die erforderlichen Rechte. Bitte Workspace und Berechtigungen prüfen.",
    rateLimit: "Es wurden zu viele Anfragen gesendet. Bitte kurz warten und vor einem erneuten Upload die Medienablage prüfen.",
    unavailable: "Der Mediendienst ist derzeit nicht verfügbar. Bitte später erneut prüfen und vor einem erneuten Upload die Medienablage kontrollieren.",
    unknown: "Der Upload wurde nicht eindeutig bestätigt. Bitte die Verbindung und die Medienablage prüfen, bevor die Datei erneut hochgeladen wird.",
    attachFailed: "Die Datei wurde hochgeladen, konnte aber nicht dem Objekt zugeordnet werden. Sie bleibt privat in der Medienablage; der Upload ist nicht abgeschlossen.",
    attachUnconfirmed: "Die Datei wurde privat hochgeladen, ihre Zuordnung zum Objekt aber nicht eindeutig bestätigt. Bitte Objekt und Medienablage prüfen, bevor die Datei erneut hochgeladen wird.",
  },
  en: {
    content: "The file is damaged or its content does not match its file type. Choose a valid file; renaming the extension alone is not enough.",
    imageSize: "The image is too large: at most 40 million pixels in total, 16,384 pixels per side and 100 animation frames are allowed. Reduce the image size or export a single frame.",
    fileSize: "The file is too large. Each file must be 10 MB or smaller. Please reduce its size.",
    fileType: "This file type is not supported. JPG, PNG, WebP, GIF, AVIF, PDF, DOC and DOCX with matching file extensions are allowed.",
    imageType: "This image type is not supported. Choose JPG, PNG, WebP, GIF or AVIF with a matching file extension.",
    quota: "This workspace has no storage space remaining. Check available storage before uploading more files.",
    missingFile: "No file was submitted. Please select a file.",
    invalidForm: "The upload request was incomplete or invalid. Please select the file again.",
    authentication: "Your sign-in is missing or has expired. Sign in again and check the media library before uploading again.",
    forbidden: "You do not have permission for this upload. Check the workspace and your permissions.",
    rateLimit: "Too many requests were sent. Wait a moment and check the media library before uploading again.",
    unavailable: "The media service is currently unavailable. Check again later and inspect the media library before uploading again.",
    unknown: "The upload was not conclusively confirmed. Check your connection and the media library before uploading the file again.",
    attachFailed: "The file was uploaded but could not be attached to the property. It remains private in the media library; the upload is incomplete.",
    attachUnconfirmed: "The file was uploaded privately, but its attachment to the property was not conclusively confirmed. Check the property and the media library before uploading the file again.",
  },
} as const;

/** Render only product-owned copy, never server messages, URLs, filenames or native errors. */
export function getPropertyUploadErrorMessage(error: unknown, language: string): string {
  const messages = copy[language === "de" ? "de" : "en"];
  if (!(error instanceof Error) || error.name !== "PropertyAttachmentError") return messages.unknown;
  const details = error as PropertyAttachmentError;
  if (details.phase === "attach") {
    return details.code === "NETWORK_ERROR" || details.code === "INVALID_ATTACHMENT_RESPONSE" ||
      details.httpStatus === undefined || details.httpStatus >= 500
      ? messages.attachUnconfirmed : messages.attachFailed;
  }
  // Codes take priority: a raster pixel limit and a byte limit both use HTTP 413.
  switch (details.code) {
    case "FILE_CONTENT_MISMATCH": return messages.content;
    case "IMAGE_TOO_LARGE": return messages.imageSize;
    case "FILE_TOO_LARGE": return messages.fileSize;
    case "INVALID_FILE_TYPE":
    case "UNSUPPORTED_FILE_TYPE": return messages.fileType;
    case "UNSUPPORTED_IMAGE_TYPE": return messages.imageType;
    case "WORKSPACE_QUOTA_EXCEEDED": return messages.quota;
    case "MISSING_MEDIA_FILE": return messages.missingFile;
    case "INVALID_UPLOAD_FORM": return messages.invalidForm;
    case "PRIVATE_STORAGE_UNAVAILABLE":
    case "PUBLIC_STORAGE_UNAVAILABLE": return messages.unavailable;
    case "INVALID_STORAGE_REFERENCE":
    case "NETWORK_ERROR":
    case "INVALID_UPLOAD_RESPONSE": return messages.unknown;
  }
  switch (details.httpStatus) {
    case 401: return messages.authentication;
    case 403: return messages.forbidden;
    case 413: return messages.fileSize;
    case 415: return messages.fileType;
    case 429: return messages.rateLimit;
    case 503: return messages.unavailable;
    default: return messages.unknown;
  }
}
