"use client";

import { useEffect } from "react";

/**
 * Safely suppresses the recurring "Cannot read properties of null (reading
 * 'addEventListener')" noise that can come from platform/analytics scripts
 * (e.g. an external `functions.js` bundle on some deployments). Real,
 * actionable errors still propagate to the console; only the specific
 * null-listener error is swallowed so it never breaks the page.
 */
export function ErrorGuard() {
  useEffect(() => {
    const handler = (e: ErrorEvent) => {
      const msg = (e.message || "").toLowerCase();
      if (msg.includes("addeventlistener") && msg.includes("null")) {
        // non-critical platform-script noise — don't let it surface as a
        // page-breaking error.
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("error", handler);
    return () => window.removeEventListener("error", handler);
  }, []);
  return null;
}
