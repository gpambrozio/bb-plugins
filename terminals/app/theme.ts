/**
 * The terminal's colors and font, read from the same CSS variables bb's own
 * terminal reads (bb 0.48.1), so a tab here looks like a terminal in bb's
 * panel and follows bb's theme.
 */
import type { ITheme } from "@xterm/xterm";

/** bb's own fallback when the theme sets no `--font-terminal`. */
const FALLBACK_FONT =
  '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

/** xterm's theme field → the CSS variable bb's terminal fills it from. */
export const THEME_VARIABLES: Readonly<Partial<Record<keyof ITheme, string>>> = {
  background: "--sidebar",
  foreground: "--foreground",
  cursor: "--foreground",
  cursorAccent: "--sidebar",
  selectionBackground: "--muted",
  selectionInactiveBackground: "--muted",
  black: "--ansi-0",
  red: "--ansi-1",
  green: "--ansi-2",
  yellow: "--ansi-3",
  blue: "--ansi-4",
  magenta: "--ansi-5",
  cyan: "--ansi-6",
  white: "--ansi-7",
  brightBlack: "--ansi-8",
  brightRed: "--ansi-9",
  brightGreen: "--ansi-10",
  brightYellow: "--ansi-11",
  brightBlue: "--ansi-12",
  brightMagenta: "--ansi-13",
  brightCyan: "--ansi-14",
  brightWhite: "--ansi-15",
};

/**
 * Builds a theme from `resolve`, which turns a CSS variable into a color xterm
 * can parse, or undefined when the variable is unset (xterm keeps its default).
 */
export function buildTheme(resolve: (variable: string) => string | undefined): ITheme {
  const theme: Record<string, string> = {};
  for (const [field, variable] of Object.entries(THEME_VARIABLES)) {
    const color = resolve(variable);
    if (color !== undefined) theme[field] = color;
  }
  return theme as ITheme;
}

/**
 * The current theme. A variable may hold any CSS color (oklch, a nested
 * var()); a hidden element's computed color turns it into rgb() for xterm.
 */
export function currentTheme(): ITheme {
  if (typeof document === "undefined") return {};
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  try {
    const root = getComputedStyle(document.documentElement);
    return buildTheme((variable) => {
      const value = root.getPropertyValue(variable).trim();
      if (value === "") return undefined;
      probe.style.color = value;
      return getComputedStyle(probe).color || undefined;
    });
  } finally {
    probe.remove();
  }
}

export function currentFontFamily(): string {
  if (typeof document === "undefined") return FALLBACK_FONT;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim();
  return value === "" ? FALLBACK_FONT : value;
}
