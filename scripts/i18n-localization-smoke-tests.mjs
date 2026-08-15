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
const botSource = readProjectFile("src/components/bot-command-center.tsx");
const calendarCommandCenterSource = readProjectFile("src/components/calendar-command-center.tsx");
const contactCommandCenterSource = readProjectFile("src/components/contact-command-center.tsx");
const dailyQueueBoardSource = readProjectFile("src/components/daily-queue-board.tsx");
const dashboardSource = readProjectFile("src/components/dashboard-overview.tsx");
const dealPipelineSource = readProjectFile("src/components/deal-pipeline-workspace.tsx");
const formCommandCenterSource = readProjectFile("src/components/form-command-center.tsx");
const funnelCommandCenterSource = readProjectFile("src/components/funnel-command-center.tsx");
const leadSequenceCommandCenterSource = readProjectFile("src/components/lead-sequence-command-center.tsx");
const mobileDailyWorkSource = readProjectFile("src/components/mobile-daily-work.tsx");
const propertyCommandCenterSource = readProjectFile("src/components/property-command-center.tsx");
const taskCommandCenterSource = readProjectFile("src/components/task-command-center.tsx");
const unitBoardSource = readProjectFile("src/components/unit-board.tsx");
const workspaceSource = readProjectFile("src/components/crm-workspace.tsx");
const reservationBoardSource = readProjectFile("src/components/reservation-board.tsx");
const layoutSource = readProjectFile("src/app/layout.tsx");
const globalsSource = readProjectFile("src/app/globals.css");
const htmlSyncSource = readProjectFile("src/components/language-html-sync.tsx");
const languageRuntimeSource = readProjectFile("src/lib/language-runtime.ts");
const proxySource = readProjectFile("src/proxy.ts");
const bookingPageSource = readProjectFile("src/app/book/[slug]/page.tsx");
const chatRuntimeSource = readProjectFile("src/lib/bots/chat-runtime.ts");
const crmLoadersSource = readProjectFile("src/lib/db/crm-loaders.ts");
const modelProviderSource = readProjectFile("src/lib/integrations/model-provider.ts");
const pipelineDefaultsSource = readProjectFile("src/lib/db/pipeline-default-repositories.ts");
const propertyDepartmentSource = readProjectFile("src/lib/property-department.ts");
const propertyDepartmentRepositoriesSource = readProjectFile("src/lib/db/property-department-repositories.ts");
const recommendationRuntimeSource = readProjectFile("src/lib/db/recommendation-runtime-repositories.ts");

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
  assert.match(i18nSource, /export function getCrmEnumLabel/);
  assert.match(i18nSource, /export function getCrmDealStageLabel/);
  assert.match(i18nSource, /export function getCrmPropertyTypeLabel/);
  assert.match(i18nSource, /export function getCrmFinancingStatusLabel/);
  assert.match(i18nSource, /export function getCrmConsentChannelLabel/);
  assert.match(i18nSource, /export function getCrmConsentStatusLabel/);
  assert.match(i18nSource, /Schedule appointment/);
  assert.match(i18nSource, /Closing review/);
  assert.match(i18nSource, /Disqualified/);
  assert.match(i18nSource, /Suggest appointment/);
  assert.match(leadInboxSource, /getCrmLeadTypeLabel\(item\.lead\.type, language\)/);
  assert.match(leadInboxSource, /getCrmSourceLabel\(item\.lead\.source, language\)/);
  assert.match(leadInboxSource, /getCrmPropertyTypeLabel\(propertyType, language\)/);
  assert.match(leadInboxSource, /getCrmFinancingStatusLabel\(status, language\)/);
  assert.match(botSource, /getBotVisibleStatusLabel\(conversation\.status, text, language\)/);
  assert.match(botSource, /getBotVisibleStatusLabel\(event\.status, text, language\)/);
  assert.match(botSource, /getBotVisibleStatusLabel\(documentSend\.status, text, language\)/);
  assert.match(calendarCommandCenterSource, /getCrmEnumLabel\(booking\.source, language\)/);
  assert.match(contactCommandCenterSource, /getCrmConsentChannelLabel\(consent\.channel, language\)/);
  assert.match(contactCommandCenterSource, /getCrmConsentStatusLabel\(consent\.status, language\)/);
  assert.match(dashboardSource, /getCrmLeadTypeLabel\(type, language\)/);
  assert.match(dashboardSource, /getCrmSourceLabel\(source, language\)/);
  assert.match(dealPipelineSource, /getCrmDealStageLabel/);
  assert.match(dealPipelineSource, /stageLabel\(stage\)/);
  assert.match(dealPipelineSource, /text\.nextStageHint\(stageLabel\(nextStage\)\)/);
  assert.match(dealPipelineSource, /leadTypeLabel\(item\.leadType\)/);
  assert.match(dealPipelineSource, /getCrmSystemTextLabel\(item\.deal\.nextAction, language\)/);
  assert.match(formCommandCenterSource, /copy\.builder\.statusOptions\[form\.status\]/);
  assert.match(formCommandCenterSource, /copy\.fieldTypes\[field\.type\]/);
  assert.match(funnelCommandCenterSource, /text\.messages\.statusTriggerStages/);
  assert.match(funnelCommandCenterSource, /getCrmEnumLabel\(item\.status, language\)/);
  assert.match(workspaceSource, /getCrmConsentChannelLabel\(consent\.channel, language\)/);
  assert.match(workspaceSource, /getCrmEnumLabel\(dataSource, language\)/);
  assert.match(workspaceSource, /getCrmLeadTypeKey\(lead\.type\)/);
  assert.match(workspaceSource, /getCrmSourceLabel\(source, language\)/);
});

test("system generated CRM default texts localize at display boundaries only", () => {
  assert.match(i18nSource, /const crmSystemTextLabels: Record<string, Record<LanguageCode, string>>/);
  assert.match(i18nSource, /export function getCrmSystemTextLabel/);
  assert.match(i18nSource, /"Verkaufsabsicht in 3 Monaten":\s*\{\s*en:\s*"Selling intent within 3 months"/);
  assert.match(i18nSource, /"Rückruf heute":\s*\{\s*en:\s*"Callback today"/);
  assert.match(i18nSource, /"Termin vorschlagen":\s*\{\s*en:\s*"Suggest appointment"/);
  assert.match(i18nSource, /return crmSystemTextLabels\[trimmedValue\]\?\.\[language\] \?\? value/);

  assert.match(leadInboxSource, /leadIntentLabel = getCrmSystemTextLabel\(lead\.intent, language\)/);
  assert.match(leadInboxSource, /leadNextActionLabel = getCrmSystemTextLabel\(lead\.nextAction, language\)/);
  assert.match(leadInboxSource, /item\.leadIntentLabel/);
  assert.match(leadInboxSource, /item\.leadNextActionLabel/);
  assert.match(leadInboxSource, /value=\{activeFieldDraft\.nextAction\}/);
  assert.match(leadInboxSource, /taskTitle:\s*item\.lead\.nextAction \|\| item\.lead\.intent/);

  for (const [name, source, patterns] of [
    ["daily queue", dailyQueueBoardSource, [/getCrmSystemTextLabel\(lead\.intent, language\)/, /getCrmSystemTextLabel\(lead\.nextAction, language\)/]],
    ["dashboard", dashboardSource, [/getCrmSystemTextLabel\(lead\.intent, language\)/, /getCrmSystemTextLabel\(lead\.nextAction, language\)/]],
    ["workspace", workspaceSource, [/getCrmSystemTextLabel\(lead\.nextAction, language\)/]],
    ["funnel", funnelCommandCenterSource, [/getCrmSystemTextLabel\(lead\.intent, language\)/, /getCrmSystemTextLabel\(lead\.nextAction, language\)/]],
    ["contact", contactCommandCenterSource, [/getCrmSystemTextLabel\(selectedLead\.nextAction, language\)/]],
    ["property", propertyCommandCenterSource, [/getCrmSystemTextLabel\(lead\.intent, language\)/, /getCrmSystemTextLabel\(lead\.nextAction \|\| lead\.intent, language\)/]],
    ["mobile daily", mobileDailyWorkSource, [/getCrmSystemTextLabel\(lead\.intent, language\)/]],
    ["task center", taskCommandCenterSource, [/getCrmSystemTextLabel\(lead\.intent, language\)/]],
    ["calendar", calendarCommandCenterSource, [/getCrmSystemTextLabel\(lead\.intent, language\)/]],
    ["lead sequence", leadSequenceCommandCenterSource, [/getCrmSystemTextLabel\(selectedLead\.nextAction, language\)/]],
    ["unit board", unitBoardSource, [/getCrmSystemTextLabel\(match\.lead\.intent, language\)/]],
    ["deal pipeline", dealPipelineSource, [/getCrmSystemTextLabel\(item\.deal\.nextAction, language\)/]],
  ]) {
    for (const pattern of patterns) {
      assert.match(source, pattern, `${name} should localize known system CRM text at display time`);
    }
  }

  assert.match(i18nSource, /microsoft:\s*"Create Teams link automatically"/);
  assert.match(i18nSource, /google:\s*"Create Google Meet link automatically"/);
  assert.match(i18nSource, /microsoft:\s*"Automatisch Teams-Link erstellen"/);
});

test("system language persists to document html lang", () => {
  assert.match(languageRuntimeSource, /languageCookieName = "novalure\.system-language"/);
  assert.match(languageRuntimeSource, /languageRequestHeaderName = "x-novalure-language"/);
  assert.match(proxySource, /export function proxy\(request: NextRequest\)/);
  assert.match(proxySource, /requestHeaders\.set\(languageRequestHeaderName, language\)/);
  assert.match(proxySource, /response\.cookies\.set\(languageCookieName, requestedLanguage/);
  assert.match(layoutSource, /headers\(\)/);
  assert.match(layoutSource, /cookies\(\)/);
  assert.match(layoutSource, /<html lang=\{language\}/);
  assert.match(layoutSource, /<LanguageHtmlSync \/>/);
  assert.match(htmlSyncSource, /languageStorageKeys\.system/);
  assert.match(htmlSyncSource, /document\.documentElement\.lang = language/);
  assert.match(htmlSyncSource, /document\.cookie = `\$\{languageCookieName\}=\$\{language\}/);
  assert.match(workspaceSource, /window\.localStorage\.setItem\(languageStorageKeys\.system, language\)/);
  assert.match(workspaceSource, /document\.documentElement\.lang = language/);
});

test("phase 2 dashboard KPI labels stay explicit and localized", () => {
  assert.match(i18nSource, /browserTitle:\s*"Novalure CRM \| Private Lead Workspace for Real Estate Teams"/);
  assert.match(i18nSource, /browserTitle:\s*"Novalure CRM \| Privater Lead-Workspace für Immobilien-Teams"/);
  assert.match(i18nSource, /pipeline:\s*"Weighted forecast - open deals"/);
  assert.match(i18nSource, /pipeline:\s*"Gewichteter Forecast - offene Deals"/);
  assert.match(i18nSource, /hotLeads:\s*"Hot leads \(all\)"/);
  assert.match(i18nSource, /hotLeads:\s*"Heiße Leads gesamt"/);
  assert.match(i18nSource, /activeLeads:\s*"Active leads \(this month\)"/);
  assert.match(i18nSource, /activeLeads:\s*"Aktive Leads \(dieser Monat\)"/);
  assert.match(i18nSource, /pipelineValue:\s*\{\s*title:\s*"Expected commission \(3%\)"/);
  assert.match(i18nSource, /pipelineValue:\s*\{\s*title:\s*"Erwartete Provision \(3%\)"/);
  assert.match(i18nSource, /commission 3%/);
  assert.match(i18nSource, /Provision 3%/);
  assert.doesNotMatch(i18nSource, /Hot leads \(no time filter\)|Heiße Leads \(ohne Zeitfilter\)|Active leads \(dashboard filter\)|Aktive Leads \(Dashboard-Filter\)|Weighted forecast \(open deals\)|Gewichteter Forecast \(offene Deals\)|commission rate 3%|Provisionssatz 3%/);
  assert.match(workspaceSource, /hotLeads:\s*"Hot leads \(all\)"/);
  assert.match(workspaceSource, /pipeline:\s*"Weighted forecast - open deals"/);
  assert.doesNotMatch(workspaceSource, /All visible leads, no time filter\.|Weighted value of open deals\./);
  assert.match(i18nSource, /noSourceData:\s*"No lead source data in this view\."/);
  assert.match(i18nSource, /noSourceData:\s*"Keine Leadquellen-Daten in dieser Ansicht\."/);
  assert.match(dashboardSource, /copy\.kpis\.expectedCommission\(forecastOpenDeals\.length, formatEuro\(forecastOpenPipelineValue, locale\), formatEuro\(forecastWeightedPipelineValue, locale\)\)/);
  assert.match(dashboardSource, /copy\.charts\.noSourceData/);
  assert.match(workspaceSource, /document\.title = copy\.shell\.browserTitle/);
});

test("phase 2 German copy uses correct umlauts and formal login wording", () => {
  assert.match(i18nSource, /passcodeHelp:\s*"Verwenden Sie den Zugangscode Ihres freigegebenen Workspace\."/);
  assert.match(i18nSource, /passwordHelp:\s*"Verwenden Sie mindestens 15 Zeichen\."/);
  assert.match(i18nSource, /loginSuccess:\s*"Ihr Passwort wurde aktualisiert\. Melden Sie sich mit dem neuen Passwort an\."/);
  assert.match(i18nSource, /rate_limited:\s*"Zu viele Reset-Anfragen\. Bitte warten Sie einige Minuten und versuchen Sie es erneut\."/);
  assert.match(i18nSource, /meetingOutbox:\s*"Terminvorschläge"/);
  assert.match(i18nSource, /noMeetingActions:\s*"Keine wartenden Terminvorschläge\."/);
  assert.match(dailyQueueBoardSource, /Fällige Rückrufe/);
  assert.match(dailyQueueBoardSource, /heißen Leads, fälligen Rückrufen/);
  assert.match(dailyQueueBoardSource, /Überfällige Aufgaben/);
  assert.match(crmLoadersSource, /Keine heißen Leads - Lead-Zentrale prüfen\./);
  assert.match(crmLoadersSource, /Keine überfälligen Angebote\./);
  assert.match(chatRuntimeSource, /Terminvorschläge nach Regeln vorbereitet/);
  assert.match(bookingPageSource, /vollständigen Buchungslink/);
  assert.match(modelProviderSource, /Für Details oder unklare Punkte bereite ich die Übergabe an das Team vor\./);
  assert.match(pipelineDefaultsSource, /Verkäufer-Pipeline/);
  assert.match(propertyDepartmentSource, /Kostenübersicht/);
  assert.match(propertyDepartmentSource, /Rücklage/);
  assert.match(propertyDepartmentSource, /Vergebührung/);
  assert.match(propertyDepartmentRepositoriesSource, /Default-Unit für Listing-only-Objekt/);
  assert.match(recommendationRuntimeSource, /Baukörper A/);
  assert.match(recommendationRuntimeSource, /Optionsfrist prüfen/);
  assert.match(recommendationRuntimeSource, /regelmäßig wiederholen/);
  assert.match(recommendationRuntimeSource, /Score-Lücken prüfen/);
  assert.match(reservationBoardSource, /Läuft bald ab/);
  assert.match(reservationBoardSource, /Heute fällig/);

  const forbiddenVisibleAscii = [
    "Terminvorschlaege",
    "vollstaendigen Buchungslink",
    "Verwende mindestens 15 Zeichen",
    "Bitte warte einige Minuten",
    "deines freigegebenen Workspace",
    "dein neues Passwort",
    "deinen Novalure CRM-Zugang",
    "heisse",
    "heissen",
    "faellige",
    "ueberfaellige",
    "Ueberfaellige",
    "Prioritaet",
    "Baukoerper",
    "Kostenuebersicht",
    "Ruecklage",
    "Vergebuehrung",
    "Vermarktung pruefen",
    "Verkaeufer-Pipeline",
    "Default-Unit fuer",
    "Frist ueberzogen",
    "Laeuft bald ab",
    "Heute faellig",
    "regelmaessig",
    "Regelmaessige",
    "Faelle",
    "Uebergabe",
    "Gespraech",
    "ergaenzen",
    "ergaenzt",
    "befuellen",
    "Ausfuehrung",
    "Sequenzlaeufe",
    "Score-Luecken",
  ];
  const checkedSources = [
    ["booking page", bookingPageSource],
    ["chat runtime", chatRuntimeSource],
    ["CRM loaders", crmLoadersSource],
    ["daily queue", dailyQueueBoardSource],
    ["i18n", i18nSource],
    ["model provider", modelProviderSource],
    ["pipeline defaults", pipelineDefaultsSource],
    ["property department", propertyDepartmentSource],
    ["property department repositories", propertyDepartmentRepositoriesSource],
    ["recommendation runtime", recommendationRuntimeSource],
    ["reservation board", reservationBoardSource],
  ];

  for (const [sourceName, source] of checkedSources) {
    for (const forbidden of forbiddenVisibleAscii) {
      assert.equal(source.includes(forbidden), false, `${sourceName} still contains old German copy: ${forbidden}`);
    }
  }
});

test("phase 4 KPI labels avoid forced mid-word breaks", () => {
  assert.match(globalsSource, /\.crm-kpi-label\s*\{/);
  assert.match(globalsSource, /overflow-wrap:\s*normal/);
  assert.match(globalsSource, /word-break:\s*normal/);
  assert.match(dashboardSource, /crm-kpi-label/);
  assert.match(workspaceSource, /crm-kpi-label/);
  assert.match(leadInboxSource, /crm-kpi-label text-xs text-stone-500">\{metric\.label\}/);
  assert.match(contactCommandCenterSource, /crm-kpi-label text-xs text-stone-500">\{copy\.organizations\}/);
  assert.match(propertyCommandCenterSource, /w-full min-w-\[1080px\] table-fixed/);
  assert.match(propertyCommandCenterSource, /<colgroup>/);
  assert.match(propertyCommandCenterSource, /flex min-w-\[220px\] flex-wrap gap-1\.5/);
  assert.match(propertyCommandCenterSource, /lg:grid-cols-3 2xl:grid-cols-6/);
  assert.match(unitBoardSource, /lg:grid-cols-3 2xl:grid-cols-7/);
  assert.match(unitBoardSource, /lg:grid-cols-3 2xl:grid-cols-6/);
  assert.match(unitBoardSource, /crm-kpi-label text-xs font-semibold uppercase leading-4 text-stone-500/);
  assert.match(calendarCommandCenterSource, /grid min-w-0 grid-cols-2 gap-2 text-sm sm:min-w-\[520px\] md:grid-cols-4 xl:min-w-\[620px\]/);
  assert.match(calendarCommandCenterSource, /crm-kpi-label text-xs leading-4 text-stone-500/);
});
