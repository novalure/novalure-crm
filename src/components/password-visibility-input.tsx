"use client";

import { useState } from "react";

type PasswordVisibilityInputProps = {
  autoComplete?: string;
  className?: string;
  hideLabel: string;
  id: string;
  name: string;
  required?: boolean;
  showLabel: string;
};

function EyeIcon({ revealed }: { revealed: boolean }) {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M3.4 12s3.2-6 8.6-6 8.6 6 8.6 6-3.2 6-8.6 6-8.6-6-8.6-6Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M12 14.7a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      {revealed ? (
        <path
          d="M4.5 4.5 19.5 19.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
      ) : null}
    </svg>
  );
}

export function PasswordVisibilityInput({
  autoComplete,
  className,
  hideLabel,
  id,
  name,
  required,
  showLabel,
}: PasswordVisibilityInputProps) {
  const [revealed, setRevealed] = useState(false);
  const label = revealed ? hideLabel : showLabel;

  return (
    <div className="relative">
      <input
        autoComplete={autoComplete}
        className={`password-visibility-input pr-12 ${className ?? ""}`}
        id={id}
        name={name}
        required={required}
        type={revealed ? "text" : "password"}
      />
      <button
        aria-label={label}
        aria-pressed={revealed}
        className="absolute inset-y-1 right-1 grid w-10 place-items-center rounded-md text-[#476178] transition hover:bg-[#edf4fb] hover:text-[#071421] focus:outline-none focus:ring-2 focus:ring-[#b8d8ff]"
        onClick={() => setRevealed((current) => !current)}
        title={label}
        type="button"
      >
        <EyeIcon revealed={revealed} />
      </button>
    </div>
  );
}
