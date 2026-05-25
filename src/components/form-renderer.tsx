import type { ChangeEvent, FocusEvent, FormEvent, Ref } from "react";
import type { FormField, FormStep, WebsiteForm } from "@/lib/form-types";

export type FormRuntimeCopy = {
  back: string;
  fileTooLarge: string;
  invalidEmail: string;
  invalidNumber: string;
  invalidPattern: string;
  invalidPhone: string;
  invalidUrl: string;
  next: string;
  required: string;
  step: string;
  submit: string;
  validationTitle: string;
};

export const fallbackFormRuntimeCopy: FormRuntimeCopy = {
  back: "Zurück",
  fileTooLarge: "{label} ist zu groß.",
  invalidEmail: "Bitte geben Sie eine gültige E-Mail-Adresse ein.",
  invalidNumber: "Bitte geben Sie eine Zahl ein.",
  invalidPattern: "Bitte prüfen Sie dieses Feld.",
  invalidPhone: "Bitte geben Sie eine gültige Telefonnummer ein.",
  invalidUrl: "Bitte geben Sie eine gültige URL ein.",
  next: "Weiter",
  required: "Pflichtfeld",
  step: "Schritt",
  submit: "Absenden",
  validationTitle: "Bitte prüfen Sie die markierten Felder.",
};

export const embeddedFormStyles = `
.novalure-runtime{font-family:Arial,sans-serif;color:#08233f}
.novalure-card{display:grid;gap:16px;background:#fff;border:1px solid #d8e5f7;border-radius:14px;padding:20px;box-shadow:0 18px 45px rgba(15,23,42,.12)}
.novalure-eyebrow{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#2563eb;margin:0}
.novalure-title{font-size:24px;line-height:1.15;font-weight:800;margin:0;color:#08233f}
.novalure-description{font-size:14px;line-height:1.5;color:#52637a;margin:0}
.novalure-progress{display:grid;gap:8px;font-size:12px;font-weight:700;color:#52637a}
.novalure-progress-track{height:7px;background:#edf4ff;border-radius:999px;overflow:hidden}
.novalure-progress-value{display:block;height:100%;background:#2563eb;border-radius:999px}
.novalure-step{display:grid;gap:12px}
.novalure-step-title{font-size:13px;font-weight:800;color:#08233f;margin:0}
.novalure-field{display:grid;gap:6px;font-size:13px;font-weight:700}
.novalure-label-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.novalure-required{font-size:11px;color:#64748b;font-weight:700}
.novalure-control{width:100%;box-sizing:border-box;border:1px solid #b9cbe6;border-radius:10px;padding:12px;font:inherit;font-weight:600;background:#f8fbff;color:#08233f}
.novalure-textarea{min-height:96px;resize:vertical}
.novalure-help{font-size:12px;line-height:1.4;color:#52637a;font-weight:600}
.novalure-error{font-size:12px;line-height:1.4;color:#b91c1c;font-weight:700}
.novalure-choice-list{display:grid;gap:8px}
.novalure-choice{display:flex;gap:9px;align-items:flex-start;border:1px solid #d8e5f7;border-radius:10px;padding:10px;background:#f8fbff;font-weight:700}
.novalure-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.novalure-button{border:0;border-radius:10px;background:#08233f;color:#fff;font-weight:800;padding:12px 16px;cursor:pointer}
.novalure-secondary{border:1px solid #b9cbe6;background:#fff;color:#08233f}
.novalure-hidden{display:none!important}
`;

type FormRendererMode = "editor" | "embed" | "public";

type FormRendererProps = {
  action?: string;
  className?: string;
  copy?: FormRuntimeCopy;
  currentStepIndex?: number;
  errors?: Record<string, string>;
  form: WebsiteForm;
  formRef?: Ref<HTMLFormElement>;
  mode?: FormRendererMode;
  onFieldBlur?: (field: FormField, event: FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
  onFieldSelect?: (fieldId: string) => void;
  onFieldValueChange?: (field: FormField, value: string | string[] | boolean) => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  publicKey: string;
  returnTo: string;
  selectedFieldId?: string;
  source?: string;
  tracking?: {
    pageUrl?: string;
    referrer?: string;
  };
  values?: Record<string, string | string[] | boolean>;
  visibleFieldIds?: Set<string>;
};

export function normalizeFormSteps(form: WebsiteForm): FormStep[] {
  const steps = form.steps?.filter((step) => step.id && step.title) ?? [];
  if (steps.length) return steps;
  return [{ description: "", id: "step_contact", title: form.name || "Formular" }];
}

export function getFieldName(field: FormField) {
  if (field.type === "consent") return field.crmField || "privacy_consent";
  return field.crmField || field.id;
}

export function getFieldDefaultValue(field: FormField) {
  return field.defaultValue || "";
}

export function fieldBelongsToStep(field: FormField, step: FormStep, index: number) {
  if (field.type === "hidden") return false;
  if (field.stepId) return field.stepId === step.id;
  return index === 0;
}

export function FormRenderer({
  action = "/api/forms/submissions",
  className = "",
  copy = fallbackFormRuntimeCopy,
  currentStepIndex = 0,
  errors = {},
  form,
  formRef,
  mode = "public",
  onFieldBlur,
  onFieldSelect,
  onFieldValueChange,
  onNext,
  onPrevious,
  onSubmit,
  publicKey,
  returnTo,
  selectedFieldId,
  source = "website",
  tracking,
  values = {},
  visibleFieldIds,
}: FormRendererProps) {
  const steps = normalizeFormSteps(form);
  const safeStepIndex = Math.min(Math.max(currentStepIndex, 0), steps.length - 1);
  const progress = steps.length > 1 ? Math.round(((safeStepIndex + 1) / steps.length) * 100) : 100;
  const hiddenFields = form.fields.filter((field) => field.type === "hidden");
  const isEditor = mode === "editor";

  return (
    <form
      action={isEditor ? undefined : action}
      className={`novalure-runtime grid gap-4 ${className}`}
      data-novalure-runtime="form"
      encType="multipart/form-data"
      method="post"
      noValidate
      onSubmit={onSubmit}
      ref={formRef}
    >
      <input name="form_id" readOnly type="hidden" value={publicKey} />
      <input name="form_slug" readOnly type="hidden" value={publicKey} />
      <input name="return_to" readOnly type="hidden" value={returnTo} />
      <input name="utm_source" readOnly type="hidden" value={source} />
      <input name="utm_campaign" readOnly type="hidden" value={form.campaign} />
      <input name="form_variant" readOnly type="hidden" value={form.variant} />
      <input name="funnel_id" readOnly type="hidden" value={form.funnelId} />
      <input name="page_url" readOnly type="hidden" value={tracking?.pageUrl ?? ""} />
      <input name="referrer" readOnly type="hidden" value={tracking?.referrer ?? ""} />
      {hiddenFields.map((field) => (
        <input
          data-field-id={field.id}
          key={field.id}
          name={getFieldName(field)}
          readOnly
          type="hidden"
          value={getFieldDefaultValue(field)}
        />
      ))}

      <div className="novalure-card grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="novalure-eyebrow text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Novalure</p>
        <h2 className="novalure-title break-words text-2xl font-semibold text-slate-950">{form.name}</h2>
        {form.actions.thankYouMessage ? (
          <p className="novalure-description break-words text-sm leading-6 text-slate-600">
            {form.actions.thankYouMessage}
          </p>
        ) : null}

        {steps.length > 1 && form.progressMode !== "none" ? (
          <div className="novalure-progress grid gap-2 text-xs font-semibold text-slate-600">
            <span>
              {form.progressMode === "percent"
                ? `${progress}%`
                : `${copy.step} ${safeStepIndex + 1} / ${steps.length}`}
            </span>
            <span className="novalure-progress-track block h-2 overflow-hidden rounded-full bg-blue-50">
              <span className="novalure-progress-value block h-full rounded-full bg-blue-600" style={{ width: `${progress}%` }} />
            </span>
          </div>
        ) : null}

        {Object.keys(errors).length ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-900">
            {copy.validationTitle}
          </div>
        ) : null}

        {steps.map((step, stepIndex) => {
          const active = stepIndex === safeStepIndex;
          return (
            <section
              className={`novalure-step grid gap-3 ${active ? "" : "novalure-hidden hidden"}`}
              data-step-index={stepIndex}
              hidden={!active}
              key={step.id}
            >
              {steps.length > 1 ? (
                <div>
                  <p className="novalure-step-title text-sm font-semibold text-slate-950">{step.title}</p>
                  {step.description ? (
                    <p className="mt-1 break-words text-sm leading-6 text-slate-600">{step.description}</p>
                  ) : null}
                </div>
              ) : null}

              {form.fields
                .filter((field) => fieldBelongsToStep(field, step, stepIndex))
                .map((field) => (
                  <RenderedField
                    copy={copy}
                    error={errors[field.id]}
                    field={field}
                    key={field.id}
                    mode={mode}
                    onBlur={onFieldBlur}
                    onFieldSelect={onFieldSelect}
                    onValueChange={onFieldValueChange}
                    selected={field.id === selectedFieldId}
                    value={values[field.id]}
                    visible={visibleFieldIds ? visibleFieldIds.has(field.id) : true}
                  />
                ))}
            </section>
          );
        })}

        <div className="novalure-actions flex flex-wrap items-center justify-between gap-3">
          {steps.length > 1 ? (
            <button
              className="novalure-button novalure-secondary rounded-md border border-stone-300 bg-white px-4 py-3 text-sm font-semibold text-slate-800 disabled:opacity-40"
              data-action="previous"
              disabled={safeStepIndex === 0}
              onClick={onPrevious}
              type="button"
            >
              {copy.back}
            </button>
          ) : <span />}
          {steps.length > 1 && safeStepIndex < steps.length - 1 ? (
            <button
              className="novalure-button rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
              data-action="next"
              onClick={onNext}
              type="button"
            >
              {copy.next}
            </button>
          ) : (
            <button
              className="novalure-button rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
              type="submit"
            >
              {copy.submit}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function RenderedField({
  copy,
  error,
  field,
  mode,
  onBlur,
  onFieldSelect,
  onValueChange,
  selected,
  value,
  visible,
}: {
  copy: FormRuntimeCopy;
  error?: string;
  field: FormField;
  mode: FormRendererMode;
  onBlur?: FormRendererProps["onFieldBlur"];
  onFieldSelect?: (fieldId: string) => void;
  onValueChange?: FormRendererProps["onFieldValueChange"];
  selected: boolean;
  value?: string | string[] | boolean;
  visible: boolean;
}) {
  const name = getFieldName(field);
  const helpId = `${field.id}_help`;
  const errorId = `${field.id}_error`;
  const describedBy = [field.helpText ? helpId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  const fieldClass = `novalure-field grid min-w-0 gap-2 rounded-lg text-sm font-semibold ${
    selected ? "border border-blue-600 bg-blue-50 p-3" : ""
  } ${
    visible ? "" : "novalure-hidden hidden"
  }`;
  const commonData = {
    "data-condition-field": field.conditionalFieldId || undefined,
    "data-condition-value": field.conditionalValue || undefined,
    "data-field-id": field.id,
    "data-field-type": field.type,
  };
  const selectField = () => onFieldSelect?.(field.id);
  const changeValue = (nextValue: string | string[] | boolean) => onValueChange?.(field, nextValue);
  const currentValue = value ?? getFieldDefaultValue(field);

  if (field.type === "hidden") return null;

  return (
    <div className={fieldClass} onClick={selectField} {...commonData}>
      <span className="novalure-label-row flex min-w-0 items-center justify-between gap-2">
        <span>
          {field.label}
          {field.required ? "*" : ""}
        </span>
        {field.required ? <span className="novalure-required shrink-0 text-xs text-slate-500">{copy.required}</span> : null}
      </span>
      {renderControl({
        describedBy,
        field,
        mode,
        name,
        onBlur,
        onValueChange: changeValue,
        value: currentValue,
      })}
      {field.helpText ? (
        <span className="novalure-help text-xs font-medium text-slate-500" id={helpId}>
          {field.helpText}
        </span>
      ) : null}
      {error ? (
        <span className="novalure-error text-xs font-semibold text-red-700" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

function renderControl({
  describedBy,
  field,
  mode,
  name,
  onBlur,
  onValueChange,
  value,
}: {
  describedBy?: string;
  field: FormField;
  mode: FormRendererMode;
  name: string;
  onBlur?: FormRendererProps["onFieldBlur"];
  onValueChange: (value: string | string[] | boolean) => void;
  value: string | string[] | boolean;
}) {
  const baseInputClass = "novalure-control w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-3 text-sm font-medium";
  const controlledValue = typeof value === "string" ? value : "";
  const commonInput = {
    "aria-describedby": describedBy,
    "aria-invalid": Boolean(describedBy?.includes("_error")) || undefined,
    className: baseInputClass,
    defaultValue: mode === "embed" ? getFieldDefaultValue(field) : undefined,
    name,
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onBlur?.(field, event),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const target = event.currentTarget;
      onValueChange(target.type === "checkbox" ? (target as HTMLInputElement).checked : target.value);
    },
    placeholder: field.placeholder,
    required: field.required,
    value: mode === "embed" ? undefined : controlledValue,
  };

  if (field.type === "textarea") {
    return <textarea {...commonInput} className={`${baseInputClass} novalure-textarea min-h-28`} />;
  }

  if (field.type === "select") {
    return (
      <select {...commonInput}>
        <option value="">{field.placeholder || "-"}</option>
        {field.options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }

  if (field.type === "radio" || field.type === "multiCheckbox" || field.type === "rating") {
    const options = field.type === "rating" ? ["1", "2", "3", "4", "5"] : field.options;
    return (
      <span className="novalure-choice-list grid gap-2">
        {options.map((option, index) => (
          <span className="novalure-choice flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3" key={option}>
            <input
              aria-describedby={describedBy}
              checked={mode === "embed" ? undefined : Array.isArray(value) ? value.includes(option) : value === option}
              defaultChecked={mode === "embed" ? (Array.isArray(value) ? value.includes(option) : value === option) : undefined}
              name={name}
              onBlur={(event) => onBlur?.(field, event)}
              onChange={(event) => {
                if (field.type === "multiCheckbox") {
                  const current = Array.isArray(value) ? value : [];
                  onValueChange(event.currentTarget.checked
                    ? [...current, option]
                    : current.filter((item) => item !== option));
                  return;
                }
                onValueChange(option);
              }}
              required={field.required && index === 0 && field.type !== "multiCheckbox"}
              type={field.type === "multiCheckbox" ? "checkbox" : "radio"}
              value={option}
            />
            <span>{field.type === "rating" ? `${option} / 5` : option}</span>
          </span>
        ))}
      </span>
    );
  }

  if (field.type === "checkbox" || field.type === "consent") {
    return (
      <span className="novalure-choice flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <input
          aria-describedby={describedBy}
          defaultChecked={mode === "embed" ? Boolean(field.defaultValue) : undefined}
          checked={mode === "embed" ? undefined : Boolean(value)}
          name={name}
          onBlur={(event) => onBlur?.(field, event)}
          onChange={(event) => onValueChange(event.currentTarget.checked)}
          required={field.required}
          type="checkbox"
          value="1"
        />
        <span>{field.helpText || field.label}</span>
      </span>
    );
  }

  if (field.type === "file") {
    return (
      <input
        aria-describedby={describedBy}
        className={baseInputClass}
        data-file-max-mb={field.fileMaxMb || undefined}
        accept={field.fileAccept || undefined}
        multiple={field.multiple}
        name={name}
        onBlur={(event) => onBlur?.(field, event)}
        onChange={() => onValueChange("")}
        required={field.required}
        type="file"
      />
    );
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

  return (
    <input
      {...commonInput}
      max={field.maxValue || undefined}
      min={field.minValue || undefined}
      pattern={field.validationPattern || undefined}
      type={inputType}
    />
  );
}
