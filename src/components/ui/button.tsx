import type { ComponentPropsWithRef, ReactNode } from "react";
import { mergeClassNames } from "@/components/ui/class-names";
import styles from "@/components/ui/foundations.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export type ButtonProps = ComponentPropsWithRef<"button"> & {
  importance?: "standard" | "important";
  variant?: ButtonVariant;
};

const variantClassName: Record<ButtonVariant, string> = {
  danger: styles.buttonDanger,
  ghost: styles.buttonGhost,
  primary: styles.buttonPrimary,
  secondary: styles.buttonSecondary,
};

export function Button({
  className,
  importance = "standard",
  ref,
  type = "button",
  variant = "primary",
  ...nativeProps
}: ButtonProps) {
  return (
    <button
      {...nativeProps}
      className={mergeClassNames(
        styles.button,
        variantClassName[variant],
        importance === "important" && styles.buttonImportant,
        className,
      )}
      data-nl-ui="button"
      ref={ref}
      type={type}
    />
  );
}

export type IconButtonProps = Omit<ButtonProps, "children" | "importance"> & {
  "aria-label": string;
  children: ReactNode;
};

export function IconButton({
  "aria-label": ariaLabel,
  children,
  className,
  ref,
  type = "button",
  variant = "ghost",
  ...nativeProps
}: IconButtonProps) {
  return (
    <button
      {...nativeProps}
      aria-label={ariaLabel}
      className={mergeClassNames(styles.button, variantClassName[variant], styles.iconButton, className)}
      data-nl-ui="icon-button"
      ref={ref}
      type={type}
    >
      {children}
    </button>
  );
}
