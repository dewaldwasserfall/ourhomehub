/**
 * Unit tests for per-person themes: the cookie, the <html> attributes, the
 * generated CSS, and the inline style for showing someone's colour.
 */
import { describe, expect, it } from "vitest";
import {
  ACCENTS,
  parseThemeCookie,
  personAccentStyle,
  themeAttributes,
  themeCookieValue,
  themeCss,
} from "@/lib/themes";

describe("theme cookie", () => {
  it("round-trips a valid theme", () => {
    expect(parseThemeCookie(themeCookieValue("ocean", "dark"))).toEqual({ accent: "ocean", mode: "dark" });
  });

  it("falls back to the defaults for anything unexpected", () => {
    expect(parseThemeCookie(undefined)).toEqual({ accent: "basil", mode: "system" });
    expect(parseThemeCookie('"><script>.dark')).toEqual({ accent: "basil", mode: "dark" });
    expect(parseThemeCookie("coral.neon")).toEqual({ accent: "coral", mode: "system" });
  });
});

describe("theme attributes", () => {
  it("leaves data-mode off for Automatic", () => {
    expect(themeAttributes("berry", "system")).toEqual({ "data-accent": "berry" });
    expect(themeAttributes("berry", "light")).toEqual({ "data-accent": "berry", "data-mode": "light" });
  });
});

describe("theme CSS", () => {
  const css = themeCss();

  it("defines every accent for light, forced dark and automatic dark", () => {
    for (const a of ACCENTS) {
      expect(css).toContain(`:root[data-accent="${a.id}"] { --accent: ${a.light};`);
      expect(css).toContain(`:root[data-mode="dark"][data-accent="${a.id}"] { --accent: ${a.dark};`);
      expect(css).toContain(`:root:not([data-mode="light"])[data-accent="${a.id}"] { --accent: ${a.dark};`);
      expect(css).toContain(`--accent-${a.id}-soft:`);
    }
    expect(css).toContain("@media (prefers-color-scheme: dark)");
  });

  it("gives an element someone else's colour", () => {
    expect(personAccentStyle("slate")).toEqual({ "--accent": "var(--accent-slate)", "--accent-soft": "var(--accent-slate-soft)" });
    expect(personAccentStyle(null)["--accent"]).toBe("var(--accent-basil)");
  });
});
