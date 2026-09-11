/*
 * Copyright (c) 2026 AnantHQ Inc. All rights reserved.
 *
 * Platform & configuration — the executive console's READ-ONLY view.
 *
 * This replaces the exec console's own Platform admin wizard and Configuration
 * studio. Those were full local implementations of setup CRUD, which the
 * console charter assigns to the operator console ("setup lives in Admin;
 * operations live in Exec", docs/ui-cohesion-persona-matrix.md §1 — exec's "Not
 * for" column literally says "raw configuration CRUD"). They also carried three
 * defects that only a second implementation can carry: an editor headed with
 * filenames that exist nowhere on disk, five hardcoded hero numbers, and a
 * five-gate "promotion contract" invented beside the two real gate models.
 *
 * What an executive genuinely needs is not the editor. It is: what is the platform
 * set to do, and would a release be allowed to ship? So this page reads the same
 * documents the operator console writes — one family, `/admin/platform/*` — and
 * offers no writer at all. Writes are refused for these roles by the API guard.
 */

import { useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, Gauge, ShieldAlert, ShieldCheck } from "lucide-react";
import { fetchReleaseGate, harnessJson, type ReleaseGateView } from "../lib/harness";
import { Eyebrow, PanelExpand, Tag } from "./ui";
import type { NavigationId } from "../lib/types";

interface ActiveConfig {
  version: string;
  status: string;
  changeSummary?: string;
  contentHash?: string;
  objectCount?: number;
  createdBy?: string;
  updatedAt?: string;
}

interface OrganizationView {
  organization: { displayName?: string; operatingModel?: string; environmentName?: string; deploymentMode?: string; dataRegion?: string; synthetic?: boolean } | null;
}

export default function PlatformReview({ onNavigate }: { onNavigate: (id: NavigationId) => void }) {
  const [gate, setGate] = useState<ReleaseGateView | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [releases, setReleases] = useState<ActiveConfig[]>([]);
  const [org, setOrg] = useState<OrganizationView["organization"]>(null);
  const [failed, setFailed] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    const failedLoads: string[] = [];

    void fetchReleaseGate()
      .then((g) => { if (live) setGate(g); })
      .catch((e: unknown) => { if (live) setGateError(e instanceof Error ? e.message : String(e)); });

    void harnessJson<{ releases: ActiveConfig[]; active: ActiveConfig | null }>("/admin/platform/releases")
      .then((r) => { if (live) setReleases(r.active ? [r.active, ...r.releases.filter((x) => x.version !== r.active?.version)] : r.releases); })
      .catch(() => { failedLoads.push("releases"); });

    void harnessJson<OrganizationView>("/admin/platform/organization")
      .then((r) => { if (live) setOrg(r.organization); })
      .catch(() => { failedLoads.push("organization"); });

    void Promise.resolve().then(() => { if (live) setFailed(failedLoads); });
    return () => { live = false; };
  }, []);

  const active = releases[0];
  const verdict = gate?.verdict;
  const checks = gate?.input.green ?? [];

  return (
    <div className="view-stack">
      <header className="view-heading">
        <div>
          <Eyebrow>Govern · read-only in the executive console</Eyebrow>
          <h1>Platform &amp; configuration</h1>
          <p>
            What the platform is set to do, and whether a release would be allowed to ship. Configuration is
            authored in the operator console — this console reads it and acts on the outcome.
          </p>
        </div>
        <div className="heading-actions">
          <a className="button button-primary" href="/admin/ui/">
            <ArrowUpRight size={15} /> Open in operator console
          </a>
        </div>
      </header>

      <section className="panel" style={{ padding: "12px 14px" }}>
        <div className="panel-title-row">
          <div><Eyebrow>Where configuration lives</Eyebrow><h2>Authored in Admin, decided here</h2></div>
          <ShieldCheck size={18} />
        </div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          The setup journey — organization, integration contract, topic plan, packs and the action policy — is a
          configuration activity and lives in the operator console. It is not duplicated here: a second editor
          for the same documents is how this console came to show a configuration file tree that did not exist.
          Approvals stay here, in <b>Outcome command</b> and <b>My Work</b>.
        </p>
      </section>

      <section className="panel" style={{ padding: "12px 14px" }}>
        <div className="panel-title-row">
          <div><Eyebrow>Release gate · evaluateRelease</Eyebrow><h2>Would this ship?</h2></div>
          <PanelExpand />
        </div>
        {gateError ? (
          <div className="state-card" style={{ marginTop: 8 }}>
            <div className="state-icon state-amber"><ShieldAlert size={16} /></div>
            <div>
              <small>Release gate</small>
              <strong>Gate evidence unavailable</strong>
              <span>{gateError}</span>
            </div>
          </div>
        ) : verdict ? (
          <>
            <div className="metrics-grid" style={{ marginTop: 8 }}>
              <article className="metric">
                <div className="metric-topline">Decision</div>
                <strong><Tag tone={verdict.decision === "ship" ? "mint" : verdict.decision === "hold" ? "amber" : "red"}>{verdict.decision.toUpperCase()}</Tag></strong>
                <small>score {verdict.score}</small>
              </article>
              <article className="metric">
                <div className="metric-topline">Green</div>
                <strong>{Math.round((verdict.greenScore ?? 0) * 100)}%</strong>
                <small>{checks.filter((c) => c.status === "pass").length}/{checks.length} checks pass</small>
              </article>
              <article className="metric">
                <div className="metric-topline">Red open</div>
                <strong>{verdict.redOpen}</strong>
                <small>{verdict.redContained} contained</small>
              </article>
              <article className="metric">
                <div className="metric-topline">Sources</div>
                <strong>{verdict.sourcesCurrent ? "current" : "stale"}</strong>
                <small>{verdict.approvalsMet ? "approvals met" : "approvals outstanding"}</small>
              </article>
            </div>
            {verdict.blocks.length ? (
              <p className="muted" style={{ fontSize: 12 }}>Blocks: <b>{verdict.blocks.join(", ")}</b></p>
            ) : null}
            {verdict.reasons.length ? (
              <p className="muted" style={{ fontSize: 12 }}>Holds: {verdict.reasons.join("; ")}</p>
            ) : null}
            <div className="list-scroll" style={{ maxHeight: 220 }}>
              {checks.map((c) => (
                <div className="message-row" key={c.id}>
                  <div>
                    <strong>{c.plane} · {c.id} <Tag tone={c.status === "pass" ? "mint" : c.status === "fail" ? "red" : "amber"}>{c.status}</Tag></strong>
                    <span>{c.check}{c.evidence ? ` — ${c.evidence}` : ""}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="muted" style={{ fontSize: 12 }}>Loading gate evidence…</p>
        )}
      </section>

      <section className="panel" style={{ padding: "12px 14px" }}>
        <div className="panel-title-row">
          <div><Eyebrow>Active configuration</Eyebrow><h2>{active ? active.version : "no active release"}</h2></div>
          <Gauge size={18} />
        </div>
        {active ? (
          <>
            <div className="metrics-grid">
              <article className="metric"><div className="metric-topline">Status</div><strong><Tag tone={active.status === "active" ? "mint" : "amber"}>{active.status}</Tag></strong><small>{active.objectCount ?? "—"} objects</small></article>
              <article className="metric"><div className="metric-topline">Content hash</div><strong>{String(active.contentHash ?? "—").slice(0, 12)}</strong><small>{active.createdBy ?? "—"}</small></article>
              <article className="metric"><div className="metric-topline">Deployment</div><strong>{org?.deploymentMode ?? "—"}</strong><small>{org?.environmentName ?? "—"} · {org?.dataRegion ?? "—"}</small></article>
              <article className="metric"><div className="metric-topline">Organization</div><strong>{org?.displayName ?? "—"}</strong><small>{org?.operatingModel ?? "—"}{org?.synthetic ? " · synthetic" : ""}</small></article>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>{active.changeSummary ?? "No change summary recorded."}</p>
          </>
        ) : (
          <p className="muted" style={{ fontSize: 12 }}>
            {failed.length ? "Could not read the release list." : "No release is active yet."}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="button button-secondary" type="button" onClick={() => onNavigate("assurance")}>
            <CheckCircle2 size={14} /> AI assurance
          </button>
          <button className="button button-ghost" type="button" onClick={() => onNavigate("command")}>
            Outcome command
          </button>
        </div>
      </section>
    </div>
  );
}
