import type { ComponentPropsWithRef, ReactNode } from "react";
import { mergeClassNames } from "@/components/ui/class-names";
import styles from "@/components/ui/foundations.module.css";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

const statusClassName: Record<StatusTone, string> = {
  danger: styles.statusDanger,
  info: styles.statusInfo,
  neutral: styles.statusNeutral,
  success: styles.statusSuccess,
  warning: styles.statusWarning,
};

export type StatusChipProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  children: ReactNode;
  tone?: StatusTone;
};

export function StatusChip({
  children,
  className,
  ref,
  tone = "neutral",
  ...nativeProps
}: StatusChipProps) {
  return (
    <span
      {...nativeProps}
      className={mergeClassNames(styles.statusChip, statusClassName[tone], className)}
      data-nl-ui="status-chip"
      data-tone={tone}
      ref={ref}
    >
      <span aria-hidden="true" className={styles.statusMarker} />
      <span>{children}</span>
    </span>
  );
}

export type NoticeTone = Exclude<StatusTone, "neutral">;

const noticeClassName: Record<NoticeTone, string> = {
  danger: styles.noticeDanger,
  info: styles.noticeInfo,
  success: styles.noticeSuccess,
  warning: styles.noticeWarning,
};

const noticeIcon: Record<NoticeTone, string> = {
  danger: "!",
  info: "i",
  success: "✓",
  warning: "!",
};

export type NoticeProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  announce?: "off" | "polite" | "assertive";
  children: ReactNode;
  tone?: NoticeTone;
};

export function Notice({
  "aria-live": nativeAriaLive,
  announce = "off",
  children,
  className,
  ref,
  role,
  tone = "info",
  ...nativeProps
}: NoticeProps) {
  const liveRole = announce === "assertive" ? "alert" : announce === "polite" ? "status" : role;
  const ariaLive = announce === "off" ? nativeAriaLive : announce;

  return (
    <div
      {...nativeProps}
      aria-live={ariaLive}
      className={mergeClassNames(styles.notice, noticeClassName[tone], className)}
      data-nl-ui="notice"
      data-tone={tone}
      ref={ref}
      role={liveRole}
    >
      <span aria-hidden="true" className={styles.noticeIcon}>{noticeIcon[tone]}</span>
      <div>{children}</div>
    </div>
  );
}
