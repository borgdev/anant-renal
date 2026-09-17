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
 * The shell's OWN destinations — the CLOSED half (G5b).
 *
 * This used to be one union carrying both halves, and it listed `anemia`,
 * `mbd`, `nutrition`, `vascular-access` and the rest of ONE specialty's pages
 * by name. So "the platform knows about renal" was not an opinion about the
 * code — it was a union member, and adding a specialty meant adding a member
 * and a `case` arm.
 *
 * What belongs here is exactly what the sidebar renders and
 * `switch (activeNav)` dispatches. Nothing else may join it, and the reason to
 * keep it small is that this is the only vocabulary the shell can be *exhaustive*
 * over — every member is a screen the console is obliged to draw for every lens,
 * every specialty and every deployment.
 *
 * `protocols` is the one id that is genuinely the shell's: the Clinical
 * protocols hub, the sidebar entry the specialty strip hangs off. The views
 * *inside* that strip belong to the packs and are `SpecialtyViewId`.
 */
export type PlatformNavId =
  | "my-work"
  | "ecosystem"
  | "agents"
  | "command"
  | "patient"
  | "protocols"
  | "facility"
  | "assessments"
  | "intelligence"
  | "executive"
  | "cms"
  | "assurance"
  | "platform";

/**
 * A specialty's own word for its own page — the OPEN half.
 *
 * Deliberately `string`, and the openness is the capability rather than a
 * concession. The shell cannot enumerate the screens of specialties it has never
 * been told about, so a closed union here would mean the platform's vocabulary
 * grows by one member per pack installed — which is precisely the coupling that
 * made the eleven renal pages part of the shell in the first place.
 *
 * A pack declares its pages in its manifest; the shell renders them by
 * consulting that declaration. Nothing has to be edited here to add a specialty.
 */
export type SpecialtyViewId = string;

/**
 * Where a navigation may go — either half.
 *
 * The type `onNavigate` takes. Open BECAUSE navigation is open: a component
 * hands back an id it was given, and it was given one by the shell, which got
 * it from a pack. Narrowing callers to `PlatformNavId` would make every
 * specialty page unreachable.
 *
 * What the split buys is that these two questions become separate and therefore
 * checkable — "is this the shell's own destination?" and "is this a specialty's
 * page?" — and `tests/navigation-ids.test.ts` checks them in both directions.
 */
export type NavTarget = PlatformNavId | SpecialtyViewId;

export type OutcomeStatus = "new" | "review" | "ready" | "resolved";

export interface OutcomeEpisode {
  id: string;
  title: string;
  patient: string;
  patientId: string;
  facility: string;
  status: OutcomeStatus;
  urgency: "critical" | "high" | "watch";
  due: string;
  confidence: number;
  signals: string[];
  recommendation: string;
  owner: string;
  evidenceCount: number;
  actionClass: "A" | "B" | "C" | "D";
}

export interface TraceSpan {
  id: string;
  label: string;
  system: string;
  duration: string;
  status: "ok" | "review" | "blocked";
  detail: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type: "enterprise" | "division" | "region" | "facility" | "patient" | "assessment" | "signal" | "cluster" | "cell" | "policy" | "action" | "intervention" | "outcome" | "measure" | "source";
  x: number;
  y: number;
  z: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}
