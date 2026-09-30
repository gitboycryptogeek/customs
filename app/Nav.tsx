"use client";

// The site nav.
//
// Every page already linked to every other page, but as words inside a sentence
// of explanatory prose at the top or bottom of the page — "uncertain values are
// flagged, never guessed. Documents Settings". Both pages existed and worked;
// nobody could find them, which for Documents meant the whole add-your-own-PDFs
// feature was unreachable in practice. A row of tabs is not a nicety here.

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { href: "/", label: "Lookup" },
  { href: "/documents", label: "Documents" },
  { href: "/review", label: "Review" },
  { href: "/history", label: "History" },
  { href: "/misses", label: "Unmatched" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const path = usePathname();

  return (
    <nav className="sitenav" aria-label="Main">
      <div className="sitenav-links">
        {LINKS.map((l) => {
          // Exact match for the lookup page, prefix match for the rest — so
          // /review?document=… still marks Review as current.
          const current = l.href === "/" ? path === "/" : path.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`sitenav-link ${current ? "current" : ""}`}
              aria-current={current ? "page" : undefined}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
      <div className="sitenav-right">
        {/* Baked in at build time by next.config.mjs. An update that appears not
            to have worked is indistinguishable from one that did without this. */}
        <span className="sitenav-version" title="Installed version">
          v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
        </span>
        <ThemeToggle />
      </div>
    </nav>
  );
}
