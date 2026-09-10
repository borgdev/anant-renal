"use client";

// P7 — cross-pack assurance track.
//
// This page is deliberately the opposite of a pack page: it has no clinical
// logic of its own. It reads the durable ledger once, and shows what the whole
// protocol set looks like together — wiring parity, cohort fairness, alert
// burden, and whether the set can be released. Where a measurement cannot be
// made (a slice below the minimum size, an unlabelled alert set, a window with
// no alerts) the page says so rather than showing a reassuring zero.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Activity,
  BadgeCheck,
  Ban,
  ClipboardCheck,
  Gauge,
  Layers,
  RefreshCw,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { Eyebrow, LoadMore, Metric, PanelExpand, ProgressBar, Tag, usePaged } from "./ui";
import {
  assuranceApi,
  CHECK_TONE,
  ENFORCEMENT_LABEL,
  SLICE_TONE,
  VERDICT_TONE,
  hours,
  pct,
  type AssuranceGate,
  type AssuranceOverview,
  type BurdenReport,
  type FairnessReport,
  type ModeSummary,
  type ProtocolAssessment,
  type ProtocolMode,
  type ProtocolModeRecord,
  type RulePacksView,
} from "../lib/assurance";
import type { NavigationId } from "../lib/types";

type Props = { onNavigate?: (id: NavigationId) => void };

type Tab = "wiring" | "fairness" | "burden" | "rules" | "modes";

const TAB_LABELS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: "wiring", label: "Wiring & release", hint: "Is every pack wired the same way, and can this set ship?" },
  { id: "fairness", label: "Fairness slices", hint: "Do the cohorts the packs serve break down evenly?" },
  { id: "burden", label: "Alert burden", hint: "What does the alert volume cost the people reading it?" },
  { id: "rules", label: "Guideline rules", hint: "The KDIGO/KDOQI/CDC thresholds as cited, executable code." },
  { id: "modes", label: "Surfacing modes", hint: "Which packs are active, which are running silent." },
];

const SLICE_LABEL: Record<string, string> = {
  age: "Age",
  sex: "Sex",
  vintage: "Dialysis vintage",
  access: "Vascular access",
};

function verdictTag(verdict: string) {
  const tone = VERDICT_TONE[verdict as keyof typeof VERDICT_TONE] ?? "default";
  return <Tag tone={tone as "mint" | "amber" | "red"}>{verdict}</Tag>;
}

function StatusDot({ status }: { status: string }) {
  return <span className={`assurance-dot dot-${status}`} aria-label={status} />;
}

/* ---------- wiring & release ---------- */

function ProtocolRow({ pack, onNavigate }: { pack: ProtocolAssessment; onNavigate?: (id: NavigationId) => void }) {
  const failing = pack.checks.filter((c) => c.status === "fail");
  const warning = pack.checks.filter((c) => c.status === "warn");
  return (
    <article className="panel assurance-pack">
      <header className="panel-head">
        <div>
          <Eyebrow>{pack.slice ?? "pack"} · {pack.ledger.modelId}</Eyebrow>
          <h3>{pack.protocol}</h3>
        </div>
        <div className="assurance-pack-tags">
          {verdictTag(pack.verdict)}
          <Tag tone={pack.mode === "active" ? "mint" : "neutral"}>{pack.mode}</Tag>
          <PanelExpand />
        </div>
      </header>

      <div className="assurance-check-list">
        {pack.checks.map((check) => (
          <div className="assurance-check" key={check.id}>
            <StatusDot status={check.status} />
            <div>
              <strong>{check.label}</strong>
              <p>{check.detail}</p>
            </div>
            <Tag tone={CHECK_TONE[check.status] as "mint" | "amber" | "red" | "neutral"}>{check.status}</Tag>
          </div>
        ))}
      </div>

      <footer className="assurance-pack-foot">
        <span>{pack.rules} rules{pack.ruleGaps.length > 0 ? ` · missing ${pack.ruleGaps.join(", ")}` : ""}</span>
        <span>{pack.ledger.redTeamPassedScenarios}/{pack.ledger.redTeamScenarios} red-team scenarios pass</span>
        <span>{pack.coveredPatients} covered · {pack.flaggedPatients} flagged</span>
        {pack.routes && onNavigate ? (
          <button className="assurance-link" type="button" onClick={() => onNavigate("protocols")}>
            open {pack.protocol} pack
          </button>
        ) : null}
      </footer>

      {(failing.length > 0 || warning.length > 0) ? (
        <ul className="assurance-pack-notes">
          {failing.map((c) => <li key={c.id} className="is-blocking">{c.detail}</li>)}
          {warning.map((c) => <li key={c.id}>{c.detail}</li>)}
        </ul>
      ) : null}
    </article>
  );
}

function WiringTab({
  overview,
  gate,
  onNavigate,
  onAction,
  actionBusy,
  actionNotice,
}: {
  overview: AssuranceOverview;
  gate: AssuranceGate | null;
  onNavigate?: (id: NavigationId) => void;
  onAction: (kind: "red-team" | "drift") => void;
  actionBusy: boolean;
  actionNotice: string | null;
}) {
  const packs = usePaged(overview.protocols, 4, overview.generatedAt);
  const missingMdr = gate?.mdrFiles.filter((m) => !m.materialised) ?? [];
  const redTeamCheck = gate?.checks.find((c) => c.id === "red-team");
  const driftCheck = gate?.checks.find((c) => c.id === "drift");

  return (
    <div className="assurance-stack">
      <section className="metric-grid">
        <Metric
          label="Release decision"
          value={overview.decision}
          detail={`${overview.totals.ship} ship · ${overview.totals.hold} hold · ${overview.totals.block} block`}
          tone={VERDICT_TONE[overview.decision]}
        />
        <Metric
          label="Packs wired"
          value={`${overview.totals.protocols}`}
          detail={`${overview.totals.rules} cited rules · ${overview.totals.artifactPass} artefacts meet target`}
        />
        <Metric
          label="Open findings"
          value={`${overview.totals.openFindings}`}
          detail={overview.totals.criticalOpen > 0
            ? `${overview.totals.criticalOpen} critical — the set cannot ship`
            : "no critical findings across the set"}
          tone={overview.totals.criticalOpen > 0 ? "red" : overview.totals.openFindings > 0 ? "amber" : "mint"}
        />
        <Metric
          label="Running silent"
          value={`${overview.totals.silentPacks}/${overview.totals.protocols}`}
          detail="a silent pack computes and records, but surfaces nothing"
          tone={overview.totals.silentPacks === overview.totals.protocols ? "amber" : "default"}
        />
      </section>

      {gate ? (
        <section className="panel">
          <header className="panel-head">
            <div>
              <Eyebrow>release gate · reads the durable ledger</Eyebrow>
              <h2>{gate.summary}</h2>
            </div>
            <div className="assurance-pack-tags">
              {verdictTag(gate.decision)}
              <PanelExpand />
            </div>
          </header>

          {/* The gate names warnings; these run the packs that own them. */}
          <div className="assurance-mode-actions">
            <button
              className="assurance-button"
              type="button"
              disabled={actionBusy || redTeamCheck?.status === 'pass'}
              onClick={() => onAction("red-team")}
            >
              <ShieldCheck size={14} /> Run every pack's red team
            </button>
            <button
              className="assurance-button ghost"
              type="button"
              disabled={actionBusy || driftCheck?.status === 'pass'}
              onClick={() => onAction("drift")}
            >
              <Activity size={14} /> Snapshot drift for every pack
            </button>
            {redTeamCheck?.status === 'pass' && driftCheck?.status === 'pass' ? (
              <span className="assurance-note">Every pack has a passing red-team run and a fresh drift snapshot.</span>
            ) : null}
          </div>
          {actionNotice ? <p className="assurance-note">{actionNotice}</p> : null}
          <div className="assurance-check-list">
            {gate.checks.map((check) => (
              <div className="assurance-check" key={check.id}>
                <StatusDot status={check.status} />
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.detail}</p>
                </div>
                <Tag tone={CHECK_TONE[check.status] as "mint" | "amber" | "red" | "neutral"}>{check.status}</Tag>
              </div>
            ))}
          </div>
          <div className="assurance-split">
            <div>
              <Eyebrow>per-protocol MDR files this release would carry</Eyebrow>
              <ul className="assurance-mdr">
                {gate.mdrFiles.map((file) => (
                  <li key={file.protocol}>
                    <StatusDot status={file.materialised ? "pass" : "warn"} />
                    <span>{file.protocol}</span>
                    <code>{file.kind}</code>
                  </li>
                ))}
              </ul>
              {missingMdr.length > 0 ? (
                <p className="assurance-note">
                  {missingMdr.length} boundary document{missingMdr.length === 1 ? " is" : "s are"} generated on demand and not yet
                  materialised — the gate records them as absent rather than assuming them.
                </p>
              ) : null}
            </div>
            <div>
              <Eyebrow>what gates the set</Eyebrow>
              {gate.blockers.length === 0 && gate.warnings.length === 0 ? (
                <p className="assurance-note">No blockers and no warnings. The set is releasable.</p>
              ) : (
                <ul className="assurance-pack-notes">
                  {gate.blockers.map((b) => <li key={b} className="is-blocking">{b}</li>)}
                  {gate.warnings.slice(0, 8).map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
            </div>
          </div>
        </section>
      ) : null}

      <div className="assurance-pack-grid">
        {packs.visible.map((pack) => <ProtocolRow key={pack.protocol} pack={pack} onNavigate={onNavigate} />)}
      </div>
      <LoadMore shown={packs.visible.length} total={overview.protocols.length} onMore={packs.showMore} label="packs" />
    </div>
  );
}

/* ---------- fairness ---------- */

function FairnessTab({ report, cohortN }: { report: FairnessReport; cohortN: number }) {
  const [dimension, setDimension] = useState<string>(report.dimensions[0]?.dimension ?? "age");
  const active = useMemo(
    () => report.dimensions.find((d) => d.dimension === dimension) ?? report.dimensions[0],
    [report.dimensions, dimension],
  );
  const slices = usePaged(active?.slices ?? [], 12, dimension);

  if (!active) return null;

  return (
    <div className="assurance-stack">
      <section className="metric-grid">
        <Metric
          label="Cohort"
          value={`${cohortN}`}
          detail={`minimum slice size ${report.reference.minSliceN} — below it no claim is made`}
        />
        <Metric
          label="Coverage tolerance"
          value={pct(report.reference.coverageGapTolerance)}
          detail="a slice may trail the rest of the cohort by at most this"
          tone="default"
        />
        <Metric
          label="Over-flag tolerance"
          value={pct(report.reference.flagRateGapTolerance)}
          detail="beyond it the slice is a burden watch, not a safety breach"
          tone="default"
        />
      </section>

      <div className="assurance-tabs" role="tablist" aria-label="Slice dimension">
        {report.dimensions.map((d) => (
          <button
            className={`assurance-tab ${d.dimension === dimension ? "is-active" : ""}`}
            key={d.dimension}
            type="button"
            role="tab"
            aria-selected={d.dimension === dimension}
            onClick={() => setDimension(d.dimension)}
          >
            <span>{SLICE_LABEL[d.dimension] ?? d.dimension}</span>
            <small>{d.verdict}</small>
          </button>
        ))}
      </div>

      <section className="panel">
        <header className="panel-head">
          <div>
            <Eyebrow>{SLICE_LABEL[active.dimension] ?? active.dimension}</Eyebrow>
            <h2>
              {active.verdict === "insufficient"
                ? "No slice is large enough to compare."
                : active.verdict === "ok"
                  ? "Every comparable slice is within tolerance."
                  : `${active.verdict} — see the findings below.`}
            </h2>
          </div>
          <div className="assurance-pack-tags">
            <Tag tone={SLICE_TONE[active.verdict] as "mint" | "amber" | "red" | "neutral"}>{active.verdict}</Tag>
            <PanelExpand />
          </div>
        </header>

        <div className="assurance-slice-table" role="table">
          <div className="assurance-slice-head" role="row">
            <span role="columnheader">Slice</span>
            <span role="columnheader">n</span>
            <span role="columnheader">Coverage</span>
            <span role="columnheader">Flag rate</span>
            <span role="columnheader">Verdict</span>
          </div>
          {slices.visible.map((slice) => (
            <div className="assurance-slice-row" role="row" key={slice.slice}>
              <span role="cell">{slice.label}</span>
              <span role="cell">{slice.n}</span>
              <span role="cell">
                <ProgressBar value={slice.coverageRate * 100} tone={slice.coverageRate < active.pooled.coverageRate - report.reference.coverageGapTolerance ? "red" : "mint"} />
                <small>{pct(slice.coverageRate)} ({slice.coveredN}/{slice.n})</small>
              </span>
              <span role="cell">
                <ProgressBar value={slice.flagRate * 100} tone="amber" />
                <small>{pct(slice.flagRate)} ({slice.flaggedN}/{slice.n})</small>
              </span>
              <span role="cell">
                <Tag tone={SLICE_TONE[slice.verdict] as "mint" | "amber" | "red" | "neutral"}>{slice.verdict}</Tag>
              </span>
            </div>
          ))}
        </div>
        <LoadMore shown={slices.visible.length} total={active.slices.length} onMore={slices.showMore} label="slices" />

        {active.insufficientSlices.length > 0 ? (
          <p className="assurance-note">
            Excluded for size: {active.insufficientSlices.join(", ")}. These slices are named here and in the findings —
            an unmeasurable slice is never treated as a passing one.
          </p>
        ) : null}

        {active.findings.length > 0 ? (
          <ul className="assurance-pack-notes">
            {active.findings.map((f) => <li key={f}>{f}</li>)}
          </ul>
        ) : (
          <p className="assurance-note">No findings on this dimension.</p>
        )}
      </section>
    </div>
  );
}

/* ---------- burden ---------- */

function BurdenTab({ report }: { report: BurdenReport }) {
  const rows = usePaged(report.byProtocol, 7, report.window.weeks);
  const unlabelled = report.totals.labelled === 0;

  return (
    <div className="assurance-stack">
      <section className="metric-grid">
        <Metric
          label="Alerts in window"
          value={`${report.totals.alerts}`}
          detail={`${report.patients} patients over ${report.window.weeks} weeks`}
        />
        <Metric
          label="Per patient-week"
          value={`${report.totals.alertsPerPatientWeek}`}
          detail={`ceiling ${report.reference.maxAlertsPerPatientWeek} before it is noise`}
          tone={report.totals.alertsPerPatientWeek > report.reference.maxAlertsPerPatientWeek ? "amber" : "default"}
        />
        <Metric
          label="Review cost"
          value={hours(report.totals.minutes)}
          detail={`${report.reference.minutesPerAlert} min to read + ${report.reference.minutesPerActionable} min to act`}
        />
        <Metric
          label="False positives"
          value={unlabelled ? "unresolved" : pct(report.totals.falsePositiveRate)}
          detail={unlabelled
            ? "no validation labels on any alert — an unmeasured rate is not a good one"
            : `over ${report.totals.labelled} labelled alerts`}
          tone={unlabelled ? "amber" : "default"}
        />
      </section>

      <section className="panel">
        <header className="panel-head">
          <div>
            <Eyebrow>per protocol</Eyebrow>
            <h2>The bill, by pack.</h2>
          </div>
          <div className="assurance-pack-tags">
            <Tag tone={report.verdict === "ok" ? "mint" : report.verdict === "not-measurable" ? "amber" : "red"}>
              {report.verdict}
            </Tag>
            <PanelExpand />
          </div>
        </header>

        <div className="assurance-burden-table" role="table">
          <div className="assurance-burden-head" role="row">
            <span role="columnheader">Pack</span>
            <span role="columnheader">Alerts</span>
            <span role="columnheader">/patient-week</span>
            <span role="columnheader">Dismissed</span>
            <span role="columnheader">Duplicate</span>
            <span role="columnheader">Minutes</span>
            <span role="columnheader">Verdict</span>
          </div>
          {rows.visible.map((row) => (
            <div className="assurance-burden-row" role="row" key={row.protocol}>
              <span role="cell">{row.protocol}</span>
              <span role="cell">{row.alerts}</span>
              <span role="cell">{row.alertsPerPatientWeek}</span>
              <span role="cell">{pct(row.dismissedRate)}</span>
              <span role="cell">{pct(row.duplicateRate)}</span>
              <span role="cell">{Math.round(row.minutes)}</span>
              <span role="cell">
                <Tag tone={row.verdict === "ok" ? "mint" : row.verdict === "watch" ? "amber" : "red"}>{row.verdict}</Tag>
              </span>
            </div>
          ))}
        </div>
        <LoadMore shown={rows.visible.length} total={report.byProtocol.length} onMore={rows.showMore} label="packs" />

        {report.hotspots.length > 0 ? (
          <>
            <Eyebrow>concentration</Eyebrow>
            <ul className="assurance-hotspots">
              {report.hotspots.map((h) => (
                <li key={h.patientId}>
                  <span>{h.patientId}</span>
                  <ProgressBar value={h.share * 100} tone={h.share > 0.25 ? "red" : "blue"} />
                  <small>{h.alerts} alerts · {pct(h.share)}</small>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {report.findings.length > 0 ? (
          <ul className="assurance-pack-notes">
            {report.findings.slice(0, 10).map((f) => <li key={f}>{f}</li>)}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

/* ---------- rules ---------- */

const ENFORCEMENT_TONE: Record<string, "mint" | "amber" | "red" | "blue" | "violet" | "neutral"> = {
  guardrail: "red",
  "coverage-gate": "amber",
  authority: "violet",
  escalation: "blue",
  surveillance: "neutral",
};

function RulesTab({ rules }: { rules: RulePacksView }) {
  const [protocol, setProtocol] = useState<string>("all");
  const filtered = protocol === "all" ? rules.packs : rules.packs.filter((r) => r.protocol === protocol);
  const paged = usePaged(filtered, 14, protocol);

  return (
    <div className="assurance-stack">
      <section className="metric-grid">
        <Metric label="Declared rules" value={`${rules.summary.total}`} detail={`${rules.sources.length} authorities cited`} />
        <Metric
          label="Unenforced"
          value={`${rules.summary.unenforced.length}`}
          detail={rules.summary.unenforced.length === 0
            ? "every rule states where it is enforced"
            : `unbound: ${rules.summary.unenforced.join(", ")}`}
          tone={rules.summary.unenforced.length === 0 ? "mint" : "red"}
        />
        <Metric
          label="Enforcement classes"
          value={`${Object.keys(rules.summary.byEnforcement).length}`}
          detail="guardrail · coverage gate · authority · escalation · surveillance"
        />
        <Metric
          label="Drift protection"
          value="tested"
          detail="every rule resolves its pack constant in tests/rule-packs.test.ts"
          tone="mint"
        />
      </section>

      <section className="panel">
        <header className="panel-head">
          <div>
            <Eyebrow>editions bound into the build</Eyebrow>
            <h2>The guideline copy is code, and it cannot drift.</h2>
          </div>
          <PanelExpand />
        </header>
        <ul className="assurance-editions">
          {rules.editions.map((e) => (
            <li key={`${e.source}:${e.edition}`}>
              <Tag tone="blue">{e.source}</Tag>
              <span>{e.edition}</span>
              <small>{e.rules} rules</small>
            </li>
          ))}
        </ul>
        <p className="assurance-note">{rules.driftCheck}</p>
      </section>

      <div className="assurance-tabs" role="tablist" aria-label="Protocol filter">
        <button
          className={`assurance-tab ${protocol === "all" ? "is-active" : ""}`}
          type="button"
          onClick={() => setProtocol("all")}
        >
          <span>All</span>
          <small>{rules.packs.length}</small>
        </button>
        {rules.protocols.map((p) => (
          <button
            className={`assurance-tab ${protocol === p.protocol ? "is-active" : ""}`}
            key={p.protocol}
            type="button"
            onClick={() => setProtocol(p.protocol)}
          >
            <span>{p.protocol}</span>
            <small>{p.rules.length}{p.gaps.length > 0 ? ` · ${p.gaps.join("/")}` : ""}</small>
          </button>
        ))}
      </div>

      <div className="assurance-rule-list">
        {paged.visible.map((rule) => (
          <article className="assurance-rule" key={rule.id}>
            <header>
              <code>{rule.id}</code>
              <Tag tone={ENFORCEMENT_TONE[rule.enforcement] ?? "neutral"}>{rule.enforcement}</Tag>
            </header>
            <h4>{rule.name}</h4>
            <p className="assurance-rule-bound">
              {rule.metric}
              {rule.unit ? ` (${rule.unit})` : ""} — {rule.comparator}{" "}
              {rule.bounds.value ?? `${rule.bounds.min ?? "—"}…${rule.bounds.max ?? "—"}`}
            </p>
            <p className="assurance-rule-statement">{rule.reference.statement}</p>
            <footer>
              <span>{rule.reference.source} · {rule.reference.edition}</span>
              <code>{rule.implementedIn}</code>
            </footer>
          </article>
        ))}
      </div>
      <LoadMore shown={paged.visible.length} total={filtered.length} onMore={paged.showMore} label="rules" />
    </div>
  );
}

/* ---------- modes ---------- */

function ModesTab({
  summary,
  modes,
  onChanged,
}: {
  summary: ModeSummary;
  modes: ProtocolModeRecord[];
  onChanged: () => void;
}) {
  const [protocol, setProtocol] = useState<string>(modes[0]?.protocol ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ protocol: string; identical: boolean; active: string; silent: string } | null>(null);
  const paged = usePaged(modes, 7, summary.total);

  const selected = modes.find((m) => m.protocol === protocol);

  const setMode = useCallback(async (mode: ProtocolMode) => {
    if (!protocol) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await assuranceApi.setMode({ protocol, mode, reason: reason || "returned to silent mode", by: "exec-console" });
      setMessage(`${result.record.protocol} is now ${result.record.mode} (${result.record.reason})`);
      setReason("");
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "mode change rejected");
    } finally {
      setBusy(false);
    }
  }, [protocol, reason, onChanged]);

  const runProbe = useCallback(async () => {
    if (!protocol) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await assuranceApi.probeMode(protocol);
      setProbe({
        protocol: result.protocol,
        identical: result.probe.identical,
        active: result.probe.active,
        silent: result.probe.silent,
      });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "probe failed");
    } finally {
      setBusy(false);
    }
  }, [protocol]);

  return (
    <div className="assurance-stack">
      <section className="panel">
        <header className="panel-head">
          <div>
            <Eyebrow>silent is a surfacing switch, never a computation switch</Eyebrow>
            <h2>{summary.silent.length} of {summary.total} packs are running silent.</h2>
          </div>
          <div className="assurance-pack-tags">
            <Tag tone={summary.silent.length === summary.total ? "amber" : "mint"}>
              {summary.active.length} active
            </Tag>
            <PanelExpand />
          </div>
        </header>
        <p className="assurance-note">
          A silent pack still evaluates its gates, still writes its evidence and still records the decision it would have
          surfaced — it just does not surface it. Leaving silent mode is a governed act and requires a stated reason.
        </p>

        <div className="assurance-mode-list">
          {paged.visible.map((mode) => (
            <button
              className={`assurance-mode ${mode.protocol === protocol ? "is-active" : ""}`}
              key={mode.protocol}
              type="button"
              onClick={() => setProtocol(mode.protocol)}
            >
              <span>{mode.protocol}</span>
              <Tag tone={mode.mode === "active" ? "mint" : "neutral"}>{mode.mode}</Tag>
              <small>{mode.reason}</small>
              {mode.routes ? <code>{mode.routes}</code> : null}
            </button>
          ))}
        </div>
        <LoadMore shown={paged.visible.length} total={modes.length} onMore={paged.showMore} label="packs" />
      </section>

      {selected ? (
        <section className="panel">
          <header className="panel-head">
            <div>
              <Eyebrow>{selected.protocol}</Eyebrow>
              <h3>{selected.mode === "active" ? "Surfacing recommendations." : "Silent — computed and recorded, not surfaced."}</h3>
            </div>
          </header>
          <dl className="assurance-mode-detail">
            <div><dt>mode</dt><dd>{selected.mode}</dd></div>
            <div><dt>since</dt><dd>{selected.since}</dd></div>
            <div><dt>reason</dt><dd>{selected.reason}</dd></div>
            <div><dt>by</dt><dd>{selected.by}</dd></div>
          </dl>

          <label className="assurance-field">
            <span>Reason for the change (required to activate)</span>
            <textarea
              rows={2}
              value={reason}
              placeholder="e.g. shadow-mode agreement 94% over 60 days at both sites"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>

          <div className="assurance-mode-actions">
            <button className="assurance-button" type="button" disabled={busy || selected.mode === "active"} onClick={() => setMode("active")}>
              <BadgeCheck size={14} /> Activate
            </button>
            <button className="assurance-button ghost" type="button" disabled={busy || selected.mode === "silent"} onClick={() => setMode("silent")}>
              <Ban size={14} /> Return to silent
            </button>
            <button className="assurance-button ghost" type="button" disabled={busy} onClick={runProbe}>
              <ShieldCheck size={14} /> Prove the computation is unchanged
            </button>
          </div>
          {message ? <p className="assurance-note">{message}</p> : null}
          {probe && probe.protocol === protocol ? (
            <div className={`assurance-probe ${probe.identical ? "is-ok" : "is-bad"}`}>
              {probe.identical ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />}
              <div>
                <strong>
                  {probe.identical
                    ? "Identical recommendation in active and silent mode."
                    : "The recommendation changed with the mode — this is a defect."}
                </strong>
                <p><code>{probe.silent}</code></p>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/* ---------- page ---------- */

export default function AssuranceTrack({ onNavigate }: Props) {
  const [tab, setTab] = useState<Tab>("wiring");
  const [overview, setOverview] = useState<AssuranceOverview | null>(null);
  const [gate, setGate] = useState<AssuranceGate | null>(null);
  const [rules, setRules] = useState<RulePacksView | null>(null);
  const [modes, setModes] = useState<{ summary: ModeSummary; modes: ProtocolModeRecord[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextOverview, nextGate, nextRules, nextModes] = await Promise.all([
        assuranceApi.overview(),
        assuranceApi.gate(),
        assuranceApi.rules(),
        assuranceApi.modes(),
      ]);
      setOverview(nextOverview);
      setGate(nextGate);
      setRules(nextRules);
      setModes(nextModes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "assurance surface unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * The gate names the warnings; the packs own the machinery. This drives each
   * pack's own endpoint and shows what the gate says afterwards.
   */
  const runCrossPackAction = useCallback(async (kind: "red-team" | "drift") => {
    setActionBusy(true);
    setActionNotice(null);
    try {
      const result = kind === "red-team"
        ? await assuranceApi.runAllRedTeams("exec-console")
        : await assuranceApi.snapshotAllDrift("exec-console");
      setGate(result.gate);
      const failures = result.triggered.filter((t) => !t.ok);
      setActionNotice(
        `${result.ran} of ${result.triggered.length} packs ${kind === "red-team" ? "replayed their red team" : "snapshotted drift"}`
        + (failures.length > 0 ? ` · not recorded for: ${failures.map((f) => f.protocol).join(", ")}` : "")
        + ` · gate is now ${result.gate.decision}`,
      );
      await load();
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "cross-pack action failed");
    } finally {
      setActionBusy(false);
    }
  }, [load]);

  if (loading && !overview) {
    return (
      <section className="panel">
        <Eyebrow>cross-pack assurance</Eyebrow>
        <h2>Reading the durable ledger…</h2>
      </section>
    );
  }

  if (error && !overview) {
    return (
      <section className="panel">
        <Eyebrow>cross-pack assurance</Eyebrow>
        <h2><AlertTriangle size={18} /> {error}</h2>
        <button className="assurance-button" type="button" onClick={() => void load()}>
          <RefreshCw size={14} /> Retry
        </button>
      </section>
    );
  }

  if (!overview || !rules || !modes) return null;

  const activeTab = TAB_LABELS.find((t) => t.id === tab)!;

  return (
    <div className="assurance-page">
      <header className="assurance-hero">
        <div>
          <Eyebrow>P7 · cross-pack assurance</Eyebrow>
          <h1>Seven protocol packs, one release decision.</h1>
          <p>
            Every pack owns its coverage gate, red team, drift and boundary document. This is the one view across all of
            them: wiring parity, cohort fairness, alert burden and a single gate that aggregates every per-protocol MDR
            file — measured from the durable ledger, never recomputed in the browser.
          </p>
        </div>
        <div className="assurance-hero-side">
          <div className="assurance-hero-verdict">
            {verdictTag(overview.decision)}
            <small>generated {new Date(overview.generatedAt).toLocaleString()}</small>
          </div>
          <button className="assurance-button ghost" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </header>

      <nav className="assurance-tabs" role="tablist" aria-label="Assurance views">
        {TAB_LABELS.map((entry) => (
          <button
            className={`assurance-tab ${entry.id === tab ? "is-active" : ""}`}
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={entry.id === tab}
            onClick={() => setTab(entry.id)}
          >
            <span>{entry.label}</span>
            <small>{entry.id === "wiring" ? `${overview.totals.block} block` : entry.id === "modes" ? `${overview.totals.silentPacks} silent` : ""}</small>
          </button>
        ))}
      </nav>
      <p className="assurance-tab-hint">{activeTab.hint}</p>

      {tab === "wiring" ? (
        <WiringTab
          overview={overview}
          gate={gate}
          onNavigate={onNavigate}
          onAction={runCrossPackAction}
          actionBusy={actionBusy}
          actionNotice={actionNotice}
        />
      ) : null}
      {tab === "fairness" ? <FairnessTab report={overview.fairness} cohortN={overview.cohort.patients} /> : null}
      {tab === "burden" ? <BurdenTab report={overview.burden} /> : null}
      {tab === "rules" ? <RulesTab rules={rules} /> : null}
      {tab === "modes" ? <ModesTab summary={modes.summary} modes={modes.modes} onChanged={() => void load()} /> : null}

      {overview.findings.length > 0 ? (
        <section className="panel assurance-findings">
          <header className="panel-head">
            <div>
              <Eyebrow>what the track is saying</Eyebrow>
              <h2>{overview.findings.length} findings across the set.</h2>
            </div>
          </header>
          <ul className="assurance-pack-notes">
            {overview.findings.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </section>
      ) : null}

      <footer className="assurance-foot">
        <span><Layers size={13} /> {overview.totals.protocols} packs</span>
        <span><ClipboardCheck size={13} /> {overview.totals.rules} cited rules</span>
        <span><Users size={13} /> {overview.cohort.patients} patients</span>
        <span><Scale size={13} /> fairness {overview.fairness.verdict}</span>
        <span><Gauge size={13} /> burden {overview.burden.verdict}</span>
        <span><SlidersHorizontal size={13} /> {overview.totals.silentPacks} silent</span>
      </footer>
    </div>
  );
}

export { ENFORCEMENT_LABEL };
