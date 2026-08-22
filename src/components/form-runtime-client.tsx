"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type FormEvent } from "react";
import {
  FormRenderer,
  fallbackFormRuntimeCopy,
  getFieldDefaultValue,
  normalizeFormSteps,
  type FormRuntimeCopy,
} from "@/components/form-renderer";
import type { PublicFormDto, PublicFormFieldDto } from "@/lib/public-form-dto";
import {
  parsePublicSubmissionProof,
  publicSubmissionControlFields,
  publicSubmissionProofRefreshLeadSeconds,
  type PublicSubmissionProof,
} from "@/lib/public-submission-contract";

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
  const formKey = `${form.name}:${form.fields.map((field) => field.id).join("|")}:${props.submissionProof?.signature ?? "no-proof"}`;

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
  const proofRefreshPromiseRef = useRef<Promise<PublicSubmissionProof> | null>(null);
  const proofRefreshSubmitPendingRef = useRef(false);
  const submissionProofRef = useRef<PublicSubmissionProof | undefined>(submissionProof);
  const steps = useMemo(() => normalizeFormSteps(form), [form]);
  const [activeSubmissionProof, setActiveSubmissionProof] = useState(submissionProof);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [proofRefreshError, setProofRefreshError] = useState("");
  const [proofRefreshPending, setProofRefreshPending] = useState(false);
  const [values, setValues] = useState<Record<string, string | string[] | boolean>>(() =>
    Object.fromEntries(form.fields.map((field) => [field.id, initialValue(field)])),
  );

  const installSubmissionProof = useCallback((proof: PublicSubmissionProof) => {
    submissionProofRef.current = proof;
    setActiveSubmissionProof(proof);
    syncPublicSubmissionProofFields(formRef.current, proof);
    setProofRefreshError("");
  }, []);

  const refreshSubmissionProof = useCallback(async () => {
    const currentProof = submissionProofRef.current;
    if (!currentProof) throw new Error("submission_proof_missing");
    if (proofRefreshPromiseRef.current) return proofRefreshPromiseRef.current;

    const refreshPromise = (async () => {
      const body = new URLSearchParams({
        form: publicKey,
        [publicSubmissionControlFields.expiresAt]: String(currentProof.expiresAt),
        [publicSubmissionControlFields.idempotencyKey]: currentProof.idempotencyKey,
        [publicSubmissionControlFields.issuedAt]: String(currentProof.issuedAt),
        [publicSubmissionControlFields.proof]: currentProof.signature,
      });
      const response = await fetch("/api/forms/submission-proof", {
        body,
        cache: "no-store",
        credentials: "omit",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        method: "POST",
      });
      const payload = await response.json().catch(() => null) as { proof?: unknown } | null;
      const proof = parsePublicSubmissionProof(payload?.proof);
      if (!response.ok || !proof || proof.idempotencyKey !== currentProof.idempotencyKey) {
        throw new Error("submission_proof_refresh_failed");
      }
      installSubmissionProof(proof);
      return proof;
    })();

    proofRefreshPromiseRef.current = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      if (proofRefreshPromiseRef.current === refreshPromise) {
        proofRefreshPromiseRef.current = null;
      }
    }
  }, [installSubmissionProof, publicKey]);

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

  useEffect(() => {
    if (mode !== "public" || previewOnly || !activeSubmissionProof) return;
    const refreshAt =
      (activeSubmissionProof.expiresAt - publicSubmissionProofRefreshLeadSeconds) * 1_000;
    const delay = Math.max(0, Math.min(2_147_483_647, refreshAt - Date.now()));
    const timer = window.setTimeout(() => {
      void refreshSubmissionProof().catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activeSubmissionProof, mode, previewOnly, refreshSubmissionProof]);

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
      return;
    }
    if (mode !== "public") return;

    const proof = submissionProofRef.current;
    if (!proof) {
      event.preventDefault();
      setProofRefreshError(runtimeCopy.proofRefreshFailed);
      return;
    }
    if (!shouldRefreshSubmissionProof(proof)) return;

    event.preventDefault();
    if (proofRefreshSubmitPendingRef.current) return;
    proofRefreshSubmitPendingRef.current = true;
    setProofRefreshPending(true);
    setProofRefreshError("");
    const formElement = event.currentTarget;
    void refreshSubmissionProof().then(
      () => {
        proofRefreshSubmitPendingRef.current = false;
        setProofRefreshPending(false);
        if (formElement.isConnected) formElement.requestSubmit();
      },
      () => {
        proofRefreshSubmitPendingRef.current = false;
        setProofRefreshPending(false);
        setProofRefreshError(runtimeCopy.proofRefreshFailed);
      },
    );
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
      runtimeError={proofRefreshError}
      selectedFieldId={selectedFieldId}
      source={source}
      submissionPending={proofRefreshPending}
      submissionProof={activeSubmissionProof}
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

function syncPublicSubmissionProofFields(
  formElement: HTMLFormElement | null,
  proof: PublicSubmissionProof,
) {
  if (!formElement) return;
  setHiddenInputValue(
    formElement,
    publicSubmissionControlFields.idempotencyKey,
    proof.idempotencyKey,
  );
  setHiddenInputValue(formElement, publicSubmissionControlFields.issuedAt, String(proof.issuedAt));
  setHiddenInputValue(formElement, publicSubmissionControlFields.expiresAt, String(proof.expiresAt));
  setHiddenInputValue(formElement, publicSubmissionControlFields.proof, proof.signature);
}

function shouldRefreshSubmissionProof(
  proof: PublicSubmissionProof,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  return proof.expiresAt - publicSubmissionProofRefreshLeadSeconds <= nowSeconds;
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
