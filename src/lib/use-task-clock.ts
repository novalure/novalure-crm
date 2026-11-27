"use client";
import { useEffect, useState } from "react";

/** One clock per view keeps counts and labels on the same reference instant. */
export function useTaskClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
