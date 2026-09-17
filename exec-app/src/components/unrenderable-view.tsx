/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

/**
 * The shell was handed a view it has no renderer for (G5b).
 *
 * This is the arm that was missing, and it is the real defect under the type
 * problem. `submenuGroups` cast every pack-declared id with `view.id as
 * NavigationId`, and the render `switch` had no `default`. So a specialty that
 * declared a screen this console could not draw produced an id that
 * type-checked, matched no `case`, fell out of the switch — and React rendered
 * `undefined`. The operator got a selected tab above a blank workspace, with
 * nothing anywhere in the product saying why.
 *
 * A blank panel and "this console cannot draw this screen" are opposite
 * messages, and the bug was that they were indistinguishable. So this names the
 * id: the id is the one piece of information that tells whoever reads it which
 * declaration to go and fix.
 *
 * It renders standalone on purpose — no props beyond the id, no context, no
 * data fetch — because it has to work in the situation where everything else
 * about the view is unknown.
 */
export default function UnrenderableView({ id }: { id: string }) {
  return (
    <section className="panel unrenderable-view" role="alert">
      <header className="panel-head">
        <div>
          <h1>This console cannot draw this view</h1>
          <p className="muted">
            Something navigated to <code>{id}</code>, and nothing in this build renders it.
          </p>
        </div>
      </header>
      <div className="unrenderable-detail">
        <p>
          A specialty draws its own pages by declaring them: an <code>id</code>, plus either a{" "}
          <code>kind</code> from the platform&apos;s renderer set or a <code>case</code> arm the shell
          already ships. This id is neither, so there is nothing to draw.
        </p>
        <p className="muted">
          Unrendered view id: <code>{id}</code>
        </p>
      </div>
    </section>
  );
}
