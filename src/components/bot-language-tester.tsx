"use client";

import { useState } from "react";
import type { BotLanguageRule, Project } from "@/lib/crm-types";
import {
  getDashboardCopy,
  getLanguageLabel,
  supportedLanguages,
  type LanguageCode,
} from "@/lib/i18n";

type BotLanguageTesterProps = {
  language: LanguageCode;
  projects: Project[];
  rules: BotLanguageRule[];
};

export function BotLanguageTester({ language, projects, rules }: BotLanguageTesterProps) {
  const copy = getDashboardCopy(language);
  const [selectedRuleId, setSelectedRuleId] = useState(rules[0]?.id ?? "");
  const [customerLanguage, setCustomerLanguage] = useState<LanguageCode>(language);
  const [customerMessage, setCustomerMessage] = useState<string>(copy.bots.emptyMessage);

  const selectedRule = rules.find((rule) => rule.id === selectedRuleId) ?? rules[0];
  const responseLanguage =
    selectedRule?.mode === "fixed"
      ? selectedRule.fixedLanguage ?? selectedRule.fallbackLanguage
      : customerLanguage;
  const detectionConfidence = selectedRule
    ? Math.min(99, selectedRule.confidence + (customerMessage.trim().length > 28 ? 2 : 0))
    : 0;
  const previewText =
    responseLanguage === "de" ? copy.bots.germanReply : copy.bots.englishReply;
  const selectedProject = selectedRule?.projectId
    ? projects.find((project) => project.id === selectedRule.projectId)
    : undefined;

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
            {copy.navigation.bots}
          </p>
          <h3 className="mt-1 text-lg font-semibold">{copy.bots.testerTitle}</h3>
          <p className="mt-2 max-w-3xl break-words text-sm text-stone-600">
            {copy.bots.testerDescription}
          </p>
        </div>
        <span className="rounded-md bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-700">
          {selectedRule?.channel ?? "Bot"}
        </span>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <label className="grid gap-1 text-sm font-semibold text-slate-900">
          {copy.bots.ruleLabel}
          <select
            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-slate-800"
            onChange={(event) => setSelectedRuleId(event.target.value)}
            value={selectedRule?.id ?? ""}
          >
            {rules.map((rule) => {
              const project = rule.projectId
                ? projects.find((item) => item.id === rule.projectId)
                : undefined;

              return (
                <option key={rule.id} value={rule.id}>
                  {rule.channel} · {project?.name ?? copy.header.allProjects}
                </option>
              );
            })}
          </select>
        </label>

        <label className="grid gap-1 text-sm font-semibold text-slate-900">
          {copy.bots.customerLanguage}
          <select
            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-slate-800"
            onChange={(event) => setCustomerLanguage(event.target.value as LanguageCode)}
            value={customerLanguage}
          >
            {supportedLanguages.map((item) => (
              <option key={item.code} value={item.code}>
                {item.nativeName}
              </option>
            ))}
          </select>
        </label>

        <div className="rounded-md bg-stone-50 p-3 text-sm">
          <p className="font-semibold text-slate-900">
            {selectedProject?.name ?? copy.header.allProjects}
          </p>
          <p className="mt-1 text-stone-600">
            {selectedRule?.mode === "auto" ? copy.language.autoMode : copy.language.fixedMode}
          </p>
        </div>
      </div>

      <label className="mt-4 grid gap-1 text-sm font-semibold text-slate-900">
        {copy.bots.customerMessage}
        <textarea
          className="min-h-24 resize-y rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-normal text-slate-800"
          onChange={(event) => setCustomerMessage(event.target.value)}
          value={customerMessage}
        />
      </label>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-900">
          <p className="font-semibold">{copy.bots.detectedLanguage}</p>
          <p className="mt-1">{getLanguageLabel(customerLanguage)}</p>
        </div>
        <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
          <p className="font-semibold">{copy.bots.responseLanguage}</p>
          <p className="mt-1">{getLanguageLabel(responseLanguage)}</p>
        </div>
        <div className="rounded-md bg-violet-50 p-3 text-sm text-violet-900">
          <p className="font-semibold">{copy.bots.confidence}</p>
          <p className="mt-1">{detectionConfidence}%</p>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
        <p className="text-sm font-semibold text-slate-900">{copy.bots.answerPreview}</p>
        <p className="mt-2 break-words text-sm text-stone-700">{previewText}</p>
        {selectedRule ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {selectedRule.detectionSignals.map((signal) => (
              <span
                className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-600"
                key={signal}
              >
                {signal}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
