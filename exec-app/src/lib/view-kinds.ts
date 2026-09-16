/**
 * The view KINDS this shell has a renderer for.
 *
 * Declared here, in a module with no React import, rather than inline in the
 * shell's registry, for one reason: `tests/view-kinds.test.ts` asserts this list
 * equals `PLATFORM_VIEW_KINDS` in `src/control-plane/pack-contract.ts`. The two
 * are a contract across a process boundary — the platform decides what a pack may
 * DECLARE, the shell decides what it can DRAW — and a contract that lives only in
 * a `Record<string, Component>` cannot be checked by anything but a human reading
 * both files.
 *
 * So the registry in `app.tsx` is typed from this list, which means the compiler
 * refuses a renderer for a kind the platform would reject, and refuses to let a
 * kind sit here with no renderer. Adding a kind is therefore two edits in two
 * places, on purpose: the shell must actually be able to draw it.
 *
 * The list starts with one. That is the discipline from the remaining-work
 * analysis — a kind is justified when a SECOND specialty needs it, and kinds are
 * promoted from real packs rather than designed up front. Seven of the eleven
 * renal views looked like candidates for `ranked-actions`, and on migration they
 * turned out to be compositions: the renal protocol pages are a KPI header, a
 * trajectory panel, a board and a governance table, not a board. A kind describes
 * a PANEL; a page is a composition of kinds, and pretending otherwise would have
 * deleted seven working pages to make a table look tidier. So the renal eleven
 * stay on the id vocabulary and this is what a NEW specialty composes from.
 */
export const VIEW_RENDERER_KINDS = ["ranked-actions"] as const;

export type ViewRendererKind = (typeof VIEW_RENDERER_KINDS)[number];
