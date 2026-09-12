"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  CircleDot,
  FlaskConical,
  Gauge,
  Layers,
  LineChart,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import {
  fetchProtocolCockpit,
  fetchProtocolDetail,
  fetchProtocolEvaluation,
  fetchProtocolRegistry,
  PROTOCOL_STATUS_TONE,
  SUBSTATE_LABELS,
  type CockpitPatient,
  type CockpitView,
  type EvaluationView,
  type ProtocolDescriptor,
  type ProtocolDetailView,
  type ProtocolRegistryView,
  type ProtocolStatus,
} from "../lib/protocols";
import { EmptyView, Eyebrow, Metric, PanelExpand, ProgressBar, Tag, usePaged, LoadMore } from "./ui";
import FleetActionsBoard from "./fleet-actions-board";
import AdoptionPanel from "./adoption-panel";
import type { NavigationId } from "../lib/types";

type Props = {
  onNavigate?: (id: NavigationId) => void;
};

/** Protocol-pack id → the exec view that owns that pack's page. `access` is the one
 *  that differs (its view is `vascular-access`), so the mapping is explicit. */
const PROTOCOL_VIEW_BY_PACK: Record<string, NavigationId> = {
  adequacy: "adequacy",
  fluid: "fluid",
  access: "vascular-access",
  anemia: "anemia",
  mbd: "mbd",
  nutrition: "nutrition",
  infection: "infection",
};

const STATUS_ICON: Record<ProtocolStatus, typeof Activity> = {
  green: ShieldCheck,
  amber: AlertTriangle,
  red: AlertTriangle,
  unknown: CircleDot,
};

const statusLabel = (status: ProtocolStatus): string =>
  status === "green" ? "in target" : status === "amber" ? "watch" : status === "red" ? "out of target" : "no data";

/** Shared trajectory / credibility-band panel — one component for every protocol. */
function TrajectoryPanel({ forecasts, thresholds }: { forecasts: CockpitPatient["forecasts"]; thresholds?: boolean }) {
  const grouped = useMemo(() => {
    const map = new Map<string, CockpitPatient["forecasts"]>();
    for (const f of forecasts) {
      const list = map.get(f.protocol) ?? [];
      list.push(f);
      map.set(f.protocol, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.horizonDays - b.horizonDays);
    return [...map.entries()];
  }, [forecasts]);
  return (
    <div className="pc-trajectory">
      {grouped.map(([protocol, rows]) => {
        const first = rows[0]!;
        const lo = Math.min(...rows.map((r) => r.band.low));
        const hi = Math.max(...rows.map((r) => r.band.high));
        const span = Math.max(0.0001, hi - lo);
        const y = (v: number) => `${Math.round((1 - (v - lo) / span) * 100)}%`;
        return (
          <div className="pc-trajectory-row" key={protocol}>
            <div className="pc-trajectory-head">
              <span className="pc-substate">{first.substate}</span>
              <span className="pc-trajectory-label">{SUBSTATE_LABELS[first.substate] ?? protocol}</span>
              <span className="pc-trajectory-target">
                {first.target} · {first.unit}
                {thresholds && first.threshold !== null ? ` · target ≤ ${first.threshold}` : ""}
              </span>
            </div>
            <div className="pc-trajectory-track">
              {rows.map((r) => (
                <div
                  key={`${protocol}-${r.horizonDays}`}
                  className={`pc-band ${r.meetsTarget === null ? "" : r.meetsTarget ? "ok" : "risk"}`}
                  style={{ top: y(r.band.high), height: `${Math.max(6, Math.round((1 - (r.band.high - r.band.low) / span) * 100))}%` }}
                  title={`${r.horizonDays}d band ${r.band.low}–${r.band.high} ${r.unit}`}
                >
                  <span className="pc-band-value">{r.value}</span>
                  <span className="pc-band-day">{r.horizonDays}d</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 8-cell substate strip from the shared latent. */
function SubstateStrip({ latent }: { latent: number[] }) {
  const keys = ["SF", "SG", "SH", "SI", "SJ", "SK", "SL", "GLOBAL"];
  return (
    <div className="pc-substates">
      {keys.map((key, i) => {
        const value = latent[i] ?? 0;
        const tone = value >= 0.6 ? "red" : value >= 0.3 ? "amber" : "mint";
        return (
          <div className="pc-substate-cell" key={key} title={`${SUBSTATE_LABELS[key]}: ${value}`}>
            <span className="pc-substate">{key}</span>
            <ProgressBar value={Math.round(value * 100)} tone={tone} />
          </div>
        );
      })}
    </div>
  );
}

export default function ProtocolCockpit({ onNavigate }: Props) {
  const [cockpit, setCockpit] = useState<CockpitView | null>(null);
  const [registry, setRegistry] = useState<ProtocolRegistryView | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationView | null>(null);
  const [detail, setDetail] = useState<ProtocolDetailView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patients = usePaged(cockpit?.patients ?? [], 6);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [cockpitView, registryView, evaluationView] = await Promise.all([
        fetchProtocolCockpit(),
        fetchProtocolRegistry(),
        fetchProtocolEvaluation(),
      ]);
      setCockpit(cockpitView);
      setRegistry(registryView);
      setEvaluation(evaluationView);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load the protocol cockpit");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openProtocol = useCallback(async (id: string) => {
    try {
      setDetail(await fetchProtocolDetail(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : `failed to load protocol ${id}`);
    }
  }, []);

  const descriptorById = useMemo(() => {
    const map = new Map<string, ProtocolDescriptor>();
    for (const p of registry?.protocols ?? []) map.set(p.id, p);
    return map;
  }, [registry]);

  /** Leave the hub for the pack's own page (the hub indexes; the page owns detail). */
  const openProtocolPage = (protocol: string) => {
    const view = PROTOCOL_VIEW_BY_PACK[protocol];
    if (view && onNavigate) onNavigate(view);
  };

  return (
    <div className="pc-root">
      <header className="pc-header">
        <div className="pc-header-main">
          <Eyebrow>Renal protocol operations</Eyebrow>
          <h1>Protocol cockpit</h1>
          <p>
            Seven renal protocols on one shared continuous patient state. Green/amber/red is derived from the realm
            ledger — dialysis sessions, access observations, the CKD-MBD/nutrition/infection panel and maintenance
            exposures — never from a mock. Synthetic data only.
          </p>
        </div>
        <div className="pc-header-actions">
          <button className="pc-btn" onClick={() => void load()} disabled={busy}>
            <RefreshCw size={14} /> {busy ? "Refreshing…" : "Refresh"}
          </button>
          {onNavigate ? (
            <button className="pc-btn ghost" onClick={() => onNavigate("anemia")}>
              Open anemia CDSS <ChevronRight size={14} />
            </button>
          ) : null}
        </div>
      </header>

      {error ? <div className="pc-error">{error}</div> : null}

      <section className="pc-kpis">
        <Metric label="Fleet status" value={cockpit ? statusLabel(cockpit.index.status) : "—"} detail={`${cockpit?.index.patients ?? 0} patients · ${cockpit?.index.sessions ?? 0} sessions`} />
        <Metric label="Protocols out of target" value={cockpit ? String(cockpit.index.redProtocols) : "—"} detail={cockpit ? `${cockpit.index.amberProtocols} on watch` : "—"} />
        <Metric
          label="Head vs persistence"
          value={evaluation ? `${evaluation.report.summary.headsBeatingPersistence}/${evaluation.report.summary.totalHeads}` : "—"} detail={evaluation ? `mean MAE ${evaluation.report.summary.meanHeadMae ?? "—"} vs ${evaluation.report.summary.meanPersistenceMae ?? "—"}` : "—"}
        />
        <Metric
          label="Patient-level split"
          value={evaluation ? (evaluation.report.noPatientOverlap ? "leak-free" : "CHECK") : "—"} detail={evaluation ? `${evaluation.report.rows.regression} rows · ${evaluation.report.coverage.protocolHorizonPairs} head×horizon` : "—"}
        />
      </section>

      <FleetActionsBoard onOpenProtocol={openProtocolPage} />

      {/* Whether anyone is answering the ranking, and why not when they aren't. */}
      <AdoptionPanel />

      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>Protocol board</Eyebrow>
          <PanelExpand label="Green / amber / red across every registered protocol" />
        </div>
        <div className="pc-board">
          {(cockpit?.protocols ?? []).map((row) => {
            const Icon = STATUS_ICON[row.status];
            const descriptor = descriptorById.get(row.protocol);
            return (
              <button
                key={row.protocol}
                className={`pc-card ${row.status}`}
                onClick={() => void openProtocol(row.protocol)}
              >
                <div className="pc-card-top">
                  <span className="pc-substate">{row.substate}</span>
                  <Tag tone={PROTOCOL_STATUS_TONE[row.status]}>
                    <Icon size={12} /> {statusLabel(row.status)}
                  </Tag>
                </div>
                <h3>{row.label}</h3>
                <p className="pc-card-domain">{descriptor?.domain ?? ""}</p>
                <div className="pc-card-counts">
                  <span className="pc-count red">{row.counts.red} red</span>
                  <span className="pc-count amber">{row.counts.amber} amber</span>
                  <span className="pc-count mint">{row.counts.green} green</span>
                </div>
                <ProgressBar value={row.attentionPct} tone={row.status === "red" ? "red" : row.status === "amber" ? "amber" : "mint"} />
                {row.topDrivers.length ? (
                  <ul className="pc-drivers">
                    {row.topDrivers.slice(0, 2).map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="pc-card-ok">No active drivers — all evaluated patients in target.</p>
                )}
                {descriptor ? (
                  <p className="pc-card-model">
                    <Sparkles size={12} /> {descriptor.model.family}
                  </p>
                ) : null}
              </button>
            );
          })}
          {!cockpit ? <EmptyView title="Loading protocol board" description="Reading the realm ledger and patient state." /> : null}
        </div>
      </section>

      {detail ? (
        <section className="pc-panel">
          <div className="pc-panel-head">
            <Eyebrow>
              {detail.protocol.substate} · {detail.protocol.label}
            </Eyebrow>
            <button className="pc-btn ghost" onClick={() => setDetail(null)}>
              Close detail
            </button>
          </div>
          <div className="pc-detail-grid">
            <div className="pc-detail-card">
              <h4>Model plan</h4>
              <p>
                <strong>{detail.protocol.model.family}</strong>
              </p>
              <p className="pc-muted">{detail.protocol.model.rationale}</p>
              <p className="pc-muted">
                <strong>Prior:</strong> {detail.protocol.model.prior}
              </p>
              <p className="pc-muted">
                <strong>Baseline:</strong> {detail.protocol.model.baseline}
              </p>
              <p className="pc-muted">
                <strong>Validation gate:</strong> {detail.protocol.model.validationGate}
              </p>
              <div className="pc-chip-row">
                <Tag tone={detail.protocol.safetyClass === "C" ? "amber" : "mint"}>Class {detail.protocol.safetyClass}</Tag>
                {detail.protocol.cells.map((c) => (
                  <Tag key={c} tone="neutral">
                    {c}
                  </Tag>
                ))}
              </div>
            </div>
            <div className="pc-detail-card">
              <h4>Inputs from the shared state</h4>
              <div className="pc-chip-row">
                {detail.protocol.inputs.map((i) => (
                  <Tag key={i} tone="neutral">
                    {i}
                  </Tag>
                ))}
              </div>
              <h4>Required ledger signals</h4>
              <div className="pc-chip-row">
                {detail.protocol.requiredSignals.map((s) => (
                  <Tag key={s} tone="mint">
                    {s}
                  </Tag>
                ))}
              </div>
              {detail.report ? (
                <>
                  <h4>Fleet status</h4>
                  <p className="pc-muted">
                    {statusLabel(detail.report.status)} · {detail.report.counts.red} red · {detail.report.counts.amber} amber ·{" "}
                    {detail.report.counts.green} green of {detail.report.evaluated}
                  </p>
                  {detail.report.topDrivers.length ? (
                    <ul className="pc-drivers">
                      {detail.report.topDrivers.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>

          <div className="pc-detail-grid">
            <div className="pc-detail-card wide">
              <h4>Shared state latent (one state vector, seven substates)</h4>
              {detail.patients.slice(0, 3).map((p) => (
                <div className="pc-patient-strip" key={p.patientId}>
                  <div className="pc-patient-strip-head">
                    <span className="pc-mono">{p.patientId}</span>
                    <Tag tone={PROTOCOL_STATUS_TONE[p.status]}>{statusLabel(p.status)}</Tag>
                    <span className="pc-muted">instability {p.instabilityIndex}</span>
                  </div>
                  <SubstateStrip latent={p.latent} />
                </div>
              ))}
            </div>
            <div className="pc-detail-card wide">
              <h4>Trajectory with credibility bands (7d / 28d / 84d)</h4>
              {detail.patients[0] ? (
                <TrajectoryPanel forecasts={detail.patients[0].forecasts} thresholds />
              ) : (
                <p className="pc-muted">No patients in scope.</p>
              )}
            </div>
          </div>

          <div className="pc-table">
            <div className="pc-table-head">
              <span>Patient</span>
              <span>Status</span>
              <span>Signals</span>
              <span>Drivers</span>
            </div>
            {detail.patients.slice(0, 8).map((p) => (
              <div className="pc-table-row" key={p.patientId}>
                <span className="pc-mono">{p.patientId}</span>
                <span>
                  <Tag tone={PROTOCOL_STATUS_TONE[p.status]}>{statusLabel(p.status)}</Tag>
                </span>
                <span className="pc-signals">
                  {p.signals.map((s) => (
                    <Tag key={`${p.patientId}-${s.label}`} tone={s.severity === "alert" ? "red" : s.severity === "watch" ? "amber" : "neutral"}>
                      {s.label}: {s.value}
                    </Tag>
                  ))}
                </span>
                <span className="pc-driver-cell">{p.drivers.slice(0, 2).join(" · ") || "—"}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>Patient shared state · worst first</Eyebrow>
          <PanelExpand label="Latent substates + multi-horizon forecasts from ONE state vector" />
        </div>
        <div className="pc-patient-list list-scroll">
          {patients.visible.map((p) => (
            <div className="pc-patient-card" key={p.patientId}>
              <div className="pc-patient-card-head">
                <div>
                  <span className="pc-mono">{p.patientId}</span>
                  <span className="pc-muted">
                    {" "}
                    · {p.facilityId ?? "unassigned"} · {p.trajectory ?? "unknown trajectory"}
                  </span>
                </div>
                <div className="pc-patient-card-tags">
                  <Tag tone={p.instabilityIndex >= 0.6 ? "red" : p.instabilityIndex >= 0.3 ? "amber" : "mint"}>
                    <Gauge size={12} /> instability {p.instabilityIndex}
                  </Tag>
                  {p.protocols
                    .filter((row) => row.status === "red")
                    .slice(0, 4)
                    .map((row) => (
                      <Tag key={`${p.patientId}-${row.protocol}`} tone="red">
                        {row.substate}
                      </Tag>
                    ))}
                </div>
              </div>
              <SubstateStrip latent={p.latent} />
              <details className="pc-patient-details">
                <summary>
                  <LineChart size={13} /> Forecasts at 7 / 28 / 84 days
                </summary>
                <TrajectoryPanel forecasts={p.forecasts} thresholds />
              </details>
            </div>
          ))}
          {!cockpit ? <EmptyView title="Loading patients" description="Deriving the shared state from realm patient state." /> : null}
        </div>
        {cockpit ? (
          <LoadMore
            shown={patients.visible.length}
            total={patients.visible.length + patients.remaining}
            onMore={patients.showMore}
            label="Show more patients"
          />
        ) : null}
      </section>

      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>Head vs baseline (F2) — patient-level split</Eyebrow>
          <PanelExpand label="Every protocol head is compared against persistence and a fitted tabular baseline; no patient appears in both halves." />
        </div>
        {evaluation ? (
          <>
            <div className="pc-eval-table">
              <div className="pc-eval-head">
                <span>Protocol</span>
                <span>Target</span>
                <span>Head MAE</span>
                <span>Persistence</span>
                <span>Tabular baseline</span>
                <span>Winner</span>
              </div>
              {evaluation.report.regressionHeads.map((head) => (
                <div className="pc-eval-row" key={`${head.protocol}-${head.target}-${head.horizonDays}`}>
                  <span>
                    <span className="pc-substate">{head.substate}</span> {head.protocol}
                  </span>
                  <span>
                    {head.target}@{head.horizonDays}d
                  </span>
                  <span className="pc-mono">{head.comparison.head.mae ?? "—"}</span>
                  <span className="pc-mono">{head.comparison.persistence.mae ?? "—"}</span>
                  <span className="pc-mono">{head.comparison.baseline?.mae ?? "—"}</span>
                  <span>
                    <Tag tone={head.comparison.winner === "head" ? "mint" : head.comparison.winner === "baseline" ? "amber" : "neutral"}>
                      {head.comparison.winner}
                    </Tag>
                  </span>
                </div>
              ))}
            </div>
            <div className="pc-eval-side">
              {evaluation.report.classificationHeads.map((cls) => (
                <div className="pc-eval-class" key={cls.target}>
                  <h4>
                    <FlaskConical size={14} /> {cls.target}
                  </h4>
                  <div className="pc-eval-metrics">
                    <Metric label="State AUROC" value={String(cls.stateScoreMetrics.auroc ?? "—")} detail={`ECE ${cls.stateScoreMetrics.ece ?? "—"}`} />
                    <Metric label="Baseline AUROC" value={String(cls.baselineMetrics.auroc ?? "—")} detail={`Brier ${cls.baselineMetrics.brier ?? "—"}`} />
                    <Metric label="Positives" value={String(cls.stateScoreMetrics.positives)} detail={`${cls.testRows} held-out rows`} />
                  </div>
                  <div className="pc-reliability">
                    {cls.reliability.map((bin) => (
                      <div className="pc-reliability-bin" key={`${cls.target}-${bin.bin}`} title={`bin ${bin.lo}-${bin.hi}: predicted ${bin.meanPredicted} observed ${bin.observedRate}`}>
                        <span className="pc-reliability-bar" style={{ height: `${Math.round(bin.observedRate * 100)}%` }} />
                        <span className="pc-reliability-label">{bin.lo}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <EmptyView title="Loading evaluation" description="Training heads and baselines on the synthetic cohort." />
        )}
      </section>

      {registry ? (
        <section className="pc-panel">
          <div className="pc-panel-head">
            <Eyebrow>Registry · {registry.count} protocols by configuration</Eyebrow>
            <PanelExpand label="A protocol appears in this cockpit by being registered once, server-side — no page scaffolding." />
          </div>
          <div className="pc-registry">
            <div className="pc-registry-col">
              <h4>
                <Layers size={14} /> Substates of the shared state
              </h4>
              {registry.substates.map((s) => (
                <div className="pc-registry-row" key={s.substate}>
                  <span className="pc-substate">{s.substate}</span>
                  <span>{s.label}</span>
                  <span className="pc-muted pc-mono">{s.stateDims.join(" ")}</span>
                </div>
              ))}
            </div>
            <div className="pc-registry-col">
              <h4>
                <TrendingUp size={14} /> Mechanistic priors (published)
              </h4>
              {registry.priors.map((p) => (
                <div className="pc-registry-row" key={p.id}>
                  <span className="pc-mono">{p.id}</span>
                  <span>{p.basis}</span>
                  <span className="pc-muted">{p.reference}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
