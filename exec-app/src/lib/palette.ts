// ---------------------------------------------------------------------------
// Palette bootstrap — runs before React mounts so the correct token set is in
// force for the very first frame (no flash of the other palette).
//
// `data-palette` on <html> selects which token set applies; both sets live in
// globals.css and declare the SAME variable names, so switching is an attribute
// write — the previous palette is always one click away, with no second build.
// The AdminState console keeps the same values so the two stay identical.
// ---------------------------------------------------------------------------
export type PaletteName = "anantstate" | "slate";

/** Flip to "slate" to ship the original Anant colours as the default. */
export const DEFAULT_PALETTE: PaletteName = "anantstate";

export const PALETTE_LABEL: Record<PaletteName, string> = {
  anantstate: "AnantState",
  slate: "Anant Slate",
};

const STORAGE_KEY = "hh-palette";

export function readPalette(): PaletteName {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "slate" || raw === "anantstate") return raw;
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return DEFAULT_PALETTE;
}

export function applyPalette(name: PaletteName): void {
  document.documentElement.dataset.palette = name;
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    /* non-fatal: the attribute is already applied for this session */
  }
}

export function otherPalette(name: PaletteName): PaletteName {
  return name === "anantstate" ? "slate" : "anantstate";
}

applyPalette(readPalette());
