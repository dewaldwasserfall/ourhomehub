/**
 * Per-person themes: an accent colour and Light / Dark / Automatic.
 *
 * One source of truth for the eight accents. themeCss() turns them into CSS
 * custom properties that the root layout puts in <head>:
 *
 *   --accent-<id>, --accent-<id>-soft   every accent, light or dark as the
 *                                        page is, so any person's colour can
 *                                        be shown (avatars, "for" chips)
 *   [data-accent="<id>"]                 sets --accent / --accent-ink /
 *                                        --accent-soft for the signed-in person
 *
 * Light or dark comes from [data-mode] on <html>: "light", "dark", or absent
 * for Automatic (the phone's setting, via prefers-color-scheme).
 *
 * The choice is saved on the member row (follows the person to every device)
 * and mirrored in a cookie so the server can render the page in the right
 * colours straight away, with no flash.
 */

export type ThemeMode = "system" | "light" | "dark";

export interface Accent {
  id: string;
  label: string;
  /** Accent on light backgrounds (white text on it passes WCAG AA). */
  light: string;
  /** Accent on dark backgrounds (dark text on it passes WCAG AA). */
  dark: string;
}

// Step 1: the eight accents. Basil is the original HomeHub green.
export const ACCENTS: Accent[] = [
  { id: "basil", label: "Basil", light: "#1e8a5a", dark: "#3ccb85" },
  { id: "ocean", label: "Ocean", light: "#0a6fbd", dark: "#4aa8ff" },
  { id: "indigo", label: "Indigo", light: "#4f46e5", dark: "#8f90ff" },
  { id: "lavender", label: "Lavender", light: "#8447cf", dark: "#bb8fff" },
  { id: "berry", label: "Berry", light: "#c2185b", dark: "#ff6fa3" },
  { id: "coral", label: "Coral", light: "#c7410c", dark: "#ff8a5c" },
  { id: "sunflower", label: "Sunflower", light: "#946300", dark: "#ffc53d" },
  { id: "slate", label: "Slate", light: "#4a5866", dark: "#a3b4c6" },
];

export const DEFAULT_ACCENT = "basil";
export const THEME_COOKIE = "hh-theme";

const ACCENT_IDS = new Set(ACCENTS.map((a) => a.id));
const MODES = new Set<ThemeMode>(["system", "light", "dark"]);

export function isAccent(id: unknown): id is string {
  return typeof id === "string" && ACCENT_IDS.has(id);
}

export function isThemeMode(mode: unknown): mode is ThemeMode {
  return typeof mode === "string" && MODES.has(mode as ThemeMode);
}

// Step 2: the cookie, "accent.mode" (e.g. "ocean.dark"). Anything unexpected
// falls back to the defaults, so a tampered cookie can't inject markup.
export function parseThemeCookie(value: string | undefined): { accent: string; mode: ThemeMode } {
  const [accent, mode] = (value ?? "").split(".");
  return {
    accent: isAccent(accent) ? accent : DEFAULT_ACCENT,
    mode: isThemeMode(mode) ? mode : "system",
  };
}

export function themeCookieValue(accent: string, mode: ThemeMode): string {
  return `${isAccent(accent) ? accent : DEFAULT_ACCENT}.${isThemeMode(mode) ? mode : "system"}`;
}

/** The <html> attributes for a theme (data-mode is left out for Automatic). */
export function themeAttributes(accent: string, mode: ThemeMode): Record<string, string> {
  const attrs: Record<string, string> = { "data-accent": isAccent(accent) ? accent : DEFAULT_ACCENT };
  if (mode === "light" || mode === "dark") attrs["data-mode"] = mode;
  return attrs;
}

/** Apply a theme to the open page right away (no reload). Browser only. */
export function applyTheme(accent: string, mode: ThemeMode) {
  const root = document.documentElement;
  const attrs = themeAttributes(accent, mode);
  root.setAttribute("data-accent", attrs["data-accent"]);
  if (attrs["data-mode"]) root.setAttribute("data-mode", attrs["data-mode"]);
  else root.removeAttribute("data-mode");
  // One year; read by the root layout on the next page load.
  document.cookie = `${THEME_COOKIE}=${themeCookieValue(accent, mode)}; path=/; max-age=31536000; samesite=lax`;
}

// Step 3: the CSS.

/** "#1e8a5a" + 0.12 -> "rgba(30, 138, 90, 0.12)" */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Custom properties for every accent, in light or dark. */
function paletteVars(variant: "light" | "dark"): string {
  return ACCENTS.map((a) => {
    const hex = a[variant];
    return `--accent-${a.id}: ${hex}; --accent-${a.id}-soft: ${withAlpha(hex, variant === "light" ? 0.12 : 0.18)};`;
  }).join(" ");
}

/** The signed-in person's accent, in light or dark. */
function accentRule(selector: string, a: Accent, variant: "light" | "dark"): string {
  const hex = a[variant];
  const ink = variant === "light" ? "#ffffff" : "#0e1012";
  const soft = withAlpha(hex, variant === "light" ? 0.12 : 0.18);
  return `${selector} { --accent: ${hex}; --accent-ink: ${ink}; --accent-soft: ${soft}; }`;
}

/**
 * All theme CSS. Dark applies when data-mode="dark", or when the phone is in
 * dark mode and the person hasn't forced light.
 */
export function themeCss(): string {
  const DARK_FORCED = ':root[data-mode="dark"]';
  const DARK_AUTO = ':root:not([data-mode="light"])';
  const lines: string[] = [`:root { ${paletteVars("light")} }`, `${DARK_FORCED} { ${paletteVars("dark")} }`];
  const autoDark: string[] = [`${DARK_AUTO} { ${paletteVars("dark")} }`];
  for (const a of ACCENTS) {
    lines.push(accentRule(`:root[data-accent="${a.id}"]`, a, "light"));
    lines.push(accentRule(`${DARK_FORCED}[data-accent="${a.id}"]`, a, "dark"));
    autoDark.push(accentRule(`${DARK_AUTO}[data-accent="${a.id}"]`, a, "dark"));
  }
  return `${lines.join("\n")}\n@media (prefers-color-scheme: dark) {\n${autoDark.join("\n")}\n}`;
}

/** Inline style that gives one element a person's accent (avatars, chips). */
export function personAccentStyle(accent: string | null | undefined): Record<string, string> {
  const id = isAccent(accent) ? accent : DEFAULT_ACCENT;
  return { "--accent": `var(--accent-${id})`, "--accent-soft": `var(--accent-${id}-soft)` };
}
