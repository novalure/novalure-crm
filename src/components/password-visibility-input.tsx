"use client";

import { useState, type ComponentPropsWithRef } from "react";

type PasswordVisibilityInputProps = Omit<ComponentPropsWithRef<"input">, "type"> & {
  hideLabel: string;
  id: string;
  name: string;
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
  className,
  hideLabel,
  id,
  name,
  ref,
  showLabel,
  ...nativeProps
}: PasswordVisibilityInputProps) {
  const [revealed, setRevealed] = useState(false);
  const label = revealed ? hideLabel : showLabel;

  return (
    <div className="relative">
      <input
        {...nativeProps}
        className={`password-visibility-input pr-12 ${className ?? ""}`}
        id={id}
        name={name}
        ref={ref}
        type={revealed ? "text" : "password"}
      />
      <button
        aria-controls={id}
        aria-label={label}
        aria-pressed={revealed}
        className="absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-md text-[#6f6a63] transition hover:bg-[#e9f0fe] hover:text-[#33302b] focus:outline-none focus:ring-2 focus:ring-[#2d68f0]"
        onClick={() => setRevealed((current) => !current)}
        title={label}
        type="button"
      >
        <EyeIcon revealed={revealed} />
      </button>
    </div>
  );
}
