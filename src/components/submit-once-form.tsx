"use client";

import { useRef, useState, type ComponentPropsWithoutRef, type FormEvent } from "react";

type SubmitOnceFormProps = Omit<ComponentPropsWithoutRef<"form">, "aria-busy" | "onSubmit">;

/**
 * Prevents a second native submission while the first navigation is in
 * flight. The original submitter remains enabled so named submit buttons
 * (for example workspace selection) keep their form value.
 */
export function SubmitOnceForm({ children, ...props }: SubmitOnceFormProps) {
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (submittingRef.current) {
      event.preventDefault();
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
  }

  return (
    <form {...props} aria-busy={submitting || undefined} onSubmit={handleSubmit}>
      {children}
    </form>
  );
}
