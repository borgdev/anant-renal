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

import type { ReactNode } from "react";
import { Eye } from "lucide-react";
import { Eyebrow } from "./ui";

/**
 * Placeholder surface for exec-app modules not yet wired to the harness.
 * Ported from the prototype in a follow-up; the shell stays fully navigable.
 */
export function PlaceholderModule({
  eyebrow,
  title,
  description,
  note,
  onNavigate,
  targetLabel,
  onNavigateTarget,
}: {
  eyebrow: string;
  title: string;
  description: string;
  note: string;
  onNavigate?: () => void;
  targetLabel?: string;
  onNavigateTarget?: ReactNode;
}) {
  return (
    <div className="view-stack placeholder-view">
      <header className="view-heading">
        <div>
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className="heading-actions"><span className="tag tag-violet"><Eye size={11} /> Module incoming</span></div>
      </header>
      <section className="empty-view">
        <span className="empty-orbit" aria-hidden="true" />
        <Eyebrow>Exec console · v2 surface</Eyebrow>
        <h2>{title} is next in the port queue</h2>
        <p>{note}</p>
        {onNavigate && targetLabel ? (
          <button className="button button-primary" type="button" onClick={onNavigate}>{targetLabel} {onNavigateTarget}</button>
        ) : null}
      </section>
    </div>
  );
}
