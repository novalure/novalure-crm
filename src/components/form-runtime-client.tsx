"use client";

import { useEffect, useMemo, useRef, useState, type FocusEvent, type FormEvent } from "react";
import {
  FormRenderer,
  fallbackFormRuntimeCopy,
  getFieldDefaultValue,
  normalizeFormSteps,
  type FormRuntimeCopy,
} from "@/components/form-renderer";
import type { PublicFormDto, PublicFormFieldDto } from "@/lib/public-form-dto";
import type { PublicSubmissionProof } from "@/lib/public-submission-contract";

type FormRuntimeClientProps = {
  action?: string;
  className?: string;
  copy?: Partial<FormRuntimeCopy>;
  form: PublicFormDto;
  mode?: "editor" | "public";
  onFieldSelect?: (fieldId: string) => void;
  previewOnly?: boolean;
  publicKey: string;
  returnTo: string;
  selectedFieldId?: string;
  source?: string;
  submissionProof?: PublicSubmissionProof;
};

export function FormRuntimeClient({
  form,
  ...props
}: FormRuntimeClientProps) {
  const formKey = `${form.name}:${form.fields.map((field) => field.id).join("|")}`;

  return <FormRuntimeClientRuntime key={formKey} form={form} {...props} />;
}

function FormRuntimeClientRuntime({
  action,
  className,
  copy,
  form,
  mode = "public",
  onFieldSelect,
  previewOnly = false,
  publicKey,
  returnTo,
  selectedFieldId,
  source,
  submissionProof,
}: FormRuntimeClientProps) {
  const runtimeCopy = { ...fallbackFormRuntimeCopy, ...copy };
  const formRef = useRef<HTMLFormElement>(null);
  const steps = useMemo(() => normalizeFormSteps(form), [form]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string | string[] | boolean>>(() =>
    Object.fromEntries(form.fields.map((field) => [field.id, initialValue(field)])),
  );

  const visibleFieldIds = useMemo(() => {
    const visible = new Set<string>();
    for (const field of form.fields) {
      if (isFieldVisible(field, values, form.fields)) visible.add(field.id);
    }
    return visible;
  }, [form.fields, values]);

  useEffect(() => {
    syncTrackingFields(formRef.current);
  }, []);

  function updateValue(field: PublicFormFieldDto, value: string | string[] | boolean) {
    setValues((current) => ({ ...current, [field.id]: value }));
    if (errors[field.id]) {
      const message = validateField(field, value, formRef.current, runtimeCopy);
      setErrors((current) => {
        const next = { ...current };
        if (message) next[field.id] = message;
        else delete next[field.id];
        return next;
      });
    }
  }

  function validateVisibleStep(stepIndex: number) {
    const step = steps[stepIndex];
    const nextErrors: Record<string, string> = {};
    for (const field of form.fields) {
      const fieldStepId = field.stepId || steps[0]?.id;
      if (fieldStepId !== step.id || !visibleFieldIds.has(field.id)) continue;
      const message = validateField(field, values[field.id], formRef.current, runtimeCopy);
      if (message) nextErrors[field.id] = message;
    }
    setErrors(nextErrors);
    return !Object.keys(nextErrors).length;
  }

  function validateAllVisibleFields() {
    const nextErrors: Record<string, string> = {};
    for (const field of form.fields) {
      if (!visibleFieldIds.has(field.id)) continue;
      const message = validateField(field, values[field.id], formRef.current, runtimeCopy);
      if (message) nextErrors[field.id] = message;
    }
    setErrors(nextErrors);
    return !Object.keys(nextErrors).length;
  }

  function handleNext() {
    if (previewOnly) {
      setErrors({});
      setCurrentStepIndex((current) => Math.min(current + 1, steps.length - 1));
      return;
    }
    if (!validateVisibleStep(currentStepIndex)) return;
    setCurrentStepIndex((current) => Math.min(current + 1, steps.length - 1));
  }

  function handlePrevious() {
    setCurrentStepIndex((current) => Math.max(current - 1, 0));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    syncTrackingFields(formRef.current);
    if (previewOnly || !validateAllVisibleFields()) {
      event.preventDefault();
    }
  }

  function handleBlur(field: PublicFormFieldDto, event: FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    if (previewOnly) return;
    const value = event.currentTarget.type === "checkbox"
      ? (event.currentTarget as HTMLInputElement).checked
      : event.currentTarget.value;
    const message = validateField(field, value, formRef.current, runtimeCopy);
    setErrors((current) => {
      const next = { ...current };
      if (message) next[field.id] = message;
      else delete next[field.id];
      return next;
    });
  }

  return (
    <FormRenderer
      action={action}
      className={className}
      copy={runtimeCopy}
      currentStepIndex={currentStepIndex}
      errors={errors}
      form={form}
      formRef={formRef}
      mode={mode === "editor" ? "editor" : "public"}
      onFieldBlur={handleBlur}
      onFieldSelect={onFieldSelect}
      onFieldValueChange={updateValue}
      onNext={handleNext}
      onPrevious={handlePrevious}
      onSubmit={handleSubmit}
      publicKey={publicKey}
      returnTo={returnTo}
      selectedFieldId={selectedFieldId}
      source={source}
      submissionProof={submissionProof}
      values={values}
      visibleFieldIds={visibleFieldIds}
    />
  );
}

function initialValue(field: PublicFormFieldDto) {
  if (field.type === "checkbox" || field.type === "consent") return Boolean(field.defaultValue);
  if (field.type === "multiCheckbox") return field.defaultValue ? field.defaultValue.split(",").map((item) => item.trim()) : [];
  return getFieldDefaultValue(field);
}

function syncTrackingFields(formElement: HTMLFormElement | null) {
  if (!formElement) return;
  setHiddenInputValue(formElement, "page_url", window.location.href);
  setHiddenInputValue(formElement, "referrer", document.referrer);
}

function setHiddenInputValue(formElement: HTMLFormElement, name: string, value: string) {
  const input = formElement.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (input) input.value = value;
}

function isFieldVisible(
  field: PublicFormFieldDto,
  values: Record<string, string | string[] | boolean>,
  fields: PublicFormFieldDto[],
) {
  if (!field.visibleWhen) return true;
  const controller = fields.find((item) => item.id === field.visibleWhen?.fieldId);
  const value = controller ? values[controller.id] : values[field.visibleWhen.fieldId];
  if (Array.isArray(value)) return value.includes(field.visibleWhen.value);
  if (typeof value === "boolean") return field.visibleWhen.value === String(value);
  return String(value ?? "") === field.visibleWhen.value;
}

function validateField(
  field: PublicFormFieldDto,
  rawValue: string | string[] | boolean | undefined,
  formElement: HTMLFormElement | null,
  copy: FormRuntimeCopy,
) {
  const label = field.label || "Field";
  const requiredMessage = field.errorMessage || `${label} ist erforderlich.`;

  const value = Array.isArray(rawValue) ? rawValue.join(",") : typeof rawValue === "boolean" ? (rawValue ? "1" : "") : String(rawValue ?? "");
  if (field.required && !value.trim()) return requiredMessage;
  if (!value.trim()) return "";

  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return field.errorMessage || copy.invalidEmail;
  }
  if (field.type === "phone" && !/^\+?[0-9\s()./-]{6,}$/.test(value)) {
    return field.errorMessage || copy.invalidPhone;
  }
  if (field.type === "url") {
    try {
      new URL(value);
    } catch {
      return field.errorMessage || copy.invalidUrl;
    }
  }
  if ((field.type === "number" || field.type === "range" || field.type === "rating") && value) {
    const numberValue = Number(value);
    if (Number.isNaN(numberValue)) return field.errorMessage || copy.invalidNumber;
    if (field.minValue && numberValue < Number(field.minValue)) return field.errorMessage || `Minimum: ${field.minValue}`;
    if (field.maxValue && numberValue > Number(field.maxValue)) return field.errorMessage || `Maximum: ${field.maxValue}`;
  }
  if (field.validationPattern) {
    try {
      if (!new RegExp(field.validationPattern).test(value)) return field.errorMessage || copy.invalidPattern;
    } catch {
      return "";
    }
  }
  return "";
}
