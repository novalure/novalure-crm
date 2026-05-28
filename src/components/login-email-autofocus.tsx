"use client";

import { useEffect } from "react";

export function LoginEmailAutofocus() {
  useEffect(() => {
    document.getElementById("login-email")?.focus();
  }, []);

  return null;
}
