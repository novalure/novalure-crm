import type { FrozenWebExposeTemplate } from "@/lib/web-expose-templates";
/** Shared public contract. Never serialize a SellerListing or a CRM contact here. */
export type WebExposeLanguage = "de" | "en" | "es";
export function webExposePropertyType(value:string,language:WebExposeLanguage){
  const labels:Record<string,Record<WebExposeLanguage,string>>={Wohnung:{de:"Wohnung",en:"Apartment",es:"Piso"},Haus:{de:"Haus",en:"House",es:"Casa"},Neubau:{de:"Neubau",en:"New build",es:"Obra nueva"},Zinshaus:{de:"Zinshaus",en:"Apartment building",es:"Edificio de viviendas"},Gewerbe:{de:"Gewerbe",en:"Commercial property",es:"Inmueble comercial"},"Grundstück":{de:"Grundstück",en:"Land",es:"Terreno"},Portfolio:{de:"Portfolio",en:"Portfolio",es:"Cartera de inmuebles"}};
  return labels[value]?.[language]??value;
}
export type WebExposeSection = "hero" | "facts" | "description" | "gallery" | "floorplans" | "documents" | "videos" | "links" | "units" | "location" | "contact";
export const webExposeSections: WebExposeSection[] = ["hero", "facts", "description", "gallery", "floorplans", "documents", "videos", "links", "units", "location", "contact"];
export const webExposeEventTypes = ["open", "section", "heartbeat", "gallery", "floorplan", "document", "external_link", "pdf", "video", "map", "cta", "unit", "inquiry_start"] as const;
export type WebExposeEventType = typeof webExposeEventTypes[number];
export type WebExposeEvent = { id: string; sequence: number; type: WebExposeEventType; section: WebExposeSection; target?: string; activeMs?: number; depth?: number };
export type WebExposeSnapshot = {
  template?: FrozenWebExposeTemplate;
  schemaVersion: 1; language: WebExposeLanguage; locale: string; countryCode: "AT" | "DE" | "ES" | "IE";
  title: string; description: string; location: string; price: string | null;
  priceVisibility?: "publish_price" | "price_on_request" | "hide_price";
  inventoryAsOf?: string;
  facts: { label: string; value: string }[];
  media: { id: string; title: string; kind: "image" | "floorplan"; assetId: string }[];
  resources?: WebExposePublicResource[];
  units: { id: string; number: string; area: string; rooms: string; price: string | null; status: string }[];
  contact: { name: string; email: string; phone: string };
  privacyUrl: string; legalUrl: string; controller: string; publishedAt: string;
};
export type WebExposePublicResource = { id:string; kind:"image"|"floorplan"|"document"|"video"|"external_link"; title:string; assetId:string|null; url:string|null; mimeType:string|null };
export type WebExposePublic = { versionId: string; snapshot: WebExposeSnapshot; intendedRecipient: boolean };
export const webExposeCopy = {
  de: { facts: "Eckdaten", description: "Die Immobilie", gallery: "Bilder", floorplans: "Grundrisse", units: "Einheiten", location: "Lage", contact: "Anfrage", inquire: "Anfragen", name: "Name", email: "E-Mail", phone: "Telefon (optional)", message: "Deine Nachricht", send: "Anfrage senden", sent: "Danke, deine Anfrage ist eingegangen.", failed: "Die Anfrage konnte nicht bestätigt werden. Bitte versuche es erneut.", privacy: "Datenschutz", legal: "Impressum", consent: "Dürfen wir erfassen, welche Abschnitte du ansiehst, wie lange du aktiv auf dieser Seite bist und welche Inhalte du anklickst? Bei einem persönlichen Link kann diese Nutzung dem vorgesehenen Empfänger zugeordnet werden. Deine Anfrage funktioniert auch ohne Statistik.", accept: "Statistik erlauben", reject: "Ohne Statistik fortfahren", preferences: "Statistik-Einstellungen", withdraw: "Einwilligung widerrufen", agree: "Ich habe die Datenschutzhinweise zur Bearbeitung meiner Anfrage gelesen.", general: "Allgemeine Anfrage", available: "Verfügbar", reserved: "Reserviert", sold: "Verkauft", priceRequest: "Preis auf Anfrage", intended: "Ein persönlicher Link kann weitergegeben werden und bestätigt keine Identität." },
  en: { facts: "Key facts", description: "The property", gallery: "Photos", floorplans: "Floor plans", units: "Units", location: "Location", contact: "Enquiry", inquire: "Enquire", name: "Name", email: "Email", phone: "Phone (optional)", message: "Your message", send: "Send enquiry", sent: "Thank you. Your enquiry has been received.", failed: "We could not confirm your enquiry. Please try again.", privacy: "Privacy", legal: "Legal information", consent: "May we record the sections you view, your active time on this page and the content you click? Activity on a personal link may be associated with its intended recipient. You can enquire without analytics.", accept: "Allow analytics", reject: "Continue without analytics", preferences: "Analytics settings", withdraw: "Withdraw consent", agree: "I have read the privacy notice about processing my enquiry.", general: "General enquiry", available: "Available", reserved: "Reserved", sold: "Sold", priceRequest: "Price on request", intended: "A personal link can be forwarded and does not confirm identity." },
  es: { facts: "Datos principales", description: "El inmueble", gallery: "Fotos", floorplans: "Planos", units: "Unidades", location: "Ubicación", contact: "Consulta", inquire: "Consultar", name: "Nombre", email: "Correo electrónico", phone: "Teléfono (opcional)", message: "Tu mensaje", send: "Enviar consulta", sent: "Gracias. Hemos recibido tu consulta.", failed: "No hemos podido confirmar tu consulta. Inténtalo de nuevo.", privacy: "Privacidad", legal: "Aviso legal", consent: "¿Nos permites registrar las secciones que visitas, el tiempo activo en esta página y los contenidos en los que haces clic? La actividad de un enlace personal puede asociarse a su destinatario previsto. Puedes consultar sin aceptar las estadísticas.", accept: "Permitir estadísticas", reject: "Continuar sin estadísticas", preferences: "Preferencias de estadísticas", withdraw: "Retirar el consentimiento", agree: "He leído el aviso de privacidad sobre el tratamiento de mi consulta.", general: "Consulta general", available: "Disponible", reserved: "Reservado", sold: "Vendido", priceRequest: "Precio a consultar", intended: "Un enlace personal puede reenviarse y no confirma la identidad." },
} as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseWebExposeEvents(value: unknown): WebExposeEvent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) throw new Error("invalid_events");
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_event");
    const v = raw as Record<string, unknown>;
    if (Object.keys(v).some(k => !["id", "sequence", "type", "section", "target", "activeMs", "depth"].includes(k)) ||
      typeof v.id !== "string" || !uuid.test(v.id) || !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 1 ||
      !webExposeEventTypes.includes(v.type as WebExposeEventType) || !webExposeSections.includes(v.section as WebExposeSection) ||
      (v.target !== undefined && (typeof v.target !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(v.target))) ||
      (v.activeMs !== undefined && (v.type !== "heartbeat" || !Number.isInteger(v.activeMs) || Number(v.activeMs) < 0 || Number(v.activeMs) > 10000)) ||
      (v.depth !== undefined && (!Number.isInteger(v.depth) || Number(v.depth) < 0 || Number(v.depth) > 100))) throw new Error("invalid_event");
    return { id: v.id, sequence: v.sequence as number, type: v.type as WebExposeEventType, section: v.section as WebExposeSection,
      ...(v.target ? { target: v.target as string } : {}), ...(v.activeMs !== undefined ? { activeMs: v.activeMs as number } : {}), ...(v.depth !== undefined ? { depth: v.depth as number } : {}) };
  });
}
export type WebExposeInquiry = { name: string; email: string; phone: string; message: string; unitId: string | null; privacyRead: true };
export function parseWebExposeInquiry(raw: unknown): WebExposeInquiry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_inquiry");
  const v = raw as Record<string, unknown>;
  const name = typeof v.name === "string" ? v.name.trim() : "";
  const email = typeof v.email === "string" ? v.email.trim().toLowerCase() : "";
  const phone = typeof v.phone === "string" ? v.phone.trim() : "";
  const message = typeof v.message === "string" ? v.message.trim() : "";
  if (Object.keys(v).some(k => !["name", "email", "phone", "message", "unitId", "privacyRead"].includes(k)) ||
      !name || name.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || phone.length > 80 ||
      message.length > 8000 || v.privacyRead !== true || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(name + email + phone + message) ||
      (v.unitId !== null && v.unitId !== undefined && (typeof v.unitId !== "string" || !uuid.test(v.unitId)))) throw new Error("invalid_inquiry");
  return { name, email, phone, message, unitId: typeof v.unitId === "string" ? v.unitId : null, privacyRead: true };
}
