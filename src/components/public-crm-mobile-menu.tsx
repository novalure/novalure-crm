"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "@/components/public-crm-landing.module.css";

const MOBILE_NAV_MAX_WIDTH = 1180;

type MenuItem = {
  href: string;
  label: string;
};

type PublicCrmMobileMenuProps = {
  auditHref: string;
  auditLabel: string;
  closeLabel: string;
  items: readonly MenuItem[];
  loginHref: string;
  loginLabel: string;
  openLabel: string;
};

export function PublicCrmMobileMenu({
  auditHref,
  auditLabel,
  closeLabel,
  items,
  loginHref,
  loginLabel,
  openLabel,
}: PublicCrmMobileMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const focusable = () =>
      Array.from(menuRef.current?.querySelectorAll<HTMLElement>("a, button") ?? []).filter(
        (element) => !element.hasAttribute("disabled"),
      );

    focusable()[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }

      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function onResize() {
      if (window.innerWidth > MOBILE_NAV_MAX_WIDTH) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <div className={styles.mobileMenuRoot}>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-label={open ? closeLabel : openLabel}
        className={styles.mobileMenuButton}
        onClick={() => setOpen((current) => !current)}
        ref={buttonRef}
        type="button"
      >
        <span aria-hidden="true" className={open ? styles.mobileMenuIconOpen : styles.mobileMenuIcon}>
          <span />
          <span />
          <span />
        </span>
      </button>
      {open ? (
        <div className={styles.mobileMenuPanel} id={menuId} ref={menuRef}>
          <nav aria-label={openLabel} className={styles.mobileMenuLinks}>
            {items.map((item) => (
              <a href={item.href} key={item.href} onClick={() => setOpen(false)}>
                {item.label}
              </a>
            ))}
          </nav>
          <div className={styles.mobileMenuActions}>
            <a className={styles.mobileLoginLink} href={loginHref} onClick={() => setOpen(false)}>
              {loginLabel}
            </a>
            <a className={styles.primaryButton} href={auditHref} onClick={() => setOpen(false)}>
              {auditLabel}
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
