import { applyNewsletterUnsubscribe, checkNewsletterUnsubscribe } from "@/lib/newsletter-unsubscribe";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };
function page(title: string, detail: string, form = "", status = 200) { return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font:16px/1.5 Arial,sans-serif;background:#f5f5f4;color:#0f172a;padding:32px"><main style="max-width:560px;margin:48px auto;padding:32px;background:white;border-radius:16px"><h1>${title}</h1><p>${detail}</p>${form}</main></body></html>`, { status, headers: { ...headers, "content-type": "text/html; charset=utf-8" } }); }
export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token") ?? "", result = await checkNewsletterUnsubscribe(token);
    if (!result) return page("Newsletter", "Dieser Abmeldelink ist ungültig. This unsubscribe link is invalid.", "", 404);
    const de = result.language === "de", es = result.language === "es";
    if (result.unsubscribed) return page(de ? "Abgemeldet" : es ? "Suscripción cancelada" : "Unsubscribed", de ? "Die Newsletter-Abmeldung wurde gespeichert." : es ? "Se ha guardado la cancelación de la suscripción." : "Your newsletter unsubscribe preference has been saved.");
    const title = de ? "Newsletter abmelden" : es ? "Cancelar suscripción" : "Unsubscribe from newsletter";
    return page(title, de ? "Bestätige die Abmeldung mit dem Button." : es ? "Confirma la cancelación con el botón." : "Confirm your unsubscribe preference using the button.", `<form method="post"><button style="min-height:44px;border:0;border-radius:8px;padding:12px 20px;background:#0f172a;color:#fff;font:inherit" type="submit">${title}</button></form>`);
  } catch { return page("Newsletter", "Die Abmeldung ist vorübergehend nicht verfügbar. Please try again.", "", 503); }
}
export async function POST(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token") ?? "", result = await checkNewsletterUnsubscribe(token);
    if (!result || !await applyNewsletterUnsubscribe(token)) return page("Newsletter", "Dieser Abmeldelink ist ungültig. This unsubscribe link is invalid.", "", 404);
    const title = result.language === "de" ? "Abgemeldet" : result.language === "es" ? "Suscripción cancelada" : "Unsubscribed";
    return page(title, result.language === "de" ? "Die Newsletter-Abmeldung wurde gespeichert." : result.language === "es" ? "Se ha guardado la cancelación de la suscripción." : "Your newsletter unsubscribe preference has been saved.");
  } catch { return page("Newsletter", "Die Abmeldung konnte noch nicht gespeichert werden. Please try again.", "", 503); }
}
