"use client";

import { useState } from "react";
import type { PreviewAction } from "../lib/types";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Icon,
  Input,
  LoadingState,
  Notice,
  PageHeading,
  Select,
  Textarea,
} from "./ui";

export function ComponentGallery({
  onPreviewAction,
}: {
  onPreviewAction: PreviewAction;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [state, setState] = useState("empty");
  const invalidEmail = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return (
    <>
      <PageHeading
        eyebrow="EVELYN DESIGN SYSTEM C"
        title="Eine gemeinsame Grundlage."
        description="Wiederverwendbare Bausteine für CRM, Studio, Immobilien und Kundenportal."
      />
      <div className="dc-stack">
        <Card title="Buttons & Status">
          <div className="dc-row dc-wrap">
            <Button onClick={() => onPreviewAction("Primäre Aktion")}>
              Primäre Aktion <Icon name="arrow" size={16} />
            </Button>
            <Button
              variant="secondary"
              onClick={() => onPreviewAction("Sekundäre Aktion")}
            >
              Sekundäre Aktion
            </Button>
            <Button
              variant="ghost"
              onClick={() => onPreviewAction("Weitere Aktion")}
            >
              Weitere Aktion
            </Button>
            <Button
              variant="danger"
              onClick={() => onPreviewAction("Bestätigungsdialog")}
            >
              Kritische Aktion
            </Button>
            <Button disabled>Nicht verfügbar</Button>
          </div>
          <div className="dc-row dc-wrap dc-gallery-badges">
            <Badge tone="success">Aktiv</Badge>
            <Badge tone="warning">In Bearbeitung</Badge>
            <Badge tone="danger">Fehler</Badge>
            <Badge tone="info">Information</Badge>
            <Badge tone="violet">Vorschau</Badge>
            <Badge>Inaktiv</Badge>
          </div>
        </Card>
        <div className="dc-grid dc-grid-2">
          <Card
            title="Einheitliche Formulare"
            eyebrow="LOKALES VALIDIERUNGSBEISPIEL"
          >
            <form
              className="dc-stack"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                setSubmitted(true);
                if (name.trim() && !invalidEmail)
                  onPreviewAction("Formular prüfen");
              }}
            >
              <Field
                htmlFor="gallery-name"
                label="Name"
                required
                error={
                  submitted && !name.trim()
                    ? "Bitte einen Namen eingeben."
                    : undefined
                }
                errorId="gallery-name-error"
              >
                <Input
                  id="gallery-name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-invalid={submitted && !name.trim()}
                  aria-describedby={
                    submitted && !name.trim() ? "gallery-name-error" : undefined
                  }
                  autoComplete="off"
                />
              </Field>
              <Field
                htmlFor="gallery-email"
                label="E-Mail"
                required
                error={
                  submitted && invalidEmail
                    ? "Bitte eine gültige E-Mail-Adresse eingeben."
                    : undefined
                }
                errorId="gallery-email-error"
              >
                <Input
                  type="email"
                  id="gallery-email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={submitted && invalidEmail}
                  aria-describedby={
                    submitted && invalidEmail
                      ? "gallery-email-error"
                      : undefined
                  }
                  autoComplete="off"
                />
              </Field>
              <Field htmlFor="gallery-module" label="Modul">
                <Select id="gallery-module">
                  <option>Webchat</option>
                  <option>Website</option>
                  <option>Immobilien</option>
                </Select>
              </Field>
              <Field
                htmlFor="gallery-note"
                label="Notiz"
                hint="Nur ein lokales Beispiel, keine Speicherung."
              >
                <Textarea id="gallery-note" rows={3} maxLength={500} />
              </Field>
              <Button type="submit">Beispiel prüfen</Button>
            </form>
          </Card>
          <Card title="Leere, Lade- und Fehlerzustände">
            <div className="dc-row dc-wrap">
              <Button variant="secondary" onClick={() => setState("empty")}>
                Leer
              </Button>
              <Button variant="secondary" onClick={() => setState("loading")}>
                Laden
              </Button>
              <Button variant="secondary" onClick={() => setState("error")}>
                Fehler
              </Button>
            </div>
            <div className="dc-gallery-state">
              {state === "empty" ? (
                <EmptyState title="Noch keine Dokumente">
                  Hier erscheinen später Ihre freigegebenen Dokumente.
                </EmptyState>
              ) : state === "loading" ? (
                <>
                  <LoadingState />
                  <p className="dc-muted">
                    Vorschau eines Ladezustands · keine Datenanfrage
                  </p>
                </>
              ) : (
                <Notice tone="danger">
                  <p>Beispielfehler: Daten konnten nicht geladen werden.</p>
                  <Button variant="secondary" onClick={() => setState("empty")}>
                    Beispiel zurücksetzen
                  </Button>
                </Notice>
              )}
            </div>
            <Notice tone="info">
              Status wird durch Text und Farbe vermittelt. Alle Bedienelemente
              sind über die Tastatur erreichbar.
            </Notice>
          </Card>
        </div>
        <Card title="Tabellen, Suche & Filter">
          <DataTable
            caption="Synthetische Beispielprojekte"
            columns={[
              { key: "name", label: "Projekt" },
              { key: "module", label: "Modul" },
              { key: "status", label: "Status" },
            ]}
            rows={Array.from({ length: 14 }, (_, index) => ({
              id: `gallery-${index}`,
              search: `Demoprojekt ${index + 1} ${index % 2 ? "Website" : "Webchat"}`,
              status: index % 2 ? "In Bearbeitung" : "Aktiv",
              cells: {
                name: `Demoprojekt ${String(index + 1).padStart(2, "0")}`,
                module: index % 2 ? "Website" : "Webchat",
                status: (
                  <Badge tone={index % 2 ? "warning" : "success"}>
                    {index % 2 ? "In Bearbeitung" : "Aktiv"}
                  </Badge>
                ),
              },
            }))}
          />
        </Card>
      </div>
    </>
  );
}
