import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";
import { mergeClassNames } from "@/components/ui/class-names";
import styles from "@/components/ui/foundations.module.css";

type StateShellProps = ComponentPropsWithRef<"div"> & {
  actions?: ReactNode;
  description?: ReactNode;
  icon: string;
  title: ReactNode;
  titleAs?: "h2" | "h3" | "p";
};

function StateShell({
  actions,
  children,
  className,
  description,
  icon,
  ref,
  title,
  titleAs = "h3",
  ...nativeProps
}: StateShellProps) {
  const Title: ElementType = titleAs;

  return (
    <div {...nativeProps} className={mergeClassNames(styles.state, className)} ref={ref}>
      <span aria-hidden="true" className={styles.stateIcon}>{icon}</span>
      <Title className={styles.stateTitle}>{title}</Title>
      {description ? <p className={styles.stateDescription}>{description}</p> : null}
      {children}
      {actions ? <div className={styles.stateActions}>{actions}</div> : null}
    </div>
  );
}

export type EmptyStateProps = Omit<StateShellProps, "icon"> & {
  icon?: string;
};

export function EmptyState({ icon = "○", role = "status", ...props }: EmptyStateProps) {
  return <StateShell {...props} data-nl-ui="empty-state" icon={icon} role={role} />;
}

export type LoadingStateProps = Omit<StateShellProps, "actions" | "icon"> & {
  icon?: string;
};

export function LoadingState({
  "aria-live": ariaLive = "polite",
  className,
  icon = "…",
  role = "status",
  ...props
}: LoadingStateProps) {
  return (
    <StateShell
      {...props}
      aria-busy="true"
      aria-live={ariaLive}
      className={mergeClassNames(styles.stateLoading, className)}
      data-nl-ui="loading-state"
      icon={icon}
      role={role}
    />
  );
}

export type ErrorStateProps = Omit<StateShellProps, "icon"> & {
  icon?: string;
};

export function ErrorState({
  "aria-live": ariaLive = "assertive",
  className,
  icon = "!",
  role = "alert",
  ...props
}: ErrorStateProps) {
  return (
    <StateShell
      {...props}
      aria-live={ariaLive}
      className={mergeClassNames(styles.stateError, className)}
      data-nl-ui="error-state"
      icon={icon}
      role={role}
    />
  );
}
