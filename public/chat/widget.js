(() => {
  "use strict";
  const script = document.currentScript;
  if (!script || document.querySelector("[data-novalure-chat-host]")) return;
  const key = script.getAttribute("data-site-key") || "";
  if (!/^nov_pk_[A-Za-z0-9_-]{24,80}$/.test(key)) return;
  let source;
  try { source = new URL(script.src); } catch { return; }
  if (source.protocol !== "https:" || source.username || source.password || source.pathname !== "/chat/widget.js") return;
  const apiOrigin = source.origin;
  const locale = (document.documentElement.lang || navigator.language || "en").toLowerCase().split("-")[0];
  let language = ["de", "es"].includes(locale) ? locale : "en";
  const translations = {
    en: { open: "Ask a question", title: "Website assistant", close: "Close chat", label: "Your question", placeholder: "What would you like to know?", send: "Send", working: "Preparing an answer…", welcome: "Ask a question about our published information. AI answers can contain mistakes; check the listed sources.", sources: "Sources", error: "The assistant is temporarily unavailable. Please try again later or contact the team directly.", denied: "This chat is no longer available. Please reopen it or contact the team directly.", limited: "Too many requests. Please wait a few minutes before trying again.", training: "Test mode", you: "You", assistant: "Assistant" },
    de: { open: "Frage stellen", title: "Website-Assistent", close: "Chat schließen", label: "Deine Frage", placeholder: "Was möchtest du wissen?", send: "Senden", working: "Antwort wird vorbereitet…", welcome: "Stelle eine Frage zu unseren veröffentlichten Informationen. KI-Antworten können Fehler enthalten; prüfe die angegebenen Quellen.", sources: "Quellen", error: "Der Assistent ist gerade nicht erreichbar. Bitte versuche es später erneut oder kontaktiere das Team direkt.", denied: "Dieser Chat ist nicht mehr verfügbar. Öffne ihn erneut oder kontaktiere das Team direkt.", limited: "Zu viele Anfragen. Bitte warte einige Minuten und versuche es erneut.", training: "Testmodus", you: "Du", assistant: "Assistent" },
    es: { open: "Hacer una pregunta", title: "Asistente web", close: "Cerrar chat", label: "Tu pregunta", placeholder: "¿Qué te gustaría saber?", send: "Enviar", working: "Preparando la respuesta…", welcome: "Pregunta sobre nuestra información publicada. Las respuestas de IA pueden contener errores; consulta las fuentes indicadas.", sources: "Fuentes", error: "El asistente no está disponible temporalmente. Inténtalo más tarde o contacta directamente con el equipo.", denied: "Este chat ya no está disponible. Ábrelo de nuevo o contacta directamente con el equipo.", limited: "Demasiadas solicitudes. Espera unos minutos antes de intentarlo de nuevo.", training: "Modo de prueba", you: "Tú", assistant: "Asistente" },
  };
  const disclaimers = {
    en: "AI answers can contain mistakes; check the listed sources.",
    de: "KI-Antworten können Fehler enthalten; prüfe die angegebenen Quellen.",
    es: "Las respuestas de IA pueden contener errores; consulta las fuentes indicadas.",
  };
  const bookingCopy = {
    en: { open: "Book an appointment", title: "Appointment booking", back: "Back to chat", type: "Appointment type", date: "Date", location: "Full visit address", addressConsent: "I confirm this unambiguous address for the visit.", availability: "Show available times", slots: "Choose an available start time", empty: "No suitable times are available on this day. Choose another day or contact the team.", travel: "The location or required journey could not be checked for some times. Contact the team to request an appointment.", name: "Your name", email: "Your email address", summary: "Your selection", consent: "I want to book this appointment with the details shown.", confirm: "Confirm appointment booking", status: "Check booking status", processing: "The outcome is not final yet. Check its status; do not create a second booking.", confirmed: "Your appointment is confirmed.", held: "This time is reserved. Check the summary and confirm this same reservation.", error: "This action could not be completed. Check the booking status or contact the team directly.", unavailable: "Appointment booking is currently unavailable. You can continue using the chat.", reschedule: "Reschedule appointment", rescheduleConsent: "I want to reschedule my appointment to the selected time.", rescheduleConfirm: "Confirm rescheduling", rescheduled: "Your appointment has been rescheduled.", cancel: "Cancel appointment", cancelConsent: "I want to cancel this appointment.", cancelConfirm: "Confirm cancellation", cancelled: "Your appointment has been cancelled.", minutes: "minutes", working: "Checking appointment booking…", kinds: { phone: "Phone appointment", teams: "Microsoft Teams", meet: "Google Meet", office: "Office appointment", onsite: "Customer visit / viewing" } },
    de: { open: "Termin buchen", title: "Terminbuchung", back: "Zurück zum Chat", type: "Terminart", date: "Datum", location: "Vollständige Besuchsadresse", addressConsent: "Ich bestätige diese eindeutige Adresse für den Besuch.", availability: "Freie Zeiten anzeigen", slots: "Freie Startzeit auswählen", empty: "An diesem Tag sind keine passenden Zeiten verfügbar. Bitte einen anderen Tag wählen oder das Team kontaktieren.", travel: "Ort oder notwendige Fahrt konnten für einige Zeiten nicht geprüft werden. Bitte einen Terminwunsch beim Team anfragen.", name: "Ihr Name", email: "Ihre E-Mail-Adresse", summary: "Ihre Auswahl", consent: "Ich möchte diesen Termin zu den angezeigten Angaben verbindlich buchen.", confirm: "Termin verbindlich buchen", status: "Buchungsstatus prüfen", processing: "Das Ergebnis ist noch nicht abschließend bekannt. Bitte den Status prüfen; keine zweite Buchung anlegen.", confirmed: "Ihr Termin ist bestätigt.", held: "Die Zeit ist reserviert. Bitte die Zusammenfassung prüfen und diese Reservierung bestätigen.", error: "Die Aktion konnte nicht abgeschlossen werden. Bitte den Buchungsstatus prüfen oder das Team direkt kontaktieren.", unavailable: "Terminbuchung ist derzeit nicht verfügbar. Der Chat bleibt nutzbar.", reschedule: "Termin umbuchen", rescheduleConsent: "Ich möchte meinen Termin auf die ausgewählte Zeit umbuchen.", rescheduleConfirm: "Umbuchung bestätigen", rescheduled: "Ihr Termin wurde umgebucht.", cancel: "Termin absagen", cancelConsent: "Ich möchte diesen Termin absagen.", cancelConfirm: "Absage bestätigen", cancelled: "Ihr Termin wurde abgesagt.", minutes: "Minuten", working: "Terminbuchung wird geprüft …", kinds: { phone: "Telefontermin", teams: "Microsoft Teams", meet: "Google Meet", office: "Termin im Büro", onsite: "Kundenbesuch / Besichtigung" } },
  };
  Object.assign(bookingCopy.en, { changeUnconfirmed: "The requested change is not confirmed. Your existing appointment is still at", cancelUnconfirmed: "Cancellation is not confirmed. Your existing appointment is still at", video: "Join video meeting", videoPending: "The provider is still preparing your video link. Check the booking status again.", videoUnavailable: "Your video link is currently unavailable. Check the booking status or contact the team.", newChoice: "Start a new appointment selection" });
  Object.assign(bookingCopy.de, { changeUnconfirmed: "Die Umbuchung ist nicht bestätigt. Ihr bestehender Termin ist weiterhin am", cancelUnconfirmed: "Die Absage ist nicht bestätigt. Ihr bestehender Termin ist weiterhin am", video: "An Videokonferenz teilnehmen", videoPending: "Ihr Videolink wird noch vom Anbieter erstellt. Bitte den Buchungsstatus erneut prüfen.", videoUnavailable: "Ihr Videolink ist derzeit nicht verfügbar. Bitte den Buchungsstatus prüfen oder das Team kontaktieren.", newChoice: "Neue Terminauswahl beginnen" });
  const bookingWords = () => bookingCopy[language === "de" ? "de" : "en"];
  let words = translations[language];
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  const host = element("div");
  host.setAttribute("data-novalure-chat-host", "");
  const shadow = host.attachShadow({ mode: "open" });
  const stylesheet = element("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = `${apiOrigin}/chat/widget.css`;
  // Keep the launcher hidden until its external stylesheet has loaded. This
  // works with a customer CSP that allows the central host in style-src.
  host.hidden = true;
  stylesheet.addEventListener("load", () => { host.hidden = false; });
  const launcher = element("button", words.open, "launcher");
  launcher.type = "button";
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "novalure-chat-panel");
  const panel = element("section", "", "panel");
  panel.id = "novalure-chat-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", words.title);
  const heading = element("header", "", "heading"), title = element("h2", words.title, "title");
  const identity = element("div"), brand = element("p", "", "brand");
  brand.hidden = true;
  identity.append(title, brand);
  const close = element("button", "×", "close");
  close.type = "button";
  close.setAttribute("aria-label", words.close);
  heading.append(identity, close);
  const mode = element("div", "", "mode");
  const bookLauncher = element("button", bookingWords().open, "booking-launcher");
  bookLauncher.type = "button";
  bookLauncher.hidden = true;
  const log = element("div", "", "log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  log.setAttribute("aria-relevant", "additions");
  log.setAttribute("aria-label", words.title);
  const form = element("form", "", "composer"), label = element("label", words.label, "label");
  const input = element("textarea");
  input.id = "novalure-chat-question";
  input.maxLength = 2000;
  input.rows = 2;
  input.required = true;
  input.placeholder = words.placeholder;
  label.htmlFor = input.id;
  const status = element("p", "", "status");
  status.setAttribute("role", "status");
  const send = element("button", words.send, "send");
  send.type = "submit";
  form.append(label, input, status, send);
  panel.append(heading, mode, bookLauncher, log, form);
  shadow.append(stylesheet, launcher, panel);
  (document.body || document.documentElement).append(host);
  // Tokens never enter attributes, globals, storage, cookies or URLs.
  let session = null, pending = false;
  const renderedMessages = [];
  function message(text, user = false, citations = []) {
    const bubble = element("div", "", `message${user ? " user" : ""}`);
    const speaker = element("span", user ? words.you : words.assistant, "speaker"), body = element("span", text.slice(0, 2400));
    bubble.append(speaker, body);
    if (citations.length) {
      const list = element("ul", "", "citations");
      list.setAttribute("aria-label", words.sources);
      for (const citation of citations.slice(0, 5)) if (citation && typeof citation.title === "string") list.append(element("li", `${words.sources}: ${citation.title.slice(0, 200)}`));
      bubble.append(list);
    }
    log.append(bubble);
    const rendered = { bubble, speaker, body, user };
    renderedMessages.push(rendered);
    while (renderedMessages.length > 40) renderedMessages.shift().bubble.remove();
    log.scrollTop = log.scrollHeight;
    return rendered;
  }
  const welcome = message(words.welcome);
  function applyWidget(widget) {
    if (!widget || typeof widget !== "object" || Array.isArray(widget)) return;
    if (typeof widget.language === "string" && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(widget.language)) {
      const configured = widget.language.toLowerCase().split("-")[0];
      language = ["de", "es"].includes(configured) ? configured : "en";
      words = translations[language];
    }
    host.setAttribute("lang", language);
    launcher.textContent = words.open;
    title.textContent = typeof widget.assistantName === "string" && widget.assistantName.trim()
      ? widget.assistantName.trim().slice(0, 120) : words.title;
    panel.setAttribute("aria-label", title.textContent);
    log.setAttribute("aria-label", title.textContent);
    close.setAttribute("aria-label", words.close);
    label.textContent = words.label;
    input.placeholder = words.placeholder;
    send.textContent = words.send;
    bookLauncher.textContent = bookingWords().open;
    if (pending) status.textContent = words.working;
    for (const item of renderedMessages) item.speaker.textContent = item.user ? words.you : words.assistant;
    brand.textContent = typeof widget.brandName === "string" ? widget.brandName.trim().slice(0, 120) : "";
    brand.hidden = !brand.textContent;
    welcome.body.textContent = typeof widget.welcomeMessage === "string" && widget.welcomeMessage.trim()
      ? `${widget.welcomeMessage.trim().slice(0, 500)}\n\n${disclaimers[language]}` : words.welcome;
    if (widget.widgetPosition === "bottom_left" || widget.widgetPosition === "bottom_right") host.setAttribute("data-position", widget.widgetPosition);
    if (typeof widget.primaryColor === "string" && /^#[0-9a-f]{6}$/i.test(widget.primaryColor)) {
      // Only validated colors enter CSSOM properties; no style text, URLs or
      // inline <style> are created, including under a strict customer CSP.
      const color = widget.primaryColor;
      const brightness = (parseInt(color.slice(1, 3), 16) * 299 + parseInt(color.slice(3, 5), 16) * 587 + parseInt(color.slice(5, 7), 16) * 114) / 1000;
      host.style.setProperty("--novalure-primary-color", color);
      host.style.setProperty("--novalure-button-text", brightness >= 160 ? "#182431" : "#ffffff");
    }
  }
  function hide() {
    panel.hidden = true;
    launcher.hidden = false;
    launcher.setAttribute("aria-expanded", "false");
    launcher.focus();
  }
  launcher.addEventListener("click", () => {
    panel.hidden = false;
    launcher.hidden = true;
    launcher.setAttribute("aria-expanded", "true");
    input.focus();
  });
  close.addEventListener("click", hide);
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); hide(); }
    if (event.key === "Tab") {
      const controls = shadow.querySelectorAll ? [...shadow.querySelectorAll("button,input,select,textarea,a[href]")] : [close, input, send];
      const focusable = controls.filter(node => !(node.matches ? node.matches(":disabled") : node.disabled) && !node.hidden && (!node.closest || !node.closest("[hidden]")));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  async function post(path, body, headers = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${apiOrigin}/api/public/integrations/chat/${path}?site_key=${encodeURIComponent(key)}`, {
        method: "POST", credentials: "omit", mode: "cors", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", "x-novalure-site-key": key, ...headers }, body: JSON.stringify(body),
      });
      if (!response.ok) { const error = new Error("chat_unavailable"); error.status = response.status; throw error; }
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  // The booking UI only transports the existing server-owned chat tools. All
  // session credentials and operation keys remain in this widget's closure.
  let bookingUi = null;
  function bookingTool(operation, payload = {}) {
    if (!session) return Promise.reject(new Error("chat_session_required"));
    return post("booking", { sessionId: session.id, operation, ...payload }, { "x-novalure-session-token": session.token });
  }
  function mountBooking(configuration) {
    const bookingLanguage = ["de", "en"].includes(configuration.language) ? configuration.language : language === "de" ? "de" : "en";
    const text = bookingCopy[bookingLanguage], box = element("section", "", "booking"), heading = element("h3", typeof configuration.title === "string" ? configuration.title.slice(0, 120) : text.title);
    box.setAttribute("aria-label", text.title);
    const back = element("button", text.back, "booking-back"); back.type = "button";
    const fields = element("fieldset"), bookingForm = element("form"), notice = element("p", "", "status"); notice.setAttribute("role", "status");
    const makeField = (tag, labelText, name) => {
      const wrapper = element("div", "", "booking-label"), label = element("label", labelText), control = element(tag);
      control.id = `novalure-chat-booking-${name}`; label.htmlFor = control.id; wrapper.append(label, control); fields.append(wrapper); return control;
    };
    const kind = makeField("select", text.type, "type"), date = makeField("input", text.date, "date"); date.type = "date"; date.required = true;
    const address = makeField("input", text.location, "location"); address.maxLength = 500;
    const addressConfirmed = makeField("input", text.addressConsent, "address-consent"); addressConfirmed.type = "checkbox";
    const availability = element("button", text.availability); availability.type = "button"; fields.append(availability);
    const slots = makeField("select", text.slots, "slot");
    const name = makeField("input", text.name, "name"); name.maxLength = 160; name.required = true; name.autocomplete = "name";
    const email = makeField("input", text.email, "email"); email.type = "email"; email.maxLength = 254; email.required = true; email.autocomplete = "email";
    const summary = element("div", "", "booking-summary"); summary.setAttribute("role", "region"); summary.setAttribute("aria-label", text.summary); fields.append(summary);
    const consent = makeField("input", text.consent, "consent"); consent.type = "checkbox";
    const confirm = element("button", text.confirm); confirm.type = "button";
    const statusButton = element("button", text.status); statusButton.type = "button";
    const reschedule = element("button", text.reschedule); reschedule.type = "button";
    const cancel = element("button", text.cancel); cancel.type = "button";
    const cancelConsent = makeField("input", text.cancelConsent, "cancel-consent"); cancelConsent.type = "checkbox";
    const cancelConfirm = element("button", text.cancelConfirm); cancelConfirm.type = "button";
    const newChoice = element("button", text.newChoice); newChoice.type = "button";
    const video = element("a", text.video), videoNotice = element("p", text.videoPending, "status");
    video.target = "_blank"; video.rel = "noopener noreferrer"; video.referrerPolicy = "no-referrer";
    fields.append(confirm, statusButton, reschedule, cancel, cancelConfirm, newChoice);
    bookingForm.append(fields); box.append(heading, back, notice, video, videoNotice, bookingForm); log.append(box);
    const types = configuration.types;
    for (const type of types) { const option = element("option", `${text.kinds[type.kind]} · ${type.durationMinutes} ${text.minutes} · ${type.timeZone}`); option.value = type.id; kind.append(option); }
    kind.value = types[0].id;
    let currentSession = null, row = null, attempt = null, unknown = false, busy = false, management = null, requestedChange = null;
    const keys = new Map();
    const selectedType = () => types.find(type => type.id === kind.value);
    const location = () => selectedType().locationRequired ? address.value.trim() : selectedType().location;
    const instant = value => new Intl.DateTimeFormat(bookingLanguage === "de" ? "de-AT" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: row?.timeZone || selectedType().timeZone }).format(new Date(value));
    const spokenSummary = (startsAt, value = row) => ({ startsAt, timeZone: value?.timeZone || selectedType().timeZone, kind: value?.kind || selectedType().kind, location: value?.location ?? location() });
    const actionKey = action => { const key = `${action}:${row?.id}:${slots.value}`; if (!keys.has(key)) keys.set(key, crypto.randomUUID()); return keys.get(key); };
    function render() {
      const type = selectedType(), terminal = row && ["cancelled", "expired"].includes(row.state), locked = unknown || row && !terminal, editing = !terminal && (!locked || management === "reschedule");
      fields.disabled = busy;
      kind.disabled = !!row || !!attempt || unknown; date.disabled = !editing || !!requestedChange; address.disabled = !!locked || !!terminal; addressConfirmed.disabled = !!locked || !!terminal;
      address.parentNode.hidden = !type.locationRequired; addressConfirmed.parentNode.hidden = !type.locationRequired;
      availability.hidden = !editing || !!requestedChange; availability.disabled = !date.value || type.locationRequired && (!address.value.trim() || !addressConfirmed.checked);
      slots.parentNode.hidden = !editing; slots.disabled = !editing || !!requestedChange || slots.options.length <= 1;
      name.parentNode.hidden = !!row; email.parentNode.hidden = !!row;
      name.disabled = !!attempt || !!row || unknown; email.disabled = !!attempt || !!row || unknown;
      const choosing = editing && !!slots.value || row?.state === "held";
      consent.parentNode.hidden = !choosing;
      consent.parentNode.firstChild.textContent = management === "reschedule" ? text.rescheduleConsent : text.consent;
      confirm.hidden = !choosing || unknown; confirm.disabled = !consent.checked;
      confirm.textContent = management === "reschedule" ? text.rescheduleConfirm : text.confirm;
      statusButton.hidden = !attempt && !row;
      reschedule.hidden = row?.state !== "confirmed" || unknown || management !== null;
      cancel.hidden = row?.state !== "confirmed" || unknown || management !== null;
      cancelConsent.parentNode.hidden = management !== "cancel"; cancelConfirm.hidden = management !== "cancel"; cancelConfirm.disabled = !cancelConsent.checked;
      newChoice.hidden = !terminal || unknown;
      const start = management === "reschedule" ? requestedChange?.startsAt || slots.value : row?.startsAt || slots.value;
      const shownLocation = row?.location ?? location();
      const shownName = attempt?.recipientName ?? name.value.trim(), shownEmail = attempt?.recipientEmail ?? email.value.trim();
      summary.textContent = start ? `${text.kinds[row?.kind || type.kind]} · ${instant(start)} · ${row?.timeZone || type.timeZone} · ${type.durationMinutes} ${text.minutes}${shownLocation ? ` · ${shownLocation}` : ""}${shownName || shownEmail ? `\n${shownName} · ${shownEmail}` : ""}` : "";
      if (unknown) notice.textContent = text.processing;
      let videoUrl = null;
      try { const url = new URL(row?.videoUrl); if (url.protocol === "https:" && !url.username && !url.password) videoUrl = url.href; } catch { /* No safe join link is available yet. */ }
      video.hidden = row?.state !== "confirmed" || unknown || !videoUrl;
      if (video.hidden) video.removeAttribute("href"); else video.href = videoUrl;
      videoNotice.hidden = row?.state !== "confirmed" || unknown || !["teams", "meet"].includes(row.kind) || !!videoUrl;
      videoNotice.textContent = row?.videoStatus === "pending" ? text.videoPending : text.videoUnavailable;
    }
    function resetSlots() { slots.replaceChildren(); slots.value = ""; consent.checked = false; notice.textContent = ""; render(); }
    async function ensureBookingSession() {
      if (currentSession) return currentSession;
      if (attempt || row) throw new Error("existing_booking_session_required");
      const value = await bookingTool("session", { typeId: kind.value, language: bookingLanguage });
      if (typeof value.token !== "string") throw new Error("invalid_booking_session");
      currentSession = value.token; return currentSession;
    }
    function apply(value) {
      if (value?.booking && typeof value.booking.id === "string") { row = value.booking; if (attempt) attempt.bookingId = row.id; }
      unknown = value?.unknown === true || value?.pending === true || !!row && ["processing", "uncertain"].includes(row.state) || !row && !!attempt;
      if (unknown) notice.textContent = text.processing;
      else if (row?.state === "held") notice.textContent = text.held;
      else if (row?.state === "confirmed" && requestedChange?.kind === "reschedule" && row.startsAt !== requestedChange.startsAt) {
        notice.textContent = `${text.changeUnconfirmed} ${instant(row.startsAt)} · ${row.timeZone}.`;
        consent.checked = false; management = "reschedule"; return;
      } else if (row?.state === "confirmed" && requestedChange?.kind === "cancel") {
        notice.textContent = `${text.cancelUnconfirmed} ${instant(row.startsAt)} · ${row.timeZone}.`;
        cancelConsent.checked = false; management = "cancel"; return;
      } else if (row?.state === "confirmed") notice.textContent = requestedChange?.kind === "reschedule" ? text.rescheduled : text.confirmed;
      else if (row?.state === "cancelled") notice.textContent = text.cancelled;
      else if (row) notice.textContent = text.error;
      if (!unknown && row?.state !== "held") { management = null; requestedChange = null; }
    }
    async function run(action, mutation = false) {
      if (busy) return;
      const hadUnknownOutcome = unknown || requestedChange?.unknown === true;
      busy = true; notice.textContent = text.working; render();
      try { await action(); } catch (cause) {
        const definiteRejection = cause.status >= 400 && cause.status < 500 && !hadUnknownOutcome;
        if (mutation && definiteRejection) {
          if (requestedChange) {
            for (const [key, value] of keys) if (value === requestedChange.key) keys.delete(key);
            requestedChange = null; slots.replaceChildren(); slots.value = "";
          } else if (!row) { attempt = null; currentSession = null; slots.replaceChildren(); slots.value = ""; }
          consent.checked = false; cancelConsent.checked = false; unknown = false;
        } else if (mutation && attempt) {
          unknown = true; if (requestedChange) requestedChange.unknown = true;
        }
        notice.textContent = unknown ? text.processing : text.error;
      }
      finally {
        busy = false; render();
        if (!box.hidden && !panel.hidden) (attempt || row ? statusButton : availability.disabled ? date : availability).focus();
      }
    }
    kind.addEventListener("change", () => { if (attempt || row) return; currentSession = null; resetSlots(); });
    date.addEventListener("change", resetSlots);
    address.addEventListener("input", () => { addressConfirmed.checked = false; resetSlots(); });
    addressConfirmed.addEventListener("change", resetSlots);
    for (const control of [name, email]) control.addEventListener("input", () => { consent.checked = false; render(); });
    consent.addEventListener("change", render); cancelConsent.addEventListener("change", render); slots.addEventListener("change", () => { consent.checked = false; render(); });
    availability.addEventListener("click", () => run(async () => {
      const token = await ensureBookingSession(), value = await bookingTool("availability", { token, date: date.value, ...(selectedType().locationRequired ? { location: location(), locationConfirmed: addressConfirmed.checked } : {}), ...(management === "reschedule" ? { bookingId: row.id } : {}) });
      if (!Array.isArray(value.slots) || value.timeZone !== selectedType().timeZone) throw new Error("invalid_availability");
      slots.replaceChildren(); const choose = element("option", text.slots); choose.value = ""; slots.append(choose);
      for (const slot of value.slots) { if (typeof slot.startsAt !== "string" || !Number.isFinite(Date.parse(slot.startsAt))) throw new Error("invalid_slot"); const option = element("option", instant(slot.startsAt)); option.value = slot.startsAt; slots.append(option); }
      slots.value = ""; slots.disabled = !value.slots.length; consent.checked = false; notice.textContent = value.requestFallback ? text.travel : value.slots.length ? "" : text.empty;
    }));
    confirm.addEventListener("click", () => {
      if (!consent.checked || unknown || !slots.value && row?.state !== "held") return;
      if (!row && (!name.reportValidity() || !email.reportValidity())) return;
      void run(async () => {
        const token = await ensureBookingSession();
        if (management === "reschedule") {
          if (!requestedChange) requestedChange = { kind: "reschedule", startsAt: slots.value, key: actionKey("reschedule") };
          apply(await bookingTool("reschedule", { token, bookingId: row.id, startsAt: requestedChange.startsAt, idempotencyKey: requestedChange.key, consent: true, summary: spokenSummary(requestedChange.startsAt) })); return;
        }
        if (!row) {
          if (!attempt) attempt = { key: crypto.randomUUID(), recipientName: name.value.trim(), recipientEmail: email.value.trim() };
          apply(await bookingTool("hold", { token, startsAt: slots.value, recipientName: name.value.trim(), recipientEmail: email.value.trim(), idempotencyKey: attempt.key, ...(selectedType().locationRequired ? { location: location(), locationConfirmed: addressConfirmed.checked } : {}) }));
        }
        if (!unknown && row?.state === "held") apply(await bookingTool("confirm", { token, bookingId: row.id, consent: true, summary: spokenSummary(row.startsAt) }));
      }, true);
    });
    statusButton.addEventListener("click", () => run(async () => {
      if (!currentSession || !attempt && !row) return;
      apply(await bookingTool("status", { token: currentSession, ...(row ? { bookingId: row.id } : { idempotencyKey: attempt.key }) }));
    }));
    reschedule.addEventListener("click", () => { management = "reschedule"; resetSlots(); date.focus(); });
    cancel.addEventListener("click", () => { management = "cancel"; cancelConsent.checked = false; render(); cancelConsent.focus(); });
    cancelConfirm.addEventListener("click", () => { if (!cancelConsent.checked || row?.state !== "confirmed") return; void run(async () => {
      if (!requestedChange) requestedChange = { kind: "cancel", key: actionKey("cancel") };
      apply(await bookingTool("cancel", { token: currentSession, bookingId: row.id, idempotencyKey: requestedChange.key, consent: true, summary: spokenSummary(row.startsAt) }));
    }, true); });
    newChoice.addEventListener("click", () => {
      if (unknown || !row || !["cancelled", "expired"].includes(row.state)) return;
      currentSession = null; row = null; attempt = null; requestedChange = null; management = null; keys.clear();
      date.value = ""; address.value = ""; addressConfirmed.checked = false; name.value = ""; email.value = ""; cancelConsent.checked = false;
      resetSlots(); kind.focus();
    });
    back.addEventListener("click", () => { box.hidden = true; bookLauncher.focus(); });
    bookingForm.addEventListener("submit", event => event.preventDefault());
    render(); kind.focus();
    return { show() { box.hidden = false; kind.focus(); } };
  }
  bookLauncher.addEventListener("click", async () => {
    if (bookingUi) { bookingUi.show(); return; }
    if (!session || bookLauncher.disabled) return;
    bookLauncher.disabled = true;
    try {
      const config = await bookingTool("configuration");
      if (!config || !Array.isArray(config.types) || !config.types.length || config.types.some(type => !type || typeof type.id !== "string" || !bookingWords().kinds[type.kind] || typeof type.timeZone !== "string" || !Number.isFinite(type.durationMinutes))) throw new Error("invalid_booking_configuration");
      bookingUi = mountBooking(config);
    } catch { message(bookingWords().unavailable); }
    finally { bookLauncher.disabled = false; }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const question = input.value.trim();
    if (pending || !question || question.length > 2000) return;
    pending = true;
    send.disabled = true;
    status.textContent = words.working;
    message(question, true);
    input.value = "";
    try {
      if (!session) {
        const started = await post("sessions", { language }, { "idempotency-key": crypto.randomUUID() });
        if (typeof started.sessionId !== "string" || typeof started.sessionToken !== "string" || started.status !== "active") throw new Error("invalid_session");
        session = { id: started.sessionId, token: started.sessionToken };
        // The existing public gateway returns configuration with the lazy
        // session. Before the first question, the widget uses generic defaults.
        applyWidget(started.widget);
        mode.textContent = started.mode === "training" ? words.training : "";
        bookLauncher.hidden = started.bookingAvailable !== true || started.mode !== "real_customer";
      }
      const answer = await post("answers", { sessionId: session.id, message: question }, { "x-novalure-session-token": session.token });
      if (answer.contractVersion !== "website-answer-v1" || !["grounded", "insufficient_knowledge", "temporarily_unavailable"].includes(answer.answerStatus) || typeof answer.answer !== "string" || !Array.isArray(answer.citations)) throw new Error("invalid_answer");
      message(answer.answer, false, answer.answerStatus === "grounded" ? answer.citations : []);
    } catch (error) {
      if ([403, 404].includes(error.status)) { session = null; bookLauncher.hidden = true; }
      message(error.status === 429 ? words.limited : [403, 404].includes(error.status) ? words.denied : words.error);
    } finally {
      pending = false;
      send.disabled = false;
      status.textContent = "";
      if (!panel.hidden) input.focus();
    }
  });
})();
