# Design tokens, theme and type

**AnantState** is the design system for both consoles. One token set drives
everything: `admin-ui/index.html` (`<style id="shell-base">`) and
`exec-app/src/globals.css` declare the **same core variable names**, and
`exec-app/src/tailwind.css` points its `@theme` at them rather than duplicating
literals — so a colour is defined once and every `var(--x)`, Tailwind utility and
component rule follows.

Each console also declares a few names of its own idiom, which is not a token set
in its own right but is worth knowing before you add a rule:

| Concept | exec-app | admin-ui |
|---|---|---|
| text on an accent fill | `--on-accent` | `--primary-foreground` |
| violation | `--rose` | `--bad`, `--rose` |
| pass | `--mint` (no `--good`) | `--good` |
| warning | `--amber` | `--warn`, `--amber` |
| dim labels | `--nav-label`, `--nav-idle`, `--meta-dim`, `--mono-dim`, `--pulse-idle` | Tailwind utilities over `--muted` |
| code surface | `--editor-bg`, `--code-bg` | `--code-bg`, `--code-fg` |
| component kit | — | `--ring`, `--input`, `--popover`, `--secondary`, `--radius` |

See **Known drift** at the end for the handful of values that currently disagree
between the two files.

## Two themes, one attribute

`data-theme` on `<html>` selects the token set in force. Both sets declare the
same names, so switching is an attribute write: no reload, no second stylesheet,
no rule anywhere branches on the theme.

| `data-theme` | Name | Character |
|---|---|---|
| `dark` (default) | **Dark** | The engine room. Deep Obsidian `#0A0D12` base, Midnight Slate `#131822` surfaces, Electric Teal `#00F2FE` signal, Cosmic Violet `#7C3AED` secondary. |
| `light` | **Light** | The enterprise / executive reading surface. Clean Frost `#F8FAFC` base, Pure White `#FFFFFF` surfaces, Deep Infrastructure Blue `#0369A1` signal, Royal Indigo `#4F46E5` secondary. |

| | |
|---|---|
| Where | the sun/moon button in the top bar of **both** consoles |
| Persisted in | `localStorage['hh-theme']`, applied pre-paint |
| Default | `dark` |

Light mode is not "dark with the values inverted". The accents move to a deeper
blue/indigo register that holds contrast on a bright background, where neon teal
cannot; the dim end of the text ramp also flips direction, because on obsidian
dimmer means *darker* and on frost it means *lighter*.

### Light values sit deeper than the palette spec, on purpose

The original palette named Clean Frost `#F8FAFC`, Deep Infrastructure Blue
`#0284C7`, Deterministic Emerald `#059669`, Precision Crimson `#DC2626`. Those are
the **fill** values. Three of them do not survive measurement once they carry
text, so the shipped tokens are one register deeper:

| Spec | Shipped | Why |
|---|---|---|
| `#0284C7` | `#0369A1` | white-on-fill and blue-on-frost were both 4.1:1 — under AA either way. `#0369A1` gives 5.9:1 both ways. |
| `#059669` | `#065F46` | measured **3.1:1 on its own 12% self-tint** (see the pill rule below). |
| `#DC2626` | `#B91C1C` | same reason; a violation pill paints its own tint behind the text. |

Deeper than spec, but the spec's own characters — not a different palette.

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

The canonical value for each token, in both themes. Four values disagree between
the two files — those are listed under **Known drift** at the end, which is
authoritative wherever it overlaps this table.

| Role | Token(s) | Dark | Light |
|---|---|---|---|
| Background | `--bg` | `#0A0D12` | `#F8FAFC` |
| Background, recessed | `--bg-deep` | `#06080B` | `#F1F5F9` |
| Surface / cards | `--surface`, `--card` | `#131822` | `#FFFFFF` |
| Surface, raised | `--surface-2` | `#182029` | `#F8FAFC` |
| Surface, highest | `--surface-3` | `#1E2632` | `#F1F5F9` |
| Borders / grid | `--line`, `--border` | `#1F2937` | `#E2E8F0` |
| Borders, strong | `--line-strong` | `#2B3546` | `#CBD5E1` |
| Primary signal | `--mint`, `--cyan`, `--brand` | `#00F2FE` | `#0369A1` |
| Primary signal, lifted | `--mint-strong` | `#7DF9FF` | `#075985` |
| Secondary | `--violet`, `--brand-2`, `--accent` | `#7C3AED` | `#4F46E5` |
| Text | `--text`, `--fg` | `#F9FAFB` | `#0F172A` |
| Text, muted | `--muted` | `#9CA3AF` | `#475569` |
| Text, faint | `--faint` | `#97A0B0` | `#55606F` |
| Pass / safe | `--good` (admin) | `#10B981` | `#065F46` |
| Warning | `--warn` (admin), `--amber` | `#F59E0B` | `#92400E` |
| Violation | `--bad` (admin), `--rose` | `#F87171` | `#B91C1C` |
| Informational | `--blue` | `#38BDF8` | `#0369A1` |
| Backdrop | `--scrim` | `rgba(6,9,14,.68)` | `rgba(15,23,42,.32)` |
| Elevation | `--shadow` | `0 18px 44px rgba(0,0,0,.5)` | `0 10px 30px rgba(15,23,42,.10)` |

Violation is the one role that does not fully agree between the consoles. Admin
`--bad` and `--rose` are both `#F87171` in dark, because they carry error text as
well as fills; exec's `--rose` is still `#EF4444`, and in light admin's `--rose`
is still `#DC2626`. Only the light `--bad` value, `#B91C1C`, is shared. Both
non-shared values are in the Known drift table.

`--radius` is `0.25rem` in both — crisp and engineered, not pillowy.

`--faint` in dark was lifted from `#6B7280` to `#97A0B0`: at the old value it sat
at 3.4–3.7:1 on obsidian, under AA for the sidebar section labels, timestamps and
metadata it carries.

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
| `--nav-label`, `--meta-dim` | sidebar section labels, metadata | `#8A94A6` | `#64748B` |
| `--nav-idle` | an idle nav item | `#9CA3AF` | `#475569` |
| `--mono-dim` | a de-emphasised readout | `#7DF9FF` | `#0369A1` |
| `--pulse-idle` | an inactive status dot | `#4B5563` | `#CBD5E1` |
| `--tint-mint`, `--tint-soft` | accent-tinted text | `#7DF9FF` / `#A5F3FC` | `#0369A1` |
| `--tint-blue` | informational tinted text | `#7DD3FC` | `#4F46E5` |
| `--violet-soft` | **violet as text** | `#A78BFA` | `#4F46E5` |
| `--danger-soft` | soft violation text | `#FCA5A5` | `#B91C1C` |
| `--warn-soft` | soft warning text | `#FFCE8A` | `#92400E` |
| `--partner-accent` | the embedded RSI panel | `#00F2FE` | `#0369A1` |

Six rules follow from this and are worth keeping. Each one was a defect first.

- **Never hardcode a colour in a component.** The topology graph carried its own
  hex map, so it kept an older palette while everything around it changed and
  could not follow the theme at all. It now draws `fill="var(--mint)"` — SVG
  accepts a `var()`.
- **Text on an accent fill is `var(--on-accent)`**, never `#fff`. On a neon teal
  fill white is unreadable; on a deep blue fill it is required. The same mistake
  on `<option>` was worse: an option inherited `--on-accent` (white in light
  mode) inside the OS-rendered popup, which does not follow our background at
  all, so it had to set its own `color` **and** `background`.
- **Muted text inside a filled control must invert.** `--muted` is tuned against
  the page background, so a count inside an active filter chip is invisible.
  Hence the `.btn-primary .muted` rule.
- **A tag's text must be the same hue as its own tint.** `.tag-blue` painted
  `--tint-blue`'s text, which in dark was *violet*: violet on a blue tint,
  **2.6:1** — a real bug in both themes, not a light-mode one. `.tag-violet` had
  the mirror problem. Each tag now takes its text from its own token.
- **A pill's self-tint costs ~half a point of contrast.** A pill sets its own
  12% tint as the background, so a status colour has to clear AA *on the tint*,
  not only on the base surface. This is why the state colours are deeper than
  the palette spec.
- **A dark value can be a fill but not text.** `--violet` `#7C3AED` is a good
  fill at 3.03:1 and a poor caption; `--violet-soft` exists so violet **text**
  has somewhere legible to go. Dark `--bad`/`--rose` were lifted from `#EF4444`
  to `#F87171` for the same reason, with `--destructive-foreground` moved to
  dark ink so a red button stays readable against its own fill.

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

A screenshot cannot show that a shade drifted or that one label became illegible,
and one audit is not enough. **Two** checks are needed, because they find
different defects.

### 1. Text contrast — the visible failures

Walk the DOM; for every leaf text node take `getComputedStyle().color`, composite
the full ancestor `background-color` stack back-to-front with alpha blending, and
compute the WCAG ratio. Report anything under **4.5:1** (AA for normal text).

Two caveats that otherwise produce false positives:

- an element whose ancestor paints a `background-image` (a gradient) reports the
  surface *behind* it — skip it;
- `color(srgb r g b / a)` returns **0–1 floats, not 0–255**. Read it as floats or
  every such colour looks near-black.

### 2. Dark backgrounds — the failures this misses, and the important one

A panel that stays dark in light mode **passes** check 1: light text on a dark
panel measures a healthy 6:1. The bug is not contrast, it is that the background
should not be dark at all. So also scan the stylesheet for rules whose
`background` is a dark literal — excluding `--token` lines, or you flag the dark
theme's own declarations.

Threshold dark detection on **relative luminance (< 0.18)**, not on the max RGB
channel. A max-channel test of `< 70` missed `.avatar` at `#20483c` (max channel
72) — a dark green block sitting on frost, which a user could see and the scanner
could not.

This check found 18 rules across these selectors, all of them now tokens:
`.panel`, `.ecosystem-metric`, `.esa-reco`, `.workflow-drawer`, `.loop-step`,
`.state-card`, `.graph-panel`, the graph search and legend controls, `.floor-plan`,
`.admin-form-grid` inputs, `.admin-stage-footer`, `.regulatory-banner` and both
scrims. Flatten translucent panels onto tokens instead of literals:

| Was | Now |
|---|---|
| `rgba(13,18,24,.9)`, `#0E131B`, `#101826` | `var(--surface)` |
| `rgba(8,11,16,.92)` (the drawer footer) | `var(--surface-2)` |
| `rgba(6,9,14,.68)` (scrims) | `var(--scrim)` |

### Reload before you believe a measurement

`/exec` serves `exec-app/dist`, so a rebuild **and** a reload are required. admin-ui
is served straight from disk with no build step, but the browser still holds the
document it loaded: a probe run after editing `index.html` reported
`--faint: #6B7280` while the file said `#97A0B0`. That is a stale document, not a
token bug, and it cost three tool calls to spot.

### Measured state

Zero text below 4.5:1 in **both** themes, and zero dark background declarations
remaining, across:

| Console | Surfaces |
|---|---|
| exec | My Work, Swarm control, Outcome command, Clinical protocols, Platform admin |
| admin-ui | My Work, Platform agents, Measures, Platform cohorts, Governance, Anant Trajectory, System, Platform, dashboard |

## Known drift

Four values currently differ between the two files. Both ends of each pair measure
above AA, so this is untidiness rather than a defect — but it is drift, and the
doc would be lying if it claimed one value:

| Token | `exec-app/src/globals.css` | `admin-ui/index.html` |
|---|---|---|
| light `--amber` | `#92400E` | `#B45309` |
| light `--rose` | `#B91C1C` | `#DC2626` |
| dark `--rose` | `#EF4444` | `#F87171` |
| light `--warn-soft` | `#92400E` | `#B45309` |

Unifying them means moving admin-ui to the deeper values (each step only
*increases* contrast on frost), then re-running audit 1 on admin-ui light to
confirm nothing that uses them as a fill regressed.

## Adding a third theme

1. Copy the `:root[data-theme="light"]` block in `exec-app/src/globals.css` and
   again in `admin-ui/index.html`, give it a new name, change only values.
   admin-ui needs its own copies of the names from the per-console table near the
   top — it does not read exec's block.
2. Add the name to `ThemeName` in `exec-app/src/lib/theme.ts` and to both
   bootstraps: the inline `<head>` script in `admin-ui/index.html` and
   `FALLBACK` in `exec-app/vite/theme-bootstrap.ts`.
3. Run **both** audits above. A new theme is not done when it looks right; it is
   done when check 1 finds no text under 4.5:1 and check 2 finds no dark
   background left behind.

No component needs touching — no component knows a colour. If one does, that is
the bug.
