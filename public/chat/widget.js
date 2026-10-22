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
  panel.append(heading, mode, log, form);
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
      const focusable = [close, input, send].filter(node => !node.disabled);
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
      }
      const answer = await post("answers", { sessionId: session.id, message: question }, { "x-novalure-session-token": session.token });
      if (answer.contractVersion !== "website-answer-v1" || !["grounded", "insufficient_knowledge", "temporarily_unavailable"].includes(answer.answerStatus) || typeof answer.answer !== "string" || !Array.isArray(answer.citations)) throw new Error("invalid_answer");
      message(answer.answer, false, answer.answerStatus === "grounded" ? answer.citations : []);
    } catch (error) {
      if ([403, 404].includes(error.status)) session = null;
      message(error.status === 429 ? words.limited : [403, 404].includes(error.status) ? words.denied : words.error);
    } finally {
      pending = false;
      send.disabled = false;
      status.textContent = "";
      if (!panel.hidden) input.focus();
    }
  });
})();
