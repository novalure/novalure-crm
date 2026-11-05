import type { PublicLanguageCode } from "@/lib/public-language";

type TitledCopy = { readonly title: string; readonly body: string };
type SectionCopy = { readonly eyebrow: string; readonly title: string };
type LandingV2Copy = {
  readonly nav: {
    readonly developers: string;
    readonly brokers: string;
    readonly features: string;
    readonly login: string;
    readonly demo: string;
    readonly menuOpen: string;
    readonly menuClose: string;
  };
  readonly hero: {
    readonly eyebrow: string;
    readonly title: string;
    readonly titleAccent: string;
    readonly description: string;
    readonly exampleCta: string;
    readonly accessLine: string;
  };
  readonly project: SectionCopy & {
    readonly description: string;
    readonly note: string;
    readonly inventoryTitle: string;
    readonly inventoryLabels: readonly [string, string, string, string];
    readonly steps: readonly TitledCopy[];
    readonly card: {
      readonly label: string;
      readonly status: string;
      readonly unit: string;
      readonly rows: readonly (readonly [string, string])[];
    };
  };
  readonly features: SectionCopy & {
    readonly items: readonly TitledCopy[];
    readonly cta: string;
  };
  readonly analytics: SectionCopy & {
    readonly description: string;
    readonly imageAlt: string;
    readonly imageCaption: string;
    readonly measuresTitle: string;
    readonly measures: readonly string[];
    readonly contextTitle: string;
    readonly context: readonly string[];
  };
  readonly audiences: SectionCopy & {
    readonly developers: TitledCopy & { readonly cta: string };
    readonly brokers: TitledCopy & { readonly cta: string };
  };
  readonly faq: SectionCopy & {
    readonly items: readonly { readonly question: string; readonly answer: string }[];
  };
  readonly finalCta: {
    readonly title: string;
    readonly description: string;
  };
};

const copy = {
  de: {
    nav: {
      developers: "Bauträger",
      brokers: "Makler",
      features: "Funktionen",
      login: "Team-Login",
      demo: "Demo anfragen",
      menuOpen: "Menü öffnen",
      menuClose: "Menü schließen",
    },
    hero: {
      eyebrow: "Für Bauträger und Projektvertriebe",
      title: "Das CRM für Ihren",
      titleAccent: "Projektvertrieb.",
      description: "Verwalten Sie Neubauprojekte und Einheiten, erfassen Sie Käuferanfragen und behalten Sie Besichtigungen, Reservierungen und den Abverkauf im Blick.",
      exampleCta: "Beispielprojekt ansehen",
      accessLine: "Persönliche Einrichtung · Geschützter Zugang für Ihr Team",
    },
    project: {
      eyebrow: "Vom Bestand zum Vertriebsbericht",
      title: "Projekt Lindenblick",
      description: "Ein fiktives Neubauprojekt mit 24 Wohnungen. An Einheit A.12 sehen Sie, wie Bestand, Käuferanfrage und Vertriebsstatus zusammenhängen.",
      note: "Illustrative Darstellung mit fiktiven Projektdaten.",
      inventoryTitle: "Einheiten im Überblick",
      inventoryLabels: ["Gesamt", "Verfügbar", "Reserviert", "Verkauft"],
      steps: [
        { title: "Bestand erfassen", body: "Der Vertrieb legt Projekt und Einheiten mit Flächen, Preisen und Verfügbarkeit an. A.12 ist zum Vertriebsstart verfügbar." },
        { title: "Anfrage zuordnen", body: "Eine Interessentin fragt A.12 über das freigegebene Webexposé an. Die Anfrage erhält einen Objekt- und Einheitenbezug im CRM." },
        { title: "Interesse qualifizieren", body: "Das Team hält Budget, Finanzierung und Zeitrahmen fest. Die zuständige Person plant den nächsten Schritt." },
        { title: "Besichtigung vereinbaren", body: "Das Team stimmt einen Termin für A.12 ab und behält die Buchung im CRM im Blick." },
        { title: "Einheit reservieren", body: "Nach der Besichtigung bestätigt der Vertrieb die Reservierung. A.12 erscheint im Bestand als reserviert." },
        { title: "Abverkauf auswerten", body: "Im Monatsbericht sieht die Projektleitung den Einheitenbestand, bestätigte Verkäufe, Leadquellen und Angebotsstatus." },
      ],
      card: {
        label: "Fiktives Projekt",
        status: "Reserviert",
        unit: "Einheit A.12 · 3 Zimmer",
        rows: [
          ["Quelle der Anfrage", "Webexposé"],
          ["Qualifizierung", "Budget und Zeitrahmen erfasst"],
          ["Besichtigung", "Durchgeführt"],
          ["Nächster Schritt", "Reservierungsfrist prüfen"],
        ],
      },
    },
    features: {
      eyebrow: "Funktionen für den Projektvertrieb",
      title: "Was Ihr Team im CRM erledigt.",
      items: [
        { title: "Projekte und Einheiten verwalten", body: "Flächen, Preise und Verfügbarkeit pflegen. Vormerkungen, Reservierungen und Verkäufe je Einheit nachvollziehen." },
        { title: "Anfragen gewinnen und zuordnen", body: "Anfragen aus Webexposés, Formularen und veröffentlichten Funnels erfassen und mit dem Vertrieb verbinden." },
        { title: "Käufer betreuen", body: "Kontakte qualifizieren, Aufgaben zuweisen, Gespräche dokumentieren und Besichtigungstermine koordinieren." },
        { title: "Projektvertrieb auswerten", body: "Einheitenbestand, Leadquellen, Angebotsstatus und bestätigte Einheitenverkäufe im Projektvertriebsbericht zusammenführen." },
      ],
      cta: "Alle Funktionen ansehen",
    },
    analytics: {
      eyebrow: "Webexposé und Nutzungsstatistik",
      title: "Sehen Sie, wie Ihr Exposé genutzt wird.",
      description: "Veröffentlichen Sie Webexposés auf Deutsch, Englisch und Spanisch mit ausgewählten Bildern, Grundrissen, Unterlagen und Videos. Zeigen Sie die aktuelle Verfügbarkeit und freigegebene Preise der Einheiten. Teilen Sie widerrufbare Links pro Kanal oder für einen vorgesehenen Empfänger. Anfragen aus dem Exposé gehen direkt ins CRM.",
      imageAlt: "48 qualifizierte Aufrufe, 39 Browser mit Einwilligung, durchschnittlich 2 Minuten 41 Sekunden aktive sichtbare Zeit und 64 Prozent erreichte Abschnitte.",
      imageCaption: "CRM-Ansicht mit fiktiven Nutzungsdaten.",
      measuresTitle: "Was Sie auswerten können",
      measures: [
        "Qualifizierte Aufrufe je Link und Browser mit Einwilligung",
        "Aktive sichtbare Zeit, erreichte Abschnitte und höchste Scrolltiefe pro Abschnitt",
        "Interaktionen mit Bildern, Grundrissen, Unterlagen, Videos und Einheiten",
        "Besuchsverlauf mit erfassten Aktionen",
      ],
      contextTitle: "Wie die Statistik entsteht",
      context: [
        "Nutzungsdaten fließen erst nach Einwilligung ein. Anfragen sind auch ohne Statistik möglich.",
        "Interne Vorschauen und erkannte Scanner werden herausgefiltert.",
        "Ein persönlicher Link bezeichnet den vorgesehenen Empfänger und kann weitergeleitet werden.",
      ],
    },
    audiences: {
      eyebrow: "Für Ihren Vertriebsalltag",
      title: "Für Bauträger entwickelt. Für Maklerteams einsetzbar.",
      developers: { title: "Für Bauträger und Projektvertriebe", body: "Steuern Sie Neubauprojekte mit Einheitenbestand, Käuferanfragen, Reservierungen und Berichten pro Projekt.", cta: "CRM für Bauträger ansehen" },
      brokers: { title: "Für Maklerteams", body: "Organisieren Sie Eigentümer- und Käuferanfragen, Mandate, Suchprofile und passende Objektvorschläge.", cta: "CRM für Makler ansehen" },
    },
    faq: {
      eyebrow: "Häufige Fragen",
      title: "Demo, Einrichtung und Zugang.",
      items: [
        { question: "Wie läuft die Demo ab?", answer: "Wir zeigen Ihnen das CRM anhand eines Beispielprojekts und besprechen, wie Einheiten, Anfragen und Reservierungen in Ihrem Vertrieb zusammenlaufen können." },
        { question: "Was kostet Novalure CRM?", answer: "Sie erhalten ein Angebot für den vereinbarten Umfang. Darin klären wir Einrichtung, laufende Nutzung und gewünschte Zusatzleistungen." },
        { question: "Wie erhält mein Team Zugang?", answer: "Nach der persönlichen Einrichtung laden wir Ihr Team in einen geschützten Arbeitsbereich ein. Rollen und Berechtigungen steuern den Zugriff." },
        { question: "Kann ich bestehende Systeme verbinden?", answer: "Verfügbare Kalender- und Mailfunktionen richten wir abhängig von Anbieter, Verbindung und Freigabe ein. In der Demo klären wir, was Ihre vorhandene Umgebung unterstützt." },
        { question: "Kann ich Interessenten ohne Statistik erfassen?", answer: "Ja. Das Anfrageformular im freigegebenen Webexposé funktioniert unabhängig von der Einwilligung in die Nutzungsstatistik." },
      ],
    },
    finalCta: {
      title: "Sehen Sie Ihren Projektvertrieb im CRM.",
      description: "Wir zeigen Ihnen den Weg von der Einheit über die Käuferanfrage bis zur Reservierung und zum Vertriebsbericht.",
    },
  },
  en: {
    nav: {
      developers: "Developers",
      brokers: "Agents",
      features: "Features",
      login: "Team login",
      demo: "Request a demo",
      menuOpen: "Open menu",
      menuClose: "Close menu",
    },
    hero: {
      eyebrow: "For property developers and project sales teams",
      title: "The CRM for",
      titleAccent: "development sales.",
      description: "Manage new-build projects and units, capture buyer enquiries and keep track of viewings, reservations and sales.",
      exampleCta: "View the example project",
      accessLine: "Personal setup · Secure access for your team",
    },
    project: {
      eyebrow: "From unit inventory to the sales report",
      title: "Lindenblick development",
      description: "A fictional new-build development with 24 apartments. Follow unit A.12 to see how inventory, buyer enquiries and sales status are connected.",
      note: "Illustrative view with fictional project data.",
      inventoryTitle: "Unit inventory at a glance",
      inventoryLabels: ["Total", "Available", "Reserved", "Sold"],
      steps: [
        { title: "Set up the inventory", body: "The sales team records the development and its units, including floor areas, prices and availability. A.12 is available at launch." },
        { title: "Link the enquiry", body: "A buyer enquires about A.12 through the published property microsite. The CRM links the enquiry to the property and unit." },
        { title: "Qualify the buyer", body: "The team records budget, financing and timescale. The person responsible schedules the next step." },
        { title: "Arrange a viewing", body: "The team arranges a viewing for A.12 and keeps track of the booking in the CRM." },
        { title: "Reserve the unit", body: "After the viewing, the sales team confirms the reservation. A.12 appears as reserved in the inventory." },
        { title: "Review sales progress", body: "The project lead can review inventory, confirmed sales, enquiry sources and offer status in the monthly report." },
      ],
      card: {
        label: "Fictional development",
        status: "Reserved",
        unit: "Unit A.12 · 3 rooms",
        rows: [
          ["Enquiry source", "Property microsite"],
          ["Qualification", "Budget and timescale recorded"],
          ["Viewing", "Completed"],
          ["Next step", "Review the reservation deadline"],
        ],
      },
    },
    features: {
      eyebrow: "Tools for development sales",
      title: "What your team can do in the CRM.",
      items: [
        { title: "Manage developments and units", body: "Keep floor areas, prices and availability current. Track holds, reservations and sales for each unit." },
        { title: "Capture and route enquiries", body: "Capture enquiries from property microsites, forms and published funnels and connect them to your sales process." },
        { title: "Work with buyers", body: "Qualify contacts, assign tasks, record conversations and coordinate viewings." },
        { title: "Review development sales", body: "Bring together unit inventory, enquiry sources, offer status and confirmed unit sales in your project sales report." },
      ],
      cta: "Explore all features",
    },
    analytics: {
      eyebrow: "Property microsites and visitor analytics",
      title: "See how visitors use your property microsite.",
      description: "Publish property microsites in German, English and Spanish with selected photos, floor plans, documents and videos. Show current unit availability and approved prices. Share revocable links for a channel or an intended recipient. Enquiries submitted through the microsite arrive in the CRM.",
      imageAlt: "48 qualified visits, 39 browsers with consent, 2 minutes 41 seconds of active visible time and 64 percent of sections reached on average.",
      imageCaption: "German-language CRM view with fictional usage data.",
      measuresTitle: "What you can measure",
      measures: [
        "Qualified visits by link and browsers that gave consent",
        "Active visible time, sections reached and deepest scroll point per section",
        "Interactions with photos, floor plans, documents, videos and units",
        "Visit timelines with recorded interactions",
      ],
      contextTitle: "How the analytics work",
      context: [
        "Usage is recorded after consent. Visitors can enquire with or without analytics.",
        "Internal previews and recognised scanners are filtered out.",
        "A personal link is associated with its intended recipient and can be forwarded.",
      ],
    },
    audiences: {
      eyebrow: "For your sales team",
      title: "Built for developers. Ready for estate agency teams.",
      developers: { title: "For developers and project sales teams", body: "Manage new-build developments with unit inventory, buyer enquiries, reservations and reports for each project.", cta: "Explore CRM for developers" },
      brokers: { title: "For estate agency teams", body: "Organise seller and buyer enquiries, mandates, search profiles and suggested property matches.", cta: "Explore CRM for agents" },
    },
    faq: {
      eyebrow: "Frequently asked questions",
      title: "Demo, setup and access.",
      items: [
        { question: "What happens in the demo?", answer: "We walk you through an example development and discuss how units, enquiries and reservations could work together in your sales process." },
        { question: "How much does Novalure CRM cost?", answer: "You receive a proposal for the agreed scope. It covers setup, ongoing use and any additional services you choose." },
        { question: "How does my team get access?", answer: "After personal setup, we invite your team into a protected workspace. Roles and permissions determine what users can access." },
        { question: "Can I connect my existing systems?", answer: "Calendar and email features depend on the provider, connection and permissions. We discuss what your existing setup supports during the demo." },
        { question: "Can buyers enquire without analytics?", answer: "Yes. The enquiry form on a published property microsite works independently of analytics consent." },
      ],
    },
    finalCta: {
      title: "See your development sales in the CRM.",
      description: "We show you how a unit progresses from buyer enquiry to reservation and into the project sales report.",
    },
  },
  es: {
    nav: {
      developers: "Promotoras",
      brokers: "Agencias",
      features: "Funciones",
      login: "Acceso de equipo",
      demo: "Solicitar una demo",
      menuOpen: "Abrir menú",
      menuClose: "Cerrar menú",
    },
    hero: {
      eyebrow: "Para promotoras y equipos de venta de obra nueva",
      title: "El CRM para la",
      titleAccent: "venta de promociones.",
      description: "Gestiona promociones y unidades de obra nueva, registra consultas de compradores y sigue las visitas, las reservas y las ventas.",
      exampleCta: "Ver el proyecto de ejemplo",
      accessLine: "Configuración personalizada · Acceso protegido para tu equipo",
    },
    project: {
      eyebrow: "Del inventario al informe comercial",
      title: "Promoción Lindenblick",
      description: "Una promoción ficticia de obra nueva con 24 viviendas. Sigue la unidad A.12 para ver cómo se relacionan el inventario, las consultas y el estado comercial.",
      note: "Vista ilustrativa con datos ficticios.",
      inventoryTitle: "Resumen de unidades",
      inventoryLabels: ["Total", "Disponibles", "Reservadas", "Vendidas"],
      steps: [
        { title: "Registrar el inventario", body: "El equipo registra la promoción y sus unidades con superficies, precios y disponibilidad. La unidad A.12 está disponible al iniciar las ventas." },
        { title: "Vincular la consulta", body: "Una compradora pregunta por A.12 desde la ficha web publicada. El CRM vincula la consulta con el inmueble y la unidad." },
        { title: "Cualificar el interés", body: "El equipo registra el presupuesto, la financiación y los plazos. La persona responsable programa el siguiente paso." },
        { title: "Organizar una visita", body: "El equipo concierta una visita a A.12 y realiza el seguimiento de la cita en el CRM." },
        { title: "Reservar la unidad", body: "Tras la visita, el equipo comercial confirma la reserva. A.12 aparece como reservada en el inventario." },
        { title: "Revisar el avance de ventas", body: "El responsable del proyecto consulta el inventario, las ventas confirmadas, el origen de las consultas y el estado de las ofertas en el informe mensual." },
      ],
      card: {
        label: "Promoción ficticia",
        status: "Reservada",
        unit: "Unidad A.12 · 3 estancias",
        rows: [
          ["Origen de la consulta", "Ficha web"],
          ["Cualificación", "Presupuesto y plazos registrados"],
          ["Visita", "Realizada"],
          ["Siguiente paso", "Revisar el plazo de reserva"],
        ],
      },
    },
    features: {
      eyebrow: "Funciones para la venta de obra nueva",
      title: "Qué puede hacer tu equipo en el CRM.",
      items: [
        { title: "Gestionar promociones y unidades", body: "Mantén al día las superficies, los precios y la disponibilidad. Consulta las prerreservas, reservas y ventas de cada unidad." },
        { title: "Captar y asignar consultas", body: "Registra consultas desde fichas web, formularios y embudos publicados e incorpóralas al proceso comercial." },
        { title: "Atender a compradores", body: "Cualifica contactos, asigna tareas, documenta conversaciones y coordina las visitas." },
        { title: "Revisar las ventas de la promoción", body: "Reúne el inventario de unidades, el origen de las consultas, el estado de las ofertas y las ventas confirmadas en un informe por proyecto." },
      ],
      cta: "Ver todas las funciones",
    },
    analytics: {
      eyebrow: "Fichas web y estadísticas de uso",
      title: "Descubre cómo se consulta tu ficha web.",
      description: "Publica fichas web en alemán, inglés y español con fotos, planos, documentos y vídeos seleccionados. Muestra la disponibilidad actual y los precios autorizados de las unidades. Comparte enlaces revocables por canal o para un destinatario previsto. Las consultas enviadas desde la ficha llegan al CRM.",
      imageAlt: "48 visitas cualificadas, 39 navegadores con consentimiento, 2 minutos y 41 segundos de tiempo activo visible y un 64 por ciento de secciones alcanzadas de media.",
      imageCaption: "Vista del CRM en alemán con datos de uso ficticios.",
      measuresTitle: "Qué puedes medir",
      measures: [
        "Visitas cualificadas por enlace y navegadores con consentimiento",
        "Tiempo activo visible, secciones alcanzadas y profundidad máxima de desplazamiento por sección",
        "Interacciones con fotos, planos, documentos, vídeos y unidades",
        "Historial de visitas con las acciones registradas",
      ],
      contextTitle: "Cómo se generan las estadísticas",
      context: [
        "Los datos de uso se registran tras el consentimiento. Es posible enviar consultas sin activar las estadísticas.",
        "Se excluyen las vistas previas internas y los escáneres detectados.",
        "Un enlace personal indica a quién va dirigido y se puede reenviar.",
      ],
    },
    audiences: {
      eyebrow: "Para tu equipo comercial",
      title: "Pensado para promotoras y útil para agencias inmobiliarias.",
      developers: { title: "Para promotoras y equipos de venta", body: "Gestiona promociones de obra nueva con inventario de unidades, consultas de compradores, reservas e informes por proyecto.", cta: "Ver el CRM para promotoras" },
      brokers: { title: "Para agencias inmobiliarias", body: "Organiza consultas de propietarios y compradores, encargos, perfiles de búsqueda y sugerencias de inmuebles.", cta: "Ver el CRM para agencias" },
    },
    faq: {
      eyebrow: "Preguntas frecuentes",
      title: "Demo, configuración y acceso.",
      items: [
        { question: "¿Cómo es la demo?", answer: "Te mostramos el CRM con una promoción de ejemplo y hablamos de cómo relacionar unidades, consultas y reservas en tu proceso comercial." },
        { question: "¿Cuánto cuesta Novalure CRM?", answer: "Recibirás una propuesta para el alcance acordado que cubre la configuración, el uso continuado y los servicios adicionales que elijas." },
        { question: "¿Cómo accede mi equipo?", answer: "Tras la configuración personalizada, invitamos al equipo a un espacio de trabajo protegido. Los roles y permisos definen el acceso." },
        { question: "¿Puedo conectar mis sistemas actuales?", answer: "Las funciones de calendario y correo dependen del proveedor, la conexión y los permisos. En la demo revisamos qué admite tu configuración actual." },
        { question: "¿Es posible enviar consultas sin estadísticas?", answer: "Sí. El formulario de consulta de una ficha web publicada funciona independientemente del consentimiento para las estadísticas." },
      ],
    },
    finalCta: {
      title: "Ve cómo gestionar tu promoción en el CRM.",
      description: "Te mostramos el recorrido desde la consulta por una unidad hasta la reserva y el informe comercial.",
    },
  },
} as const satisfies Record<PublicLanguageCode, LandingV2Copy>;

export function getPublicCrmLandingV2Copy(language: PublicLanguageCode): LandingV2Copy {
  return copy[language];
}
