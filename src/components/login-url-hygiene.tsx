"use client";

import { useEffect } from "react";

type LoginUrlHygieneProps = {
  clearError?: boolean;
};

export function LoginUrlHygiene({ clearError = false }: LoginUrlHygieneProps) {
  useEffect(() => {
    const url = new URL(window.location.href);
    const previous = url.toString();

    url.searchParams.delete("email");
    if (clearError) url.searchParams.delete("error");

    if (url.toString() !== previous) {
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, [clearError]);

  return null;
}
