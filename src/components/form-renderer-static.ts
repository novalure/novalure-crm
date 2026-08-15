import {
  fieldBelongsToStep,
  getFieldDefaultValue,
  getFieldName,
  normalizeFormSteps,
  type FormRuntimeCopy,
} from "@/components/form-renderer";
import type { FormField, WebsiteForm } from "@/lib/form-types";

export function renderStaticFormHtml({
  action,
  copy,
  form,
  publicKey,
  returnTo,
  source,
}: {
  action: string;
  copy: FormRuntimeCopy;
  form: WebsiteForm;
  publicKey: string;
  returnTo: string;
  source: string;
}) {
  const steps = normalizeFormSteps(form);
  const progress = steps.length > 1 ? Math.round((1 / steps.length) * 100) : 100;
  const hiddenFields = form.fields.filter((field) => field.type === "hidden");
  const visibleFields = steps
    .map((step, stepIndex) => {
      const isActive = stepIndex === 0;
      const stepFields = form.fields
        .filter((field) => fieldBelongsToStep(field, step, stepIndex))
        .map((field) => renderStaticField(field, copy))
        .join("");
      const stepIntro = steps.length > 1
        ? `<div><p class="novalure-step-title">${escapeHtml(step.title)}</p>${step.description ? `<p class="novalure-description">${escapeHtml(step.description)}</p>` : ""}</div>`
        : "";

      return `<section class="novalure-step${isActive ? "" : " novalure-hidden"}" data-step-index="${stepIndex}"${isActive ? "" : " hidden"}>${stepIntro}${stepFields}</section>`;
    })
    .join("");
  const progressHtml = steps.length > 1 && form.progressMode !== "none"
    ? `<div class="novalure-progress"><span>${form.progressMode === "percent" ? `${progress}%` : `${escapeHtml(copy.step)} 1 / ${steps.length}`}</span><span class="novalure-progress-track"><span class="novalure-progress-value" style="width:${progress}%"></span></span></div>`
    : "";
  const previousButton = steps.length > 1
    ? `<button class="novalure-button novalure-secondary" data-action="previous" disabled type="button">${escapeHtml(copy.back)}</button>`
    : "<span></span>";
  const nextOrSubmit = steps.length > 1
    ? `<button class="novalure-button" data-action="next" type="button">${escapeHtml(copy.next)}</button>`
    : `<button class="novalure-button" type="submit">${escapeHtml(copy.submit)}</button>`;

  return `<form action="${escapeHtml(action)}" class="novalure-runtime" data-novalure-runtime="form" enctype="multipart/form-data" method="post" novalidate>
<input name="form_id" type="hidden" value="${escapeHtml(publicKey)}">
<input name="form_slug" type="hidden" value="${escapeHtml(publicKey)}">
<input name="return_to" type="hidden" value="${escapeHtml(returnTo)}">
<input name="utm_source" type="hidden" value="${escapeHtml(source)}">
<input name="utm_campaign" type="hidden" value="${escapeHtml(form.campaign)}">
<input name="form_variant" type="hidden" value="${escapeHtml(form.variant)}">
<input name="funnel_id" type="hidden" value="${escapeHtml(form.funnelId)}">
<input name="page_url" type="hidden" value="">
<input name="referrer" type="hidden" value="">
${hiddenFields.map((field) => `<input data-field-id="${escapeHtml(field.id)}" name="${escapeHtml(getFieldName(field))}" type="hidden" value="${escapeHtml(getFieldDefaultValue(field))}">`).join("")}
<div class="novalure-card">
<p class="novalure-eyebrow">Novalure</p>
<h2 class="novalure-title">${escapeHtml(form.name)}</h2>
${form.actions.thankYouMessage ? `<p class="novalure-description">${escapeHtml(form.actions.thankYouMessage)}</p>` : ""}
${progressHtml}
${visibleFields}
<div class="novalure-actions">${previousButton}${nextOrSubmit}</div>
</div>
</form>`;
}

function renderStaticField(field: FormField, copy: FormRuntimeCopy) {
  if (field.type === "hidden") return "";

  const name = getFieldName(field);
  const describedBy = field.helpText ? `${field.id}_help` : "";
  const conditionAttrs = `${field.conditionalFieldId ? ` data-condition-field="${escapeHtml(field.conditionalFieldId)}"` : ""}${field.conditionalValue ? ` data-condition-value="${escapeHtml(field.conditionalValue)}"` : ""}`;
  const label = `<span class="novalure-label-row"><span>${escapeHtml(field.label)}${field.required ? "*" : ""}</span>${field.required ? `<span class="novalure-required">${escapeHtml(copy.required)}</span>` : ""}</span>`;
  const help = field.helpText ? `<span class="novalure-help" id="${escapeHtml(describedBy)}">${escapeHtml(field.helpText)}</span>` : "";
  const control = renderStaticControl(field, name, describedBy);

  return `<label class="novalure-field" data-field-id="${escapeHtml(field.id)}" data-field-type="${escapeHtml(field.type)}"${conditionAttrs}>${label}${control}${help}</label>`;
}

function renderStaticControl(field: FormField, name: string, describedBy: string) {
  const describedByAttr = describedBy ? ` aria-describedby="${escapeHtml(describedBy)}"` : "";
  const required = field.required ? " required" : "";
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : "";
  const defaultValue = getFieldDefaultValue(field);
  const baseAttrs = `class="novalure-control" name="${escapeHtml(name)}"${describedByAttr}${placeholder}${required}`;

  if (field.type === "textarea") {
    const textareaAttrs = baseAttrs.replace('class="novalure-control"', 'class="novalure-control novalure-textarea"');
    return `<textarea ${textareaAttrs}>${escapeHtml(defaultValue)}</textarea>`;
  }

  if (field.type === "select") {
    const options = [`<option value="">${escapeHtml(field.placeholder || "-")}</option>`]
      .concat(field.options.map((option) => `<option value="${escapeHtml(option)}"${defaultValue === option ? " selected" : ""}>${escapeHtml(option)}</option>`))
      .join("");
    return `<select ${baseAttrs}>${options}</select>`;
  }

  if (field.type === "radio" || field.type === "multiCheckbox" || field.type === "rating") {
    const options = field.type === "rating" ? ["1", "2", "3", "4", "5"] : field.options;
    const defaultValues = defaultValue.split(",").map((item) => item.trim()).filter(Boolean);
    return `<span class="novalure-choice-list">${options.map((option, index) => `<span class="novalure-choice"><input${describedByAttr}${defaultValues.includes(option) ? " checked" : ""} name="${escapeHtml(name)}"${field.required && index === 0 && field.type !== "multiCheckbox" ? " required" : ""} type="${field.type === "multiCheckbox" ? "checkbox" : "radio"}" value="${escapeHtml(option)}"><span>${escapeHtml(field.type === "rating" ? `${option} / 5` : option)}</span></span>`).join("")}</span>`;
  }

  if (field.type === "checkbox" || field.type === "consent") {
    return `<span class="novalure-choice"><input${describedByAttr}${field.defaultValue ? " checked" : ""} name="${escapeHtml(name)}"${required} type="checkbox" value="1"><span>${escapeHtml(field.helpText || field.label)}</span></span>`;
  }

  if (field.type === "file") {
    return `<input ${baseAttrs}${field.fileAccept ? ` accept="${escapeHtml(field.fileAccept)}"` : ""}${field.fileMaxMb ? ` data-file-max-mb="${field.fileMaxMb}"` : ""}${field.multiple ? " multiple" : ""} type="file">`;
  }

  const inputType =
    field.type === "email" ? "email" :
    field.type === "phone" ? "tel" :
    field.type === "url" ? "url" :
    field.type === "number" ? "number" :
    field.type === "date" ? "date" :
    field.type === "time" ? "time" :
    field.type === "range" ? "range" :
    "text";

  return `<input ${baseAttrs}${field.maxValue ? ` max="${escapeHtml(field.maxValue)}"` : ""}${field.minValue ? ` min="${escapeHtml(field.minValue)}"` : ""}${field.validationPattern ? ` pattern="${escapeHtml(field.validationPattern)}"` : ""} type="${inputType}" value="${escapeHtml(defaultValue)}">`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
