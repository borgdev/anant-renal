# Design tokens, palettes and type

One token set drives both consoles. `admin-ui/index.html` (`<style id="shell-base">`)
and `exec-app/src/globals.css` declare the **same variable names**, and
`exec-app/src/tailwind.css` points its `@theme` at them rather than duplicating
literals — so a colour is defined once and every `var(--x)`, Tailwind utility and
component rule follows.

## Two palettes, one attribute

`data-palette` on `<html>` selects the token set in force. Both sets declare the
same names, so switching is an attribute write: no reload, no second stylesheet,
no dead code.

| `data-palette` | Name in the UI | Character |
|---|---|---|
| `anantstate` | **AnantState** | Deep Obsidian `#0A0D12` base, Electric Teal `#00F2FE` signal, Cosmic Violet `#7C3AED` secondary |
| `slate` | **Anant Slate** | the original Anant tokens — `#0c1117` base, `#98aec0` accent |

| | |
|---|---|
| Where | the palette button in the top bar of **both** consoles |
| Persisted in | `localStorage['hh-palette']`, applied pre-paint |
| Default | `anantstate` (see below to change it) |

The attribute is set **before the first paint**, so a cold load never flashes the
other palette. admin-ui does this in its `<head>` bootstrap; exec-app injects the
same snippet from `exec-app/vite/palette-bootstrap.ts`, because applying it from
the module graph happens after the stylesheet has already painted.

### Reverting to the original colours

One click — the button names the palette it will switch to. Nothing else needs to
change; the previous palette is fully intact, not deleted.

To make the original the **default** again, change the constant in each console
(they are independent, so either console can lead):

- `admin-ui/index.html` → `DEFAULT_PALETTE` in the `<head>` bootstrap script
- `exec-app/src/lib/palette.ts` → `DEFAULT_PALETTE`
- `exec-app/vite/palette-bootstrap.ts` → `FALLBACK` (and the `KNOWN` allow-list)

Set all three to `'slate'`. Users who already chose a palette keep their choice.

## AnantState token map

| Role | Token(s) | Value |
|---|---|---|
| Background (base) | `--bg` | `#0A0D12` Deep Obsidian |
| Surface / cards | `--surface`, `--card` | `#131822` Midnight Slate |
| Borders / grid | `--line`, `--border` | `#1F2937` Steel Stroke |
| Primary signal | `--mint`, `--cyan`, `--brand`, `--ring` | `#00F2FE` Electric Teal |
| Secondary | `--violet`, `--brand-2`, `--accent` | `#7C3AED` Cosmic Violet |
| Text | `--text`, `--fg` | `#F9FAFB` Pure Crisp White |
| Text (muted) | `--muted` | `#9CA3AF` Cool Slate Gray |
| Pass / safe | `--good` | `#10B981` Deterministic Emerald |
| Warning | `--warn`, `--amber` | `#F59E0B` |
| Violation | `--bad`, `--rose` | `#EF4444` Precision Crimson |

`--blue` (`#38BDF8`) carries informational state (proposed / validated /
coordinating) and stays inside the cyan family rather than adding a hue.

### Visual rules carried by the palette

The palette guidance is explicit that deterministic software should read as
engineered rather than pillowy, so the AnantState scope also:

- **removes the base gradients** — `body`, `.metric`, `.brand-mark` and
  `.sidebar-status` become solid surfaces;
- **tightens the radius** to `0.25rem` and uses opaque 1px borders;
- **adds the monospace accent** (below).

Slate keeps its radial wash, its `0.5rem` radius and its gradient brand mark —
which is why those overrides live inside the palette scope rather than in the
base rules.

## Typography

```css
--sans: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
--mono: "JetBrains Mono", "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
```

Plain stacks on purpose: the preferred face is used when the operator has it
installed and the system face otherwise, so there is **no webfont request, no
FOUT and no offline breakage**. Every existing readout already asked for
`ui-monospace`; those declarations now lead with JetBrains Mono / SF Mono.

The monospace accent is applied to **data, state keys and metrics, never prose**
— a sentence set in monospace reads as broken, not engineered:

| Console | Targets |
|---|---|
| exec-app | `.metric > strong`, `.metric-topline`, `.metric > small`, `.eyebrow`, `.brand-lockup small` |
| admin-ui | `code`, `.num`, `.count`, `.kv .k`, `.kv-row .k`, `.catalog-count`, `.activity-time`, `th` (uppercase, letter-spaced) |

Both also set `font-variant-numeric: tabular-nums` so digits align in a column.

## Accent tints are tokens, not literals

Two consoles × a year of iteration had left ~450 translucent accent literals
(`rgba(152,174,192,.14)` and friends) that no palette could reach. They are now
derived from the accent tokens:

```css
/* was: rgba(152,174,192, .14) */
background: color-mix(in srgb, var(--mint) 14%, transparent);
```

`color-mix(in srgb, <opaque accent> P%, transparent)` is exactly
`rgba(<same rgb>, P/100)`, so the slate rendering is unchanged while the accent
follows the palette. `--meta-dim`, `--mono-dim`, `--nav-label`, `--tint-mint`
and the other dim/tint tokens exist for the same reason — each carries the
literal it replaced, so the refactor introduced no visual delta in slate.

## Adding a third palette

1. Copy the `:root[data-palette="anantstate"]` block in `exec-app/src/globals.css`
   and again in `admin-ui/index.html`, give it a new name, change only values.
2. Add the name to `KNOWN` in `exec-app/vite/palette-bootstrap.ts`, to the
   allow-list in the `admin-ui/index.html` `<head>` script, and to
   `PALETTE_LABEL` in `exec-app/src/lib/palette.ts`.

Nothing else needs touching — no component knows a colour.
