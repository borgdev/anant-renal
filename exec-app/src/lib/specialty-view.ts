/**
 * What a lens declares about one screen (G5).
 *
 * `id` is the specialty's own word for the view. `kind` + `source` are what let
 * the shell draw it without knowing the specialty exists: the kind selects a
 * renderer, the source says where the data is. A view that declares no kind is
 * still legal — it is the pre-G5 vocabulary, and the shell's own `case` arms are
 * its renderer.
 */
export type SpecialtyViewDecl = {
  id: string;
  label: string;
  /** One of `VIEW_RENDERER_KINDS`, or absent for the id-based compatibility path. */
  kind?: string;
  /** Where the view's data comes from. Declared by the pack: the id is the
   *  specialty's vocabulary and the route is the pack's, and the shell could not
   *  derive one from the other without being told the specialty exists. */
  source?: string;
};
