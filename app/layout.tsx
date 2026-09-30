import type { Metadata } from "next";
import "./globals.css";

import { Nav } from "./Nav";

export const metadata: Metadata = {
  title: "Customs Compliance Lookup",
  description: "Deterministic duty, levy and condition lookup with legal citations.",
};

/*
 * Set data-theme before the first paint.
 *
 * React cannot do this: the stored preference lives in localStorage, which the
 * server has no access to, so anything driven by state paints the default theme
 * for one frame first. On a dark-theme machine that is a full-page white flash on
 * every navigation. This runs synchronously in <head>, before the body renders.
 *
 * Kept deliberately tiny and wrapped in try/catch — it runs before anything else
 * on the page, so a throw here would be a blank screen.
 */
const THEME_SCRIPT = `
try {
  var t = localStorage.getItem("customs.theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {/*
          A full-width band with its own centred inner element, rather than
          wrapping {children} in .wrap — every page already opens its own .wrap,
          and nesting them would double the page gutter.
        */}
        <div className="navbar">
          <div className="navbar-inner">
            <Nav />
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
