import type { BrandingAccentTokens } from '@open-mercato/cezar-contract';

/**
 * The operator's accent colour turned into the cockpit's `--primary` family, once per theme
 * (spec 2026-10-24-cockpit-branding §3). The dataviz contrast rules: a fill or ring must reach
 * 3:1 against the theme's surface, ink (accent-coloured text) 4.5:1, and the text ON a fill
 * 4.5:1 — near-black or white, whichever reads better, else pure black or white.
 */

/** The surfaces in `packages/web/src/styles/index.css` (`--background`, dark and `.light`). */
const SURFACE = { dark: '#131316', light: '#ffffff' } as const;
const ON_FILL = '#10190a';

type Rgb = readonly [number, number, number];

export function parseHexColor(value: string): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex = ([r, g, b]: Rgb): string => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix toward `target` in 2% steps until `minimum` contrast against `surface` holds. */
function reach(color: Rgb, surface: Rgb, target: Rgb, minimum: number): Rgb {
  for (let step = 0; step <= 50; step += 1) {
    const t = step / 50;
    const mix = (i: 0 | 1 | 2) => Math.round(color[i] + (target[i] - color[i]) * t);
    const mixed: Rgb = [mix(0), mix(1), mix(2)];
    if (contrastRatio(mixed, surface) >= minimum) return mixed;
  }
  return target;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

const better = (fill: Rgb, a: Rgb, b: Rgb): Rgb => (contrastRatio(fill, a) >= contrastRatio(fill, b) ? a : b);

/** The text colour on `fill`: cezar's near-black or white when one reaches 4.5:1, else pure black
 *  or white — one of which always does (≥ 4.58:1 at worst). */
function onFill(fill: Rgb): string {
  const preferred = better(fill, parseHexColor(ON_FILL)!, WHITE);
  return hex(contrastRatio(fill, preferred) >= 4.5 ? preferred : better(fill, BLACK, WHITE));
}

/** Pale and greyish: as a fill on a white surface it would not show at all. */
const nearWhite = (color: Rgb, surface: Rgb): boolean =>
  contrastRatio(color, surface) < 1.25 && Math.max(...color) - Math.min(...color) < 64;

/** The four tokens per theme, or null for a value that is not `#rrggbb`. */
export function deriveAccentTokens(value: string): BrandingAccentTokens | null {
  const color = parseHexColor(value);
  if (!color) return null;
  const dark = parseHexColor(SURFACE.dark)!;
  const light = parseHexColor(SURFACE.light)!;
  const darkFill = reach(color, dark, WHITE, 3);
  // Light keeps the colour itself as the fill — a button carries its own text colour — and
  // darkens only where the accent is drawn ON the white surface (the ring and the ink), or where
  // a near-white fill would vanish into it.
  const lightFill = nearWhite(color, light) ? reach(color, light, BLACK, 3) : color;
  return {
    dark: { primary: hex(darkFill), primaryForeground: onFill(darkFill), primaryStrong: hex(reach(color, dark, WHITE, 4.5)), ring: hex(darkFill) },
    light: { primary: hex(lightFill), primaryForeground: onFill(lightFill), primaryStrong: hex(reach(color, light, BLACK, 4.5)), ring: hex(reach(color, light, BLACK, 3)) },
  };
}

/** The custom properties `index.css`'s `[data-brand-accent]` rules read, as one inline style. */
export function accentStyleOf(tokens: BrandingAccentTokens): string {
  return (['dark', 'light'] as const)
    .flatMap((theme) => [
      `--brand-${theme}-primary:${tokens[theme].primary}`,
      `--brand-${theme}-primary-foreground:${tokens[theme].primaryForeground}`,
      `--brand-${theme}-primary-strong:${tokens[theme].primaryStrong}`,
      `--brand-${theme}-ring:${tokens[theme].ring}`,
    ])
    .join(';');
}
