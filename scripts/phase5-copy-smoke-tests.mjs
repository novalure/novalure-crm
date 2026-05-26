import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

test("user-facing copy no longer exposes local-session prototype wording", () => {
  const i18n = readText("src/lib/i18n.ts");
  const forbidden = [
    "Local actions",
    "Task created in this session",
    "Sequence draft saved locally",
    "for this session",
    "Local preview",
    "Local meeting settings loaded",
    "Saved locally",
    "Lokale Aktionen",
    "in dieser Sitzung",
    "lokal in diesem Workspace",
    "Lokale Vorschau",
    "Lokale Meeting-Einstellungen",
    "Lokal gespeichert",
    "Verbleibende lokale",
    "lokaler Bearbeitung",
  ];

  for (const phrase of forbidden) {
    assert.ok(!i18n.includes(phrase), `Unexpected prototype wording: ${phrase}`);
  }
});

test("replacement copy uses production-safe draft and inline wording", () => {
  const i18n = readText("src/lib/i18n.ts");

  assert.match(i18n, /Recent actions/);
  assert.match(i18n, /Task created"/);
  assert.match(i18n, /Sequence draft saved in this workspace/);
  assert.match(i18n, /Draft preview/);
  assert.match(i18n, /Meeting draft loaded/);
  assert.match(i18n, /Inline-Bearbeitung/);
  assert.match(i18n, /Aktuelle Aktionen/);
  assert.match(i18n, /Aufgabe wurde angelegt/);
  assert.match(i18n, /Sequenzentwurf wurde in diesem Workspace gespeichert/);
  assert.match(i18n, /Entwurfsvorschau/);
  assert.match(i18n, /Meeting-Entwurf geladen/);
});

test("login placeholders use a real product domain instead of a local demo address", () => {
  const i18n = readText("src/lib/i18n.ts");

  assert.doesNotMatch(i18n, /placeholderEmail: "franz@novalure\.local"/);
  assert.match(i18n, /placeholderEmail: "franz@novalure\.eu"/);
});
