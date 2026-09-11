# Design tokens, theme and type

**AnantState** is the design system for both consoles. One token set drives
everything: `admin-ui/index.html` (`<style id="shell-base">`) and
`exec-app/src/globals.css` declare the **same variable names**, and
`exec-app/src/tailwind.css` points its `@theme` at them rather than duplicating
literals — so a colour is defined once and every `var(--x)`, Tailwind utility and
component rule follows.

## Two themes, one attribute

`data-theme` on `<html>` selects the token set in force. Both sets declare the
same names, so switching is an attribute write: no reload, no second stylesheet,
no rule anywhere branches on the theme.

| `data-theme` | Name | Character |
|---|---|---|
| `dark` (default) | **Dark** | The engine room. Deep Obsidian `#0A0D12` base, Midnight Slate `#131822` surfaces, Electric Teal `#00F2FE` signal, Cosmic Violet `#7C3AED` secondary. |
| `light` | **Light** | The enterprise / executive reading surface. Clean Frost `#F8FAFC` base, Pure White `#FFFFFF` surfaces, Deep Infrastructure Blue `#0284C7` signal, Royal Indigo `#4F46E5` secondary. |

| | |
|---|---|
| Where | the sun/moon button in the top bar of **both** consoles |
| Persisted in | `localStorage['hh-theme']`, applied pre-paint |
| Default | `dark` |

Light mode is not "dark with the values inverted". The accents move to a deeper
blue/indigo register that holds contrast on a bright background, where neon teal
cannot; the dim end of the text ramp also flips direction, because on obsidian
dimmer means *darker* and on frost it means *lighter*.

### Changing the default theme

- `admin-ui/index.html` → the `<head>` bootstrap script
- `exec-app/src/lib/theme.ts` → `DEFAULT_THEME`
- `exec-app/vite/theme-bootstrap.ts` → `FALLBACK`

The attribute is set **before the first paint**, so a cold load never flashes the
other theme. admin-ui does this with an inline `<head>` script; exec-app cannot
set it from the module graph (the stylesheet is already painting by then), so the
same snippet is injected by `exec-app/vite/theme-bootstrap.ts` via Vite's
`transformIndexHtml`. That also keeps `index.html` free of a script whose
fallback has to agree with `theme.ts`.

## Token map

| Role | Token(s) | Dark | Light |
|---|---|---|---|
| Background | `--bg`, `--bg-deep` | `#0A0D12` | `#F8FAFC` |
| Surface / cards | `--surface`, `--card` | `#131822` | `#FFFFFF` |
| Borders / grid | `--line`, `--border` | `#1F2937` | `#E2E8F0` |
| Primary signal | `--mint`, `--cyan`, `--brand` | `#00F2FE` | `#0284C7` |
| Secondary | `--violet`, `--brand-2`, `--accent` | `#7C3AED` | `#4F46E5` |
| Text | `--text`, `--fg` | `#F9FAFB` | `#0F172A` |
| Text muted / faint | `--muted`, `--faint` | `#9CA3AF` / `#6B7280` | `#475569` / `#64748B` |
| Pass / safe | `--good` | `#10B981` | `#059669` |
| Warning | `--warn`, `--amber` | `#F59E0B` | `#B45309` |
| Violation | `--bad`, `--rose` | `#EF4444` | `#DC2626` |
| Informational | `--blue` | `#38BDF8` | `#0369A1` |

`--radius` is `0.25rem` in both — crisp and engineered, not pillowy.

## The rest of the tokens exist so no rule needs the theme

A theme can only work if **every** colour resolves through a token. Two consoles
and a year of iteration had left ~600 literals: translucent accent tints
(`rgba(152,174,192,.14)`), light "lift" tints (`rgba(255,255,255,.02)`), soft
status text (`#ff9b9b`, `#9fd7bb`), dim label greys, and dark-on-accent text
(`#04120d`). All of them are now derived:

```css
/* was: rgba(152,174,192, .14) — the accent, at 14% */
background: color-mix(in srgb, var(--mint) 14%, transparent);
/* was: rgba(255,255,255, .02) — a light lift on obsidian */
background: color-mix(in srgb, var(--elevate) 2%, transparent);
```

`color-mix(in srgb, <opaque colour> P%, transparent)` is exactly
`rgba(<same rgb>, P/100)`, so each reproduces its literal in the theme that
literal came from and re-resolves in the other.

| Token | Purpose | Dark | Light |
|---|---|---|---|
| `--elevate` | a lift above the surface | `#FFFFFF` | `#0F172A` |
| `--recess` | a recess below the surface | `#000000` | `#0F172A` |
| `--on-accent` | text set **on** an accent fill | `#0A0D12` | `#FFFFFF` |
| `--editor-bg`, `--code-bg` | code and log surfaces | `#0E131B` | `#F1F5F9` |
| `--nav-label`, `--nav-idle`, `--meta-dim`, `--mono-dim`, `--pulse-idle` | dim labels and metadata | | |
| `--tint-mint`, `--tint-soft`, `--tint-blue` | accent-tinted text | | |
| `--danger-soft`, `--warn-soft` | soft status text | | |
| `--partner-accent` | the embedded RSI panel | `#00F2FE` | `#0284C7` |

Three rules follow from this and are worth keeping:

- **Never hardcode a colour in a component.** The topology graph used to carry
  its own hex map, so it kept an older palette while everything around it changed
  and could not follow the theme at all. It now draws `fill="var(--mint)"` — SVG
  accepts a `var()`.
- **Text on an accent fill is `var(--on-accent)`**, never `#fff`. On a neon teal
  fill white is unreadable; on a deep blue fill it is required.
- **Muted text inside a filled control must invert.** `--muted` is tuned against
  the page background, so a count inside an active filter chip is invisible.
  Hence the `.btn-primary .muted` rule.

## Typography

```css
--sans: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
--mono: "JetBrains Mono", "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
```

Plain stacks on purpose: the preferred face is used when the operator has it
installed and the system face otherwise, so there is **no webfont request, no
FOUT and no offline breakage**.

The monospace accent is applied to **data, state keys and metrics, never prose**
— a sentence set in monospace reads as broken, not engineered:

| Console | Targets |
|---|---|
| exec-app | `.metric > strong`, `.metric-topline`, `.metric > small`, `.eyebrow`, `.brand-lockup small` |
| admin-ui | `code`, `.num`, `.count`, `.kv .k`, `.kv-row .k`, `.catalog-count`, `.activity-time`, `th` (uppercase, letter-spaced) |

Both also set `font-variant-numeric: tabular-nums` so digits align in a column.

## Verifying a theme

A screenshot cannot show that a shade drifted or that one label became illegible.
Measure instead: walk the DOM, take each text node's `color` and its first opaque
ancestor `background-color`, and compute the WCAG contrast ratio. Two caveats
that otherwise produce false positives — an element whose ancestor paints a
`background-image` (a gradient) reports the surface behind it, and
`color(srgb r g b / a)` returns 0–1 floats, not 0–255.

Measured state on My Work, Swarm control, the measure catalog, the realm browser
and the cohort studio, in **both** themes: no text below 3.5:1.

## Adding a third theme

1. Copy the `:root[data-theme="light"]` block in `exec-app/src/globals.css` and
   again in `admin-ui/index.html`, give it a new name, change only values.
2. Add the name to `ThemeName` in `exec-app/src/lib/theme.ts` and to both
   bootstraps.

Nothing else needs touching — no component knows a colour.
