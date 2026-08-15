import type {
  ComponentPropsWithRef,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { mergeClassNames } from "@/components/ui/class-names";
import styles from "@/components/ui/foundations.module.css";

export type FieldProps = ComponentPropsWithRef<"div"> & {
  error?: ReactNode;
  errorId?: string;
  hint?: ReactNode;
  hintId?: string;
  htmlFor: string;
  label: ReactNode;
  required?: boolean;
};

export function Field({
  children,
  className,
  error,
  errorId,
  hint,
  hintId,
  htmlFor,
  label,
  ref,
  required = false,
  ...nativeProps
}: FieldProps) {
  return (
    <div {...nativeProps} className={mergeClassNames(styles.field, className)} ref={ref}>
      <label className={styles.fieldLabel} htmlFor={htmlFor}>
        {label}
        {required ? <span aria-hidden="true" className={styles.requiredMarker}>*</span> : null}
      </label>
      {children}
      {hint ? <p className={styles.fieldHint} id={hintId}>{hint}</p> : null}
      {error ? <p className={styles.fieldError} id={errorId}>{error}</p> : null}
    </div>
  );
}

export type FieldDensity = "default" | "compact";

type ControlProps = {
  density?: FieldDensity;
};

export type InputProps = ComponentPropsWithRef<"input"> & ControlProps;

export function Input({ className, density = "default", ref, ...nativeProps }: InputProps) {
  return (
    <input
      {...nativeProps}
      className={mergeClassNames(styles.control, className)}
      data-density={density}
      data-nl-ui="input"
      ref={ref}
    />
  );
}

export type SelectProps = ComponentPropsWithRef<"select"> & ControlProps;

export function Select({ className, density = "default", ref, ...nativeProps }: SelectProps) {
  return (
    <select
      {...nativeProps}
      className={mergeClassNames(styles.control, styles.select, className)}
      data-density={density}
      data-nl-ui="select"
      ref={ref}
    />
  );
}

export type TextareaProps = ComponentPropsWithRef<"textarea"> & ControlProps;

export function Textarea({ className, density = "default", ref, ...nativeProps }: TextareaProps) {
  return (
    <textarea
      {...nativeProps}
      className={mergeClassNames(styles.control, styles.textarea, className)}
      data-density={density}
      data-nl-ui="textarea"
      ref={ref}
    />
  );
}

type CheckboxAccessibleName =
  | { "aria-label"?: never; label: ReactNode }
  | { "aria-label": string; label?: never };

type NativeCheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "aria-label" | "type">;

export type CheckboxProps = NativeCheckboxProps &
  CheckboxAccessibleName & {
    containerClassName?: string;
    ref?: ComponentPropsWithRef<"input">["ref"];
  };

export function Checkbox({
  "aria-label": ariaLabel,
  className,
  containerClassName,
  label,
  ref,
  ...nativeProps
}: CheckboxProps) {
  return (
    <label className={mergeClassNames(styles.checkboxTarget, containerClassName)}>
      <input
        {...nativeProps}
        aria-label={ariaLabel}
        className={mergeClassNames(styles.checkbox, className)}
        data-nl-ui="checkbox"
        ref={ref}
        type="checkbox"
      />
      {label ? <span>{label}</span> : null}
    </label>
  );
}

export function fieldDescriptionIds(...ids: Array<string | false | null | undefined>) {
  const value = ids.filter(Boolean).join(" ");
  return value || undefined;
}
