"use client";

// Light / dark / follow-the-system, as a three-state control.
//
// "System" is a real third state rather than a default, because the other two
// have to be able to override it: a laptop that flips to dark at sunset should
// not flip an officer's screen mid-shift if they have said they want light.
//
// The choice is written to localStorage AND to `data-theme` on <html>. The
// inline script in layout.tsx reads the same key before first paint — without it
// a stored dark preference shows a white page for one frame, which is the single
// most noticeable bug a theme toggle can have.

import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

export const THEME_KEY = "customs.theme";

/** Apply a choice to the document and remember it. Safe to call on the server (no-op). */
export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private window, blocked storage — the theme still applies for this page */
  }
}

/** What is stored, or "system". */
export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* fall through */
  }
  return "system";
}

const OPTIONS: { value: Theme; label: string; title: string }[] = [
  { value: "light", label: "Light", title: "Always light" },
  { value: "dark", label: "Dark", title: "Always dark" },
  { value: "system", label: "Auto", title: "Follow the operating system" },
];

export function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  // Starts as null so the first client render matches the server's HTML —
  // reading localStorage during render would be a hydration mismatch.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => setTheme(readTheme()), []);

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div className="themeswitch">
      {withLabel ? <span className="themeswitch-label">Appearance</span> : null}
      <div className="themeswitch-buttons" role="group" aria-label="Colour theme">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            title={o.title}
            className={`themeswitch-btn ${theme === o.value ? "on" : ""}`}
            aria-pressed={theme === o.value}
            onClick={() => choose(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
