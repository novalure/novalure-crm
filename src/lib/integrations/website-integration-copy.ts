import type { LanguageCode } from "@/lib/i18n";

const de = {
  tab: "Website-Chat", title: "Ihren Website-Chat verbinden",
  intro: "Wählen Sie einen Assistenten mit veröffentlichtem Webchat-Wissen, hinterlegen Sie Ihre Website und kopieren Sie den Einbettungscode.",
  add: "Website verbinden", edit: "Verbindung bearbeiten", empty: "Noch keine Website verbunden",
  loading: "Website-Verbindungen werden geladen …", loadError: "Die Website-Verbindungen konnten nicht geladen werden.",
  saveError: "Die Verbindung konnte nicht gespeichert werden.", saved: "Website-Verbindung gespeichert.",
  save: "Verbindung speichern", saving: "Wird gespeichert …", cancel: "Abbrechen", refresh: "Aktualisieren",
  project: "Projekt", company: "Unternehmen ohne Projekt", projectFixed: "Das Projekt einer bestehenden Verbindung bleibt fest zugeordnet.",
  assistant: "Assistent", selectAssistant: "Assistent auswählen", noAssistant: "Chat-Zuordnung entfernen",
  assistantHelp: "Es werden nur Assistenten aus dem gewählten Projekt angezeigt. Das freigegebene Wissen verwalten Sie unter KI-Zuordnungen.",
  knowledge: "Webchat-Wissen zuordnen", domains: "Erlaubte Website-Adressen",
  domainsHelp: "Eine vollständige HTTPS-Adresse je Zeile, ohne Unterseite. www und die Adresse ohne www getrennt eintragen, wenn beide verwendet werden.",
  brand: "Unternehmensname", assistantName: "Anzeigename des Assistenten", welcome: "Begrüßung", color: "Farbe", language: "Sprache", position: "Position",
  right: "Unten rechts", left: "Unten links", mode: "Betrieb", training: "Training", live: "Kundenbetrieb",
  trainingHelp: "Auch im Training ist der Chat auf den erlaubten Websites erreichbar. Testen Sie zuerst auf Ihrer eigenen Test-Domain.",
  newHelp: "Eine neue Verbindung startet im Training. Nach dem Einbau und einem erfolgreichen Test können Sie den Kundenbetrieb aktivieren.",
  status: "Status", test: "Test", active: "Aktiv", disabled: "Pausiert", revoked: "Widerrufen", pause: "Pausieren",
  ready: "Veröffentlichtes Webchat-Wissen vorhanden", notReady: "Einrichtung prüfen", sources: "veröffentlichte Quellen",
  publicKey: "Öffentlicher Website-Schlüssel", embed: "Einbettungscode", embedHelp: "Diesen Code einmal in den HTML-Bereich Ihrer Website einfügen. Änderungen an Wissen, Darstellung und Zuordnung werden danach zentral verwaltet.",
  copy: "Code kopieren", copied: "Einbettungscode kopiert.", copyError: "Bitte den Code im Textfeld auswählen und kopieren.",
  notRunning: "Diese Verbindung ist pausiert oder widerrufen. Das eingebundene Widget nimmt keine neuen Chats an.",
  pendingEmbed: "Der Einbettungscode steht nach dem Speichern einer gültigen Assistentenzuordnung bereit.",
  readonly: "Für Änderungen sind Verwaltungsrechte für Website-Verbindungen erforderlich.",
  conflict: "Die Verbindung wurde inzwischen geändert. Aktualisieren Sie die Liste und öffnen Sie die Bearbeitung erneut.",
  count: "Mit Wissen verbundene Assistenten", countHelp: "Ein Assistent zählt über alle Wissenskanäle einmal. Pausieren oder eine weitere Domain verändert diese Anzahl nicht. Erst das Entfernen aller Wissenszuordnungen gibt den Platz frei.",
  defaultWelcome: "Wie kann ich Ihnen helfen?",
};
type Copy = { [Key in keyof typeof de]: string };
const en: Copy = {
  tab: "Website chat", title: "Connect your website chat",
  intro: "Choose an assistant with published webchat knowledge, add your website and copy the embed code.",
  add: "Connect a website", edit: "Edit connection", empty: "No website connected yet",
  loading: "Loading website connections …", loadError: "Website connections could not be loaded.",
  saveError: "The connection could not be saved.", saved: "Website connection saved.",
  save: "Save connection", saving: "Saving …", cancel: "Cancel", refresh: "Refresh",
  project: "Project", company: "Company without a project", projectFixed: "An existing connection keeps its assigned project.",
  assistant: "Assistant", selectAssistant: "Choose an assistant", noAssistant: "Remove chat assignment",
  assistantHelp: "Only assistants from the selected project are shown. Manage their approved knowledge under AI assignments.",
  knowledge: "Assign webchat knowledge", domains: "Allowed website addresses",
  domainsHelp: "One full HTTPS address per line, without a page path. Add www and the address without www separately if you use both.",
  brand: "Company name", assistantName: "Assistant display name", welcome: "Greeting", color: "Colour", language: "Language", position: "Position",
  right: "Bottom right", left: "Bottom left", mode: "Operation", training: "Training", live: "Customer operation",
  trainingHelp: "The chat is reachable on its allowed websites during training too. Start on your own test domain.",
  newHelp: "A new connection starts in training. After installing and successfully testing it, you can enable customer operation.",
  status: "Status", test: "Test", active: "Active", disabled: "Paused", revoked: "Revoked", pause: "Pause",
  ready: "Published webchat knowledge available", notReady: "Check setup", sources: "published sources",
  publicKey: "Public website key", embed: "Embed code", embedHelp: "Insert this code once in the HTML section of your website. Knowledge, appearance and assistant assignments are then managed centrally.",
  copy: "Copy code", copied: "Embed code copied.", copyError: "Please select and copy the code in the text field.",
  notRunning: "This connection is paused or revoked. The embedded widget does not accept new chats.",
  pendingEmbed: "The embed code becomes available after saving a valid assistant assignment.",
  readonly: "Website connection management permissions are required to make changes.",
  conflict: "The connection has changed. Refresh the list and reopen the editor.",
  count: "Assistants connected to knowledge", countHelp: "An assistant counts once across all knowledge channels. Pausing it or adding another domain does not change the count. Removing all its knowledge assignments releases the place.",
  defaultWelcome: "How can I help you?",
};
const es: Copy = {
  tab: "Chat web", title: "Conectar el chat de su web",
  intro: "Elija un asistente con conocimiento publicado para el chat web, añada su web y copie el código de inserción.",
  add: "Conectar una web", edit: "Editar conexión", empty: "Todavía no hay ninguna web conectada",
  loading: "Cargando conexiones web …", loadError: "No se pudieron cargar las conexiones web.",
  saveError: "No se pudo guardar la conexión.", saved: "Conexión web guardada.",
  save: "Guardar conexión", saving: "Guardando …", cancel: "Cancelar", refresh: "Actualizar",
  project: "Proyecto", company: "Empresa sin proyecto", projectFixed: "Una conexión existente conserva su proyecto asignado.",
  assistant: "Asistente", selectAssistant: "Elegir asistente", noAssistant: "Quitar la asignación del chat",
  assistantHelp: "Solo se muestran asistentes del proyecto elegido. Gestione su conocimiento aprobado en Asignaciones de IA.",
  knowledge: "Asignar conocimiento al chat web", domains: "Direcciones web permitidas",
  domainsHelp: "Una dirección HTTPS completa por línea, sin ruta de página. Añada por separado las direcciones con www y sin www si utiliza ambas.",
  brand: "Nombre de la empresa", assistantName: "Nombre visible del asistente", welcome: "Saludo", color: "Color", language: "Idioma", position: "Posición",
  right: "Abajo a la derecha", left: "Abajo a la izquierda", mode: "Funcionamiento", training: "Pruebas", live: "Atención a clientes",
  trainingHelp: "El chat también es accesible en las webs permitidas durante las pruebas. Empiece en su propio dominio de pruebas.",
  newHelp: "Una nueva conexión empieza en pruebas. Tras instalarla y comprobarla, puede activar la atención a clientes.",
  status: "Estado", test: "Prueba", active: "Activo", disabled: "Pausado", revoked: "Revocado", pause: "Pausar",
  ready: "Conocimiento publicado disponible", notReady: "Revisar configuración", sources: "fuentes publicadas",
  publicKey: "Clave pública de la web", embed: "Código de inserción", embedHelp: "Inserte este código una vez en el apartado HTML de su web. Después, el conocimiento, la apariencia y las asignaciones se gestionan de forma centralizada.",
  copy: "Copiar código", copied: "Código de inserción copiado.", copyError: "Seleccione y copie el código del campo de texto.",
  notRunning: "La conexión está pausada o revocada. El widget no acepta nuevos chats.",
  pendingEmbed: "El código estará disponible tras guardar una asignación válida de asistente.",
  readonly: "Se requieren permisos de gestión de conexiones web para realizar cambios.",
  conflict: "La conexión ha cambiado. Actualice la lista y vuelva a abrir el editor.",
  count: "Asistentes conectados al conocimiento", countHelp: "Cada asistente cuenta una vez entre todos sus canales. Pausarlo o añadir otro dominio no cambia la cantidad. Quitar todas sus asignaciones de conocimiento libera la plaza.",
  defaultWelcome: "¿Cómo puedo ayudarle?",
};

export function getWebsiteIntegrationCopy(language: LanguageCode | "es"): Copy {
  return language === "de" ? de : language === "es" ? es : en;
}

/** Contains only the public routing key; never an account or provider credential. */
export function websiteChatEmbedCode(publicSiteKey: string): string {
  if (!/^nov_pk_[A-Za-z0-9_-]{24,80}$/u.test(publicSiteKey)) return "";
  return `<script async src="https://www.novalure-crm.app/chat/widget.js" data-site-key="${publicSiteKey}"></script>`;
}
