import type { PublicLanguageCode } from "@/lib/public-language";
import type { PublicProductPath } from "@/lib/public-product-page";

export type ProductContentPath = Exclude<PublicProductPath, "/" | "/demo">;

type ProductSection = {
  label: string;
  title: string;
  text: string;
};

type ProductPageCopy = {
  metaTitle: string;
  label: string;
  title: string;
  introduction: string;
  highlightsTitle: string;
  highlights: readonly [string, string, string];
  sectionsLabel: string;
  sectionsTitle: string;
  sections: readonly ProductSection[];
  invitationTitle: string;
  invitation: string;
};

export const productPageLabels = {
  de: { related: "Funktionen ansehen", developers: "Zur Seite für Bauträger", agents: "Zur Seite für Makler" },
  en: { related: "Explore features", developers: "For property developers", agents: "For estate agents" },
  es: { related: "Ver funciones", developers: "Para promotoras", agents: "Para agencias inmobiliarias" },
} as const;

const developerCopy: Record<PublicLanguageCode, ProductPageCopy> = {
  de: {
    metaTitle: "CRM für Bauträger und Neubauvertrieb | Novalure CRM",
    label: "Für Bauträger und Projektvertriebe",
    title: "Vom Verkaufsstart bis zur letzten Einheit.",
    introduction: "Steuern Sie die Vermarktung und den Vertrieb Ihrer Neubauprojekte in einem CRM. Ihr Team sieht, welche Wohnungen verfügbar sind, wo Käuferanfragen stehen und wer den nächsten Schritt übernimmt.",
    highlightsTitle: "Was Ihr Team im Blick behält",
    highlights: ["Verfügbarkeit je Einheit", "Offene Schritte je Käuferanfrage", "Reservierungen und Verkäufe je Projekt"],
    sectionsLabel: "Der Ablauf",
    sectionsTitle: "So läuft der Projektvertrieb in Novalure",
    sections: [
      { label: "Bestand", title: "Projekte und Einheiten anlegen", text: "Erfassen Sie Wohnungsdetails, Flächen, Preise, Grundrisse und Stellplätze je Einheit. Der Bestand zeigt verfügbare, vorgemerkte, reservierte, verkaufte und gesperrte Einheiten." },
      { label: "Vermarktung", title: "Freigegebene Inhalte veröffentlichen", text: "Erstellen Sie Web- und PDF-Exposés mit Ihren Firmenvorlagen. Geben Sie Bilder, Grundrisse und Unterlagen gezielt frei. Über veröffentlichte Formulare und Exposés können Interessenten direkt anfragen." },
      { label: "Käuferanfragen", title: "Interesse dem richtigen Projekt zuordnen", text: "Ordnen Sie Anfragen einem Projekt und bei Bedarf einer Einheit zu. Halten Sie Bedarf und Qualifizierung fest, weisen Sie eine zuständige Person zu und legen Sie den nächsten Schritt fest." },
      { label: "Besichtigungen", title: "Termine vorbereiten und bestätigen", text: "Planen Sie Besichtigungen nach einer Objektanfrage oder teilen Sie einen separaten Besichtigungslink. Ihr Team prüft die Terminanfrage, bestätigt den Termin und sieht ihn beim Lead und im CRM-Kalender." },
      { label: "Verkaufsfortschritt", title: "Vormerkung, Reservierung und Verkauf führen", text: "Halten Sie Vormerkungen, Angebote, bestätigte Reservierungen und Verkäufe als getrennte Schritte fest. Externe Vertriebspartner können für ausdrücklich freigegebene Einheiten eine unverbindliche Vormerkung anfragen." },
      { label: "Projektbericht", title: "Bestand und Abschlüsse auswerten", text: "Sehen Sie Einheitenstatus, bestätigte Verkäufe und Leadquellen je Projekt. Hinterlegen Sie Monatsziele und teilen Sie den Projektvertriebsbericht als CSV oder über die Druckansicht." },
    ],
    invitationTitle: "Bringen Sie ein Neubauprojekt in die Demo mit.",
    invitation: "Wir zeigen Ihnen den Ablauf an einem passenden Beispiel und besprechen, wie Ihr Team Einheiten, Käuferanfragen und Reservierungen heute organisiert.",
  },
  en: {
    metaTitle: "CRM for property developers and new home sales | Novalure CRM",
    label: "For property developers and project sales teams",
    title: "From launch to the last available home.",
    introduction: "Manage the marketing and sales of your new developments in one CRM. Your team can see which homes are available, where buyer enquiries stand and who owns the next step.",
    highlightsTitle: "What your team can see",
    highlights: ["Availability by unit", "Next steps by buyer enquiry", "Reservations and sales by development"],
    sectionsLabel: "The workflow",
    sectionsTitle: "How development sales work in Novalure",
    sections: [
      { label: "Inventory", title: "Set up developments and units", text: "Record unit details, floor areas, prices, plans and parking. Your inventory shows which units are available, on hold, reserved, sold or blocked." },
      { label: "Marketing", title: "Publish approved materials", text: "Build web brochures and PDFs using your company templates. Choose which photos, floor plans and documents to share. Buyers can enquire through published forms and brochures." },
      { label: "Buyer enquiries", title: "Match interest to the right development", text: "Link enquiries to a development and, when relevant, a specific unit. Record buyer requirements and qualification, assign an owner and set the next step." },
      { label: "Viewings", title: "Arrange and confirm appointments", text: "Arrange a viewing after a property enquiry or share a separate viewing link. Your team reviews and confirms the appointment, then sees it against the lead and in the CRM calendar." },
      { label: "Sales progress", title: "Manage holds, reservations and sales", text: "Record holds, offers, confirmed reservations and sales as separate steps. External sales partners can request a non-binding hold on units explicitly shared with them." },
      { label: "Project reporting", title: "Review inventory and sales", text: "See unit status, confirmed sales and lead sources by development. Set monthly targets and share the project sales report as a CSV or through its print view." },
    ],
    invitationTitle: "Bring a development to the demo.",
    invitation: "We’ll walk you through a relevant example and discuss how your team handles units, buyer enquiries and reservations today.",
  },
  es: {
    metaTitle: "CRM para promotoras y venta de obra nueva | Novalure CRM",
    label: "Para promotoras y equipos de venta de obra nueva",
    title: "Del lanzamiento a la última vivienda disponible.",
    introduction: "Gestiona la comercialización y la venta de tus promociones de obra nueva en un solo CRM. Tu equipo puede ver qué viviendas están disponibles, en qué punto está cada consulta y quién se encarga del siguiente paso.",
    highlightsTitle: "Lo que tu equipo tiene a la vista",
    highlights: ["Disponibilidad por unidad", "Próximos pasos por consulta", "Reservas y ventas por promoción"],
    sectionsLabel: "El proceso",
    sectionsTitle: "Así se gestiona la venta de promociones en Novalure",
    sections: [
      { label: "Inventario", title: "Crea promociones y unidades", text: "Registra los detalles, superficies, precios, planos y plazas de aparcamiento de cada unidad. El inventario muestra las unidades disponibles, con prerreserva, reservadas, vendidas o bloqueadas." },
      { label: "Comercialización", title: "Publica el material aprobado", text: "Crea dosieres web y PDF con las plantillas de tu empresa. Elige qué imágenes, planos y documentos compartir. Los interesados pueden enviar consultas desde los formularios y dosieres publicados." },
      { label: "Consultas de compradores", title: "Asocia cada consulta a su promoción", text: "Vincula las consultas a una promoción y, cuando proceda, a una unidad. Registra las necesidades del comprador, asigna un responsable y define el siguiente paso." },
      { label: "Visitas", title: "Organiza y confirma citas", text: "Organiza una visita tras una consulta sobre el inmueble o comparte un enlace específico para solicitarla. Tu equipo revisa y confirma la cita, que queda vinculada a la consulta y aparece en el calendario del CRM." },
      { label: "Proceso comercial", title: "Gestiona prerreservas, reservas y ventas", text: "Registra prerreservas, ofertas, reservas confirmadas y ventas como pasos separados. Los colaboradores externos pueden solicitar una prerreserva sin compromiso para las unidades que hayas compartido con ellos." },
      { label: "Informes de promoción", title: "Consulta el inventario y las ventas", text: "Consulta el estado de las unidades, las ventas confirmadas y el origen de las consultas por promoción. Define objetivos mensuales y comparte el informe en CSV o desde la vista de impresión." },
    ],
    invitationTitle: "Trae una promoción a la demo.",
    invitation: "Te mostraremos el proceso con un ejemplo y hablaremos de cómo gestiona tu equipo las unidades, las consultas y las reservas.",
  },
};

const agentCopy: Record<PublicLanguageCode, ProductPageCopy> = {
  de: {
    metaTitle: "Immobilien-CRM für Makler und Maklerteams | Novalure CRM",
    label: "Für Makler und Maklerteams",
    title: "Objekte, Anfragen und Besichtigungen an einem Ort.",
    introduction: "Pflegen Sie Ihren Objektbestand, teilen Sie Exposés und bearbeiten Sie Anfragen im Team. Jede zugeordnete Anfrage bleibt mit ihrem Objekt, ihrer Historie und dem nächsten Schritt verbunden.",
    highlightsTitle: "Was Ihr Team im Blick behält",
    highlights: ["Objekte und freigegebene Unterlagen", "Anfragen und Zuständigkeiten", "Besichtigungen und Wiedervorlagen"],
    sectionsLabel: "Der Ablauf",
    sectionsTitle: "So organisieren Makler ihren Alltag",
    sections: [
      { label: "Objektbestand", title: "Immobilien erfassen und pflegen", text: "Pflegen Sie Objektangaben, Preise, Bilder, Grundrisse und Dokumente zentral. Markieren Sie, welche Inhalte im Exposé erscheinen dürfen." },
      { label: "Exposés", title: "Objekte passend präsentieren", text: "Veröffentlichen Sie Web-Exposés und erstellen Sie PDFs mit Firmenvorlagen. Teilen Sie persönliche Links mit Interessenten und widerrufen Sie diese bei Bedarf." },
      { label: "Anfragen", title: "Käufer- und Eigentümeranfragen bearbeiten", text: "Sammeln Sie Anfragen aus freigegebenen Formularen und Exposés. Ordnen Sie Anfragen zu, dokumentieren Sie Gespräche und halten Sie Zuständigkeit, Aufgabe oder Wiedervorlage in der Leadakte fest." },
      { label: "Besichtigung", title: "Termine mit Objekt und Lead verbinden", text: "Organisieren Sie nach einer Objektanfrage eine Besichtigung oder teilen Sie einen separaten Besichtigungslink. Prüfen und bestätigen Sie Termine im CRM. Kalenderverbindungen mit Google oder Microsoft setzen Einrichtung und Freigabe voraus." },
      { label: "Zusammenarbeit", title: "Vorgänge im Team übergeben", text: "Mit der gemeinsamen Leadakte, Aktivitäten und Aufgaben sehen berechtigte Teammitglieder den Stand, die Zuständigkeit und den nächsten vereinbarten Schritt." },
      { label: "Dateiexport", title: "Objektdaten für die Weitergabe vorbereiten", text: "Erstellen Sie OpenImmo-Dateipakete für vorbereitete Empfängerprofile. Der Export steht als Datei zur Weitergabe bereit." },
    ],
    invitationTitle: "Sehen Sie Novalure am Beispiel eines Maklerauftrags.",
    invitation: "Wir zeigen, wie Sie ein Objekt veröffentlichen und die passende Anfrage bis zur Besichtigung im Team bearbeiten.",
  },
  en: {
    metaTitle: "Real estate CRM for estate agents and brokerages | Novalure CRM",
    label: "For estate agents and brokerages",
    title: "Properties, enquiries and viewings in one place.",
    introduction: "Manage your listings, share brochures and handle enquiries together. Each linked enquiry stays with its property, history and next action.",
    highlightsTitle: "What your team can see",
    highlights: ["Listings and approved documents", "Enquiries and ownership", "Viewings and follow-up tasks"],
    sectionsLabel: "The workflow",
    sectionsTitle: "How estate agents organise their day",
    sections: [
      { label: "Listings", title: "Record and maintain properties", text: "Keep property details, prices, photos, floor plans and documents together. Choose which materials can appear in a brochure." },
      { label: "Brochures", title: "Present properties with your branding", text: "Publish web brochures and generate PDFs using company templates. Share personal links with prospects and revoke them when needed." },
      { label: "Enquiries", title: "Handle buyer and seller enquiries", text: "Capture enquiries from approved forms and property brochures. Assign an owner, record conversations and set tasks or follow-ups in the lead record." },
      { label: "Viewings", title: "Link appointments to properties and leads", text: "Arrange a viewing after a property enquiry or share a separate viewing link. Review and confirm appointments in the CRM. Google or Microsoft calendar connections require setup and authorisation." },
      { label: "Teamwork", title: "Hand over work within the team", text: "Shared lead records, activities and tasks let authorised teammates see the current status, owner and agreed next step." },
      { label: "File export", title: "Prepare listing data to share", text: "Create OpenImmo file packages for configured recipient profiles. The export is available as a file to share." },
    ],
    invitationTitle: "See how Novalure works for an estate agency.",
    invitation: "We’ll show you how to publish a listing and take an enquiry through to a viewing as a team.",
  },
  es: {
    metaTitle: "CRM inmobiliario para agentes y agencias | Novalure CRM",
    label: "Para agentes y agencias inmobiliarias",
    title: "Inmuebles, consultas y visitas en un solo lugar.",
    introduction: "Gestiona tu cartera de inmuebles, comparte dosieres y atiende consultas en equipo. Cada consulta vinculada conserva el inmueble, su historial y el siguiente paso.",
    highlightsTitle: "Lo que tu equipo tiene a la vista",
    highlights: ["Inmuebles y documentos aprobados", "Consultas y responsables", "Visitas y tareas de seguimiento"],
    sectionsLabel: "El proceso",
    sectionsTitle: "Cómo organizan su día a día las agencias",
    sections: [
      { label: "Cartera", title: "Registra y actualiza tus inmuebles", text: "Reúne los datos del inmueble, precios, imágenes, planos y documentos. Elige qué material puede aparecer en el dosier." },
      { label: "Dosieres", title: "Presenta tus inmuebles con tu marca", text: "Publica dosieres web y crea PDF con las plantillas de tu empresa. Comparte enlaces personalizados con los interesados y retira el acceso cuando sea necesario." },
      { label: "Consultas", title: "Atiende a compradores y propietarios", text: "Recibe consultas desde formularios y dosieres publicados. Asigna responsables, registra conversaciones y programa tareas o seguimientos en la ficha de la consulta." },
      { label: "Visitas", title: "Vincula las citas al inmueble y al contacto", text: "Organiza una visita tras una consulta sobre el inmueble o comparte un enlace específico para solicitarla. Revisa y confirma las citas en el CRM. Los calendarios de Google y Microsoft requieren configuración y autorización." },
      { label: "Colaboración", title: "Pasa el trabajo al compañero adecuado", text: "Las fichas compartidas, actividades y tareas permiten al equipo autorizado ver el estado, el responsable y el siguiente paso acordado." },
      { label: "Exportación", title: "Prepara los datos para compartirlos", text: "Genera archivos OpenImmo para perfiles de destinatario configurados. Puedes compartir el archivo exportado." },
    ],
    invitationTitle: "Ve Novalure en acción con un encargo inmobiliario.",
    invitation: "Te mostramos cómo publicar un inmueble y gestionar en equipo una consulta hasta la visita.",
  },
};

const featureCopy: Record<PublicLanguageCode, ProductPageCopy> = {
  de: {
    metaTitle: "Funktionen für Neubauvertrieb und Maklerteams | Novalure CRM",
    label: "Produktfunktionen",
    title: "Bestand, Vermarktung und Vertrieb greifen ineinander.",
    introduction: "Veröffentlichen Sie ein Exposé, bearbeiten Sie die daraus entstandene Anfrage und verfolgen Sie den Verkaufsfortschritt im selben CRM.",
    highlightsTitle: "Drei zentrale Ansichten",
    highlights: ["Web-Exposé für Interessenten", "Leadakte und Pipeline für den Vertrieb", "Projektberichte für die Vertriebsleitung"],
    sectionsLabel: "Funktionsübersicht",
    sectionsTitle: "Was Sie in Novalure erledigen können",
    sections: [
      { label: "Projekte und Einheiten", title: "Verkaufsbestand führen", text: "Organisieren Sie Objekte und Einheiten nach Projekt. Verwalten Sie Verfügbarkeit, Preise, Vormerkungen, Reservierungen und bestätigte Verkäufe." },
      { label: "Web-Exposés und Statistik", title: "Anfragen aufnehmen und Interaktionen auswerten", text: "Veröffentlichen Sie Exposés mit freigegebenen Medien, Einheiten und Anfrageformular. Nutzen Sie PDF-Exposés, Firmenvorlagen und widerrufbare persönliche Links. Mit Einwilligung sehen Sie qualifizierte Aufrufe je Link, aktive sichtbare Zeit pro Abschnitt und Klicks auf Grundrisse, Dokumente, Einheiten und Kontakt-Schaltflächen. Einzelne erfasste Besuche lassen sich im Verlauf ansehen. Anfragen sind auch ohne Statistik möglich." },
      { label: "Leadakte und Pipeline", title: "Anfragen qualifizieren und nachfassen", text: "Verknüpfen Sie Anfragen mit Projekten und bei Bedarf mit Einheiten. Halten Sie Qualifizierung, Gesprächsnotizen, Zuständigkeiten, Aufgaben und den aktuellen Stand in der Pipeline fest." },
      { label: "Termine und Zusammenarbeit", title: "Besichtigungen und Teamzugriff organisieren", text: "Prüfen Sie Besichtigungsanfragen und bestätigen Sie Termine im CRM. Steuern Sie den Projektzugriff über Rollen und geben Sie ausgewählte Einheiten gezielt an externe Vertriebspartner frei." },
      { label: "Marketing und Automatisierung", title: "Zielgruppen, Mailings und Abläufe vorbereiten", text: "Arbeiten Sie mit Formularen, Kampagnenquellen, Zielgruppen, Mailvorlagen und automatisierten Abläufen. Auswertungen verknüpfen erfasste Quellen mit zugeordneten Anfragen und belegten Ergebnissen. Mailversand setzt einen eingerichteten Anbieter und Freigaben voraus." },
      { label: "Berichte", title: "Vertriebsfortschritt je Projekt auswerten", text: "Vergleichen Sie verfügbare, vorgemerkte, reservierte und verkaufte Einheiten. Sehen Sie bestätigte Verkäufe, Leadquellen und Monatsziele. Exportieren Sie den Bericht als CSV oder nutzen Sie die Druckansicht." },
      { label: "Anbindungen und Export", title: "Freigegebene Konten verbinden", text: "Google- und Microsoft-Kalender sowie der persönliche Gmail- und Outlook-Eingang können nach Einrichtung und Freigabe angebunden werden. Für Immobilienportale stehen OpenImmo-Dateipakete zum Export bereit." },
      { label: "KI-Assistent", title: "Texte entwerfen und Vorgänge zusammenfassen", text: "Der Assistent erstellt aus freigegebenen CRM-Daten Tagesüberblicke, Zusammenfassungen, Objekttexte oder bearbeitbare E-Mail-Entwürfe. Ihr Team prüft und verwendet die Ergebnisse." },
    ],
    invitationTitle: "Sehen Sie die Funktionen im Zusammenhang.",
    invitation: "In der Demo folgen wir einer Käuferanfrage vom Web-Exposé bis zum nächsten Schritt im Vertrieb.",
  },
  en: {
    metaTitle: "Features for property developers and estate agents | Novalure CRM",
    label: "Product features",
    title: "Inventory, marketing and sales work together.",
    introduction: "Publish a property brochure, handle the enquiry it generates and follow sales progress in the same CRM.",
    highlightsTitle: "Three central views",
    highlights: ["Web brochures for prospective buyers", "Lead records and pipeline for sales", "Project reports for sales managers"],
    sectionsLabel: "Feature overview",
    sectionsTitle: "What you can do in Novalure",
    sections: [
      { label: "Developments and units", title: "Manage sales inventory", text: "Organise properties and units by development. Manage availability, prices, holds, reservations and confirmed sales." },
      { label: "Web brochures and analytics", title: "Capture enquiries and review interactions", text: "Publish brochures with approved media, units and enquiry forms. Use PDF brochures, company templates and revocable personal links. With consent, see qualified visits per link, active time while each section is visible, and clicks on floor plans, documents, units and contact buttons. Review individual recorded visits in the activity history. Buyers can enquire without analytics." },
      { label: "Lead records and pipeline", title: "Qualify and follow up on enquiries", text: "Link enquiries to developments and, when relevant, units. Record qualification, conversation notes, ownership, tasks and the current pipeline stage." },
      { label: "Appointments and collaboration", title: "Organise viewings and team access", text: "Review viewing requests and confirm appointments in the CRM. Control project access through roles and share selected units with external sales partners." },
      { label: "Marketing and automation", title: "Prepare audiences, mailings and workflows", text: "Work with forms, campaign sources, audiences, email templates and automated workflows. Reports link recorded sources to attributed enquiries and documented outcomes. Sending requires a configured provider and approvals." },
      { label: "Reporting", title: "Review sales progress by development", text: "Compare available, held, reserved and sold units. Review confirmed sales, lead sources and monthly targets. Export a CSV or use the print view." },
      { label: "Connections and exports", title: "Connect authorised accounts", text: "Google and Microsoft calendars and personal Gmail and Outlook inboxes can be connected after setup and authorisation. OpenImmo file packages are available to export for property portals." },
      { label: "AI assistant", title: "Draft text and summarise records", text: "The assistant uses authorised CRM data to create daily briefings, summaries, property descriptions and editable email drafts. Your team reviews and uses the results." },
    ],
    invitationTitle: "See how the features work together.",
    invitation: "In the demo, we’ll follow a buyer enquiry from the property brochure to its next sales action.",
  },
  es: {
    metaTitle: "Funciones para promotoras y agencias inmobiliarias | Novalure CRM",
    label: "Funciones del producto",
    title: "Inventario, comercialización y ventas conectados.",
    introduction: "Publica un dosier, atiende la consulta que genera y sigue el avance comercial en el mismo CRM.",
    highlightsTitle: "Tres vistas clave",
    highlights: ["Dosieres web para los compradores", "Fichas y flujo de ventas para el equipo comercial", "Informes de promoción para la dirección comercial"],
    sectionsLabel: "Resumen de funciones",
    sectionsTitle: "Qué puedes hacer en Novalure",
    sections: [
      { label: "Promociones y unidades", title: "Gestiona el inventario comercial", text: "Organiza los inmuebles y las unidades por promoción. Gestiona la disponibilidad, los precios, las prerreservas, las reservas y las ventas confirmadas." },
      { label: "Dosieres web y analítica", title: "Recibe consultas y revisa las interacciones", text: "Publica dosieres con imágenes autorizadas, unidades y formularios de consulta. Usa dosieres PDF, plantillas y enlaces personales revocables. Con el consentimiento del visitante, consulta las visitas cualificadas por enlace, el tiempo de actividad con cada sección visible y los clics en planos, documentos, unidades y botones de contacto. Revisa las visitas registradas en el historial. También se pueden enviar consultas sin activar la analítica." },
      { label: "Fichas y flujo de ventas", title: "Cualifica y da seguimiento a las consultas", text: "Vincula consultas con promociones y, si procede, con unidades. Registra la cualificación, las notas de conversación, los responsables, las tareas y la fase comercial." },
      { label: "Citas y colaboración", title: "Organiza visitas y accesos del equipo", text: "Revisa solicitudes de visita y confirma citas en el CRM. Asigna el acceso a cada promoción mediante roles y comparte unidades seleccionadas con colaboradores externos." },
      { label: "Marketing y automatización", title: "Prepara públicos, envíos y procesos", text: "Trabaja con formularios, orígenes de campaña, públicos, plantillas de correo y procesos automatizados. Los informes conectan los orígenes registrados con las consultas atribuidas y los resultados documentados. El envío requiere un proveedor configurado y las aprobaciones correspondientes." },
      { label: "Informes", title: "Analiza el avance por promoción", text: "Compara unidades disponibles, con prerreserva, reservadas y vendidas. Consulta ventas confirmadas, orígenes de las consultas y objetivos mensuales. Exporta el informe en CSV o usa la vista de impresión." },
      { label: "Integraciones y exportación", title: "Conecta cuentas autorizadas", text: "Los calendarios de Google y Microsoft y los buzones personales de Gmail y Outlook se pueden conectar previa configuración y autorización. Puedes exportar archivos OpenImmo para portales inmobiliarios." },
      { label: "Asistente de IA", title: "Prepara textos y resume la actividad", text: "El asistente usa los datos autorizados del CRM para crear resúmenes diarios, fichas resumidas, textos de inmuebles y borradores de correo editables. Tu equipo revisa y utiliza los resultados." },
    ],
    invitationTitle: "Mira cómo encajan las funciones.",
    invitation: "En la demo seguiremos una consulta desde el dosier web hasta la siguiente acción del equipo comercial.",
  },
};

export const publicProductCopy = {
  "/bautraeger": developerCopy,
  "/makler": agentCopy,
  "/funktionen": featureCopy,
} satisfies Record<ProductContentPath, Record<PublicLanguageCode, ProductPageCopy>>;
