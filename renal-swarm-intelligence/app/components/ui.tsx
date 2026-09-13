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
import { Check, ExternalLink } from "lucide-react";

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "mint" | "amber" | "red" | "blue" | "violet";
}) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export function Metric({
  label,
  value,
  detail,
  tone = "default",
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "mint" | "amber" | "red";
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="metric-topline">
        <span>{label}</span>
        <span className="metric-pulse" aria-hidden="true" />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </>
  );
  return onClick ? <button className={`metric metric-${tone} drillable-surface`} type="button" onClick={onClick} aria-label={`Inspect ${label}`}>{content}</button> : <article className={`metric metric-${tone}`}>{content}</article>;
}

export function SourceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="source-link" href={href} target="_blank" rel="noreferrer">
      <Check size={12} aria-hidden="true" />
      {children}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}

export function ProgressBar({ value, tone = "mint" }: { value: number; tone?: "mint" | "amber" | "red" | "blue" }) {
  return (
    <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <span className={`progress-fill progress-${tone}`} style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} />
    </div>
  );
}

export function EmptyView({ title, description }: { title: string; description: string }) {
  return (
    <section className="empty-view">
      <span className="empty-orbit" aria-hidden="true" />
      <Eyebrow>Platform module</Eyebrow>
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  );
}
