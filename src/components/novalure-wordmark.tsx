import styles from "@/components/novalure-wordmark.module.css";

export function NovalureWordmark({ className }: { className?: string }) {
  return (
    <span className={`${styles.wordmark} ${className ?? ""}`}>
      novalure<span aria-hidden="true" className={styles.dot} />
    </span>
  );
}
