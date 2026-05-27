import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function readProjectFile(path) {
  return readFileSync(join(rootDir, path), "utf8");
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return null;
}

function objectProperty(objectLiteral, key) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyName(property.name) === key) {
      return unwrapExpression(property.initializer);
    }
  }

  return null;
}

function collectLeafKeys(objectLiteral, prefix = []) {
  const keys = [];

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;

    const key = propertyName(property.name);
    if (!key) continue;

    const nextPrefix = [...prefix, key];
    const initializer = unwrapExpression(property.initializer);
    if (ts.isObjectLiteralExpression(initializer)) {
      keys.push(...collectLeafKeys(initializer, nextPrefix));
    } else {
      keys.push(nextPrefix.join("."));
    }
  }

  return keys.sort();
}

function collectTextFragments(node, prefix = []) {
  const expression = unwrapExpression(node);

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [{ path: prefix.join("."), text: expression.text }];
  }

  if (ts.isTemplateExpression(expression)) {
    return [
      {
        path: prefix.join("."),
        text: [
          expression.head.text,
          ...expression.templateSpans.map((span) => span.literal.text),
        ]
          .filter(Boolean)
          .join(" "),
      },
    ];
  }

  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element, index) =>
      collectTextFragments(element, [...prefix, `[${index}]`]),
    );
  }

  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property)) return [];
      const key = propertyName(property.name);
      if (!key) return [];

      return collectTextFragments(property.initializer, [...prefix, key]);
    });
  }

  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return collectTextFragments(expression.body, [...prefix, "<function>"]);
  }

  const fragments = [];
  ts.forEachChild(expression, (child) => {
    fragments.push(...collectTextFragments(child, prefix));
  });

  return fragments;
}

function localizedExports(sourceText) {
  const sourceFile = ts.createSourceFile("i18n.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exports = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;

      const initializer = unwrapExpression(declaration.initializer);
      if (!ts.isObjectLiteralExpression(initializer)) continue;

      const en = objectProperty(initializer, "en");
      const de = objectProperty(initializer, "de");
      if (en && de && ts.isObjectLiteralExpression(en) && ts.isObjectLiteralExpression(de)) {
        exports.push({ name: declaration.name.text, en, de });
      }
    }
  }

  return exports;
}

const i18nSource = readProjectFile("src/lib/i18n.ts");
const leadInboxSource = readProjectFile("src/components/lead-inbox.tsx");
const dashboardSource = readProjectFile("src/components/dashboard-overview.tsx");
const workspaceSource = readProjectFile("src/components/crm-workspace.tsx");
const layoutSource = readProjectFile("src/app/layout.tsx");
const htmlSyncSource = readProjectFile("src/components/language-html-sync.tsx");

test("localized i18n exports keep matching de/en key structure", () => {
  for (const localizedExport of localizedExports(i18nSource)) {
    const enKeys = new Set(collectLeafKeys(localizedExport.en));
    const deKeys = new Set(collectLeafKeys(localizedExport.de));
    const missingInGerman = [...enKeys].filter((key) => !deKeys.has(key));
    const missingInEnglish = [...deKeys].filter((key) => !enKeys.has(key));

    assert.deepEqual(missingInGerman, [], `${localizedExport.name}: German copy misses keys`);
    assert.deepEqual(missingInEnglish, [], `${localizedExport.name}: English copy misses keys`);
  }
});

test("confirmed German lead inbox copy regressions stay fixed", () => {
  for (const forbidden of [
    "Ohne Owner",
    "Bulk-Follow-up",
    "Kein Owner",
    "Owner informieren",
    "Kunden-Owner",
    "Kontakt-Owner",
    "Projekt-Owner",
    "Fester Owner",
    "Manueller Owner",
    "Owner-Lücken",
    "Owner-Routing",
    "Deal-Owner",
    "Owner-Eskalation",
  ]) {
    assert.equal(i18nSource.includes(forbidden), false, `Forbidden German UI copy remains: ${forbidden}`);
  }

  assert.match(i18nSource, /unassignedView:\s*"Ohne Zuständigen"/);
  assert.match(i18nSource, /bulkFollowUp:\s*"Sammel-Follow-up"/);
  assert.match(i18nSource, /bulkFollowUpEmpty:\s*"Kein Lead für Sammel-Follow-up verfügbar\."/);
  assert.match(i18nSource, /buyer:\s*"Käufer"/);
});

test("German localized copy does not keep known English role or type remnants", () => {
  const findings = [];
  const forbiddenTerms = ["Owner", "Buyer", "Bulk-Follow-up"];

  for (const localizedExport of localizedExports(i18nSource)) {
    for (const fragment of collectTextFragments(localizedExport.de, [localizedExport.name, "de"])) {
      if (fragment.path.includes(".geminiPrompt")) continue;

      for (const forbiddenTerm of forbiddenTerms) {
        if (fragment.text.includes(forbiddenTerm)) {
          findings.push(`${fragment.path}: ${forbiddenTerm} in "${fragment.text}"`);
        }
      }
    }
  }

  assert.deepEqual(findings, [], "German visible i18n copy still contains English remnants");
});

test("critical CRM enum surfaces use localized labels instead of raw values", () => {
  assert.match(i18nSource, /export function getCrmLeadTypeKey/);
  assert.match(i18nSource, /export function getCrmSourceKey/);
  assert.match(i18nSource, /export function getCrmStatusKey/);
  assert.match(leadInboxSource, /getCrmLeadTypeLabel\(item\.lead\.type, language\)/);
  assert.match(leadInboxSource, /getCrmSourceLabel\(item\.lead\.source, language\)/);
  assert.match(dashboardSource, /getCrmLeadTypeLabel\(type, language\)/);
  assert.match(dashboardSource, /getCrmSourceLabel\(source, language\)/);
  assert.match(workspaceSource, /getCrmLeadTypeKey\(lead\.type\)/);
});

test("system language persists to document html lang", () => {
  assert.match(layoutSource, /<html lang="de"/);
  assert.match(layoutSource, /<LanguageHtmlSync \/>/);
  assert.match(htmlSyncSource, /languageStorageKeys\.system/);
  assert.match(htmlSyncSource, /document\.documentElement\.lang = language/);
  assert.match(workspaceSource, /window\.localStorage\.setItem\(languageStorageKeys\.system, language\)/);
  assert.match(workspaceSource, /document\.documentElement\.lang = language/);
});
