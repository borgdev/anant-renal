"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  ClipboardCheck,
  CloudDownload,
  Database,
  FileCheck2,
  FileClock,
  Fingerprint,
  LockKeyhole,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import measurePacks from "../../config/measure-packs.json";
import publicSources from "../../config/public-sources.json";
import { federalFacts, publicBenchmarks } from "../../lib/demo-data";
import { ensureRuntime, mutateRuntime, type RuntimeSnapshot } from "../../lib/runtime/client";
import type { NavigationId } from "../../lib/types";
import type { OpenWorkflowDetail } from "../../lib/workflow-detail";
import { Eyebrow, ProgressBar, SourceLink, Tag } from "./ui";

const readiness = [
  { measure: "Kt/V Dialysis Adequacy", complete: 98.7, records: "4,182 / 4,237", owner: "Clinical quality", state: "ready" },
  { measure: "NHSN Bloodstream Infection", complete: 96.1, records: "1,204 / 1,253", owner: "Infection prevention", state: "review" },
  { measure: "ICH CAHPS", complete: 92.4, records: "1,884 / 2,039", owner: "Patient experience", state: "review" },
  { measure: "Clinical Depression Screening", complete: 99.2, records: "2,108 / 2,125", owner: "Social work", state: "ready" },
];

export default function CmsControl({ onOpenDetail }: { onOpenDetail: OpenWorkflowDetail }) {
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [packageResult, setPackageResult] = useState<{ packageId: string; status: string; manifestHash: string; liveTransmission: boolean; resultsIncluded: number } | null>(null);
  const [packageBusy, setPackageBusy] = useState(false);
  const [packageError, setPackageError] = useState<string | null>(null);
  const [activePack, setActivePack] = useState("ktv-comprehensive");
  const selected = measurePacks.find((pack) => pack.id === activePack) ?? measurePacks[0];
  const selectedSources = publicSources.filter((source) => selected.sourceIds.includes(source.id));

  useEffect(() => {
    let active = true;
    void ensureRuntime("quality").then((snapshot) => { if (active) setRuntime(snapshot); }).catch((error) => { if (active) setPackageError(error instanceof Error ? error.message : "Runtime unavailable"); });
    return () => { active = false; };
  }, []);

  async function generatePackage() {
    setPackageBusy(true);
    try {
      const result = await mutateRuntime<{ packageId: string; status: string; manifestHash: string; liveTransmission: boolean; resultsIncluded: number }>("submission-package", "quality");
      setPackageResult(result);
      setRuntime(await ensureRuntime("quality"));
      setPackageError(null);
    } catch (error) {
      setPackageError(error instanceof Error ? error.message : "Package validation failed");
    } finally {
      setPackageBusy(false);
    }
  }

  function openCmsDetail(title: string, summary: string, status: string, target: NavigationId = "cms", evidence: Array<{ label: string; value: string; source?: string }> = []) {
    onOpenDetail({ id: `CMS-${title.toUpperCase().replaceAll(" ", "-")}`, kind: "CMS work item", title, summary, status, tone: status.toLowerCase().includes("ready") || status.toLowerCase().includes("validated") ? "mint" : status.toLowerCase().includes("gap") || status.toLowerCase().includes("review") ? "amber" : "blue", owner: "Clinical quality", scope: "Payment year 2026", metrics: [{ label: "Runtime results", value: String(runtime?.counts.measures ?? 0) }, { label: "Packages", value: String(runtime?.submissionPackages.length ?? 0) }, { label: "Authority snapshots", value: String(runtime?.authoritySnapshots.length ?? 0) }], evidence: evidence.length ? evidence : selectedSources.map((source) => ({ label: source.authority, value: source.title, source: `${source.status} · effective ${source.effectiveFrom}` })), steps: [{ label: "Freeze", detail: "Eligible evidence version pinned", state: packageResult ? "done" : "current" }, { label: "Calculate", detail: `Measure pack ${selected.version}`, state: packageResult ? "done" : "pending" }, { label: "Validate", detail: packageResult ? "Conformance checks retained" : "Await dry run", state: packageResult ? "done" : "pending" }, { label: "Approve", detail: "Dual human approval required", state: packageResult ? "current" : "pending" }, { label: "Acknowledge", detail: "External transmission disabled", state: "pending" }], control: "Public CMS authority sources are real and linked. All patient/facility records here are synthetic, and the reference runtime cannot transmit to CMS, EQRS or NHSN.", primary: { label: target === "configuration" ? "Open Configuration Studio" : target === "assurance" ? "Open AI Assurance" : target === "assessments" ? "Open Assessment Intelligence" : "Stay in CMS Operations", target } });
  }

  return (
    <div className="view-stack cms-view">
      <header className="view-heading">
        <div>
          <Eyebrow>CMS control room · governed analytics and submission readiness</Eyebrow>
          <h1>One evidence fabric, many reporting years.</h1>
          <p>Public authority sources are real and linked; patient and facility records in this demonstration are synthetic.</p>
        </div>
        <div className="heading-actions"><Tag tone="mint"><RefreshCw size={11} /> Source registry current</Tag><button className="button button-secondary" type="button" onClick={() => openCmsDetail("Measure release history", "Inspect active, proposed and future measure packs with their effective windows and authority dependencies.", "Versioned", "configuration")}><Archive size={15} /> View release history</button></div>
      </header>

      <section className="regulatory-banner panel">
        <div className="regulatory-icon"><BadgeCheck size={22} /></div>
        <div><Eyebrow>Authority boundary</Eyebrow><h2>Real federal sources · synthetic operating data</h2><p>Every fact below names its provenance. The demo can prepare and validate a submission package, but it cannot transmit to CMS, EQRS or NHSN without a configured credential and designated human approval.</p></div>
        <Tag tone="violet"><LockKeyhole size={11} /> live transmit disabled</Tag>
      </section>

      <section className="federal-facts-grid">
        {federalFacts.map((fact) => {
          const source = publicSources.find((item) => item.id === fact.sourceId);
          return <article className="panel federal-fact" key={fact.label}><button className="federal-fact-detail drillable-surface" type="button" onClick={() => openCmsDetail(fact.label, `Public federal fact governed by ${source?.authority ?? "authority registry"}.`, fact.status, "configuration", source ? [{ label: "Authority source", value: source.title, source: `${source.status} · effective ${source.effectiveFrom}` }, { label: "Public value", value: fact.value, source: "Real public source fixture" }] : [])}><div className="fact-top"><Tag tone="mint">{fact.status}</Tag><span>{source?.authority}</span></div><strong>{fact.value}</strong><h3>{fact.label}</h3></button>{source ? <SourceLink href={source.url}>{source.title}</SourceLink> : null}</article>;
        })}
      </section>

      <section className="cms-main-grid">
        <article className="panel readiness-panel">
          <div className="panel-title-row"><div><Eyebrow>Payment year 2026</Eyebrow><h2>Organization readiness</h2></div><div className="readiness-score"><strong>94.2%</strong><small>weighted completeness</small></div></div>
          <div className="readiness-table">
            <div className="readiness-head"><span>Measure</span><span>Completeness</span><span>Validated rows</span><span>Owner</span><span>Status</span></div>
            {readiness.map((row) => (
              <button className="readiness-row drillable-surface" type="button" onClick={() => openCmsDetail(row.measure, `${row.records} eligible rows validated under the active payment-year pack.`, row.state, row.state === "ready" ? "cms" : "assurance", [{ label: "Completeness", value: `${row.complete}%`, source: "Organization readiness calculation" }, { label: "Validated rows", value: row.records, source: "Synthetic operating denominator" }, { label: "Owner", value: row.owner, source: "Configured accountability" }])} key={row.measure}>
                <strong>{row.measure}</strong>
                <div><span>{row.complete}%</span><ProgressBar value={row.complete} tone={row.complete > 98 ? "mint" : "amber"} /></div>
                <span>{row.records}</span><span>{row.owner}</span><Tag tone={row.state === "ready" ? "mint" : "amber"}>{row.state}</Tag>
              </button>
            ))}
          </div>
          <div className="readiness-gaps">
            <div><AlertTriangle size={16} /><span><strong>49 NHSN denominator rows</strong><small>Awaiting access-type reconciliation · due 24 Aug</small></span><button type="button" onClick={() => openCmsDetail("NHSN denominator reconciliation", "49 denominator rows need access-type evidence reconciliation before readiness can advance.", "Review gap", "assessments", [{ label: "Gap", value: "49 denominator rows", source: "NHSN readiness calculation" }, { label: "Due", value: "24 Aug", source: "Configured submission calendar" }])}>Open task <ArrowRight size={13} /></button></div>
            <div><FileClock size={16} /><span><strong>155 CAHPS eligibility rows</strong><small>Vendor response pending · SLA 2 days</small></span><button type="button" onClick={() => openCmsDetail("CAHPS eligibility reconciliation", "155 eligibility rows are waiting for the configured vendor response before completeness can advance.", "Vendor response pending", "assurance", [{ label: "Gap", value: "155 eligibility rows", source: "ICH CAHPS readiness calculation" }, { label: "SLA", value: "2 days", source: "Configured vendor workflow" }])}>Open task <ArrowRight size={13} /></button></div>
          </div>
        </article>

        <aside className="panel submission-panel">
          <div className="panel-title-row"><div><Eyebrow>Submission pipeline</Eyebrow><h2>EQRS dry-run package</h2></div><PackageCheck size={19} /></div>
          <div className="submission-steps">
            {["Freeze eligible evidence", "Calculate with active pack", "Validate conformance", "Dual human approval", "Transmit & acknowledge"].map((step, index) => <div className={index < 3 && packageResult ? "is-complete" : index === 3 && packageResult ? "is-current" : ""} key={step}><span>{index < 3 && packageResult ? <CheckCircle2 size={13} /> : index + 1}</span><strong>{step}</strong><small>{index === 4 ? "External credential boundary" : index === 3 ? "Required before release" : packageResult ? "Trace retained" : "Awaiting dry run"}</small></div>)}
          </div>
          <button className={`button ${packageResult ? "button-secondary" : "button-primary"} submission-button`} disabled={packageBusy || !runtime} onClick={() => void generatePackage()} type="button">{packageBusy ? <><RefreshCw size={15} /> Calculating…</> : packageResult ? <><FileCheck2 size={15} /> Revalidate package</> : <><PackageCheck size={15} /> Generate &amp; validate dry run</>}</button>
          {packageResult ? <button className="package-result drillable-surface" type="button" onClick={() => openCmsDetail("Validated EQRS dry-run package", `${packageResult.resultsIncluded} calculated runtime results plus 4,237 reference rows were content-addressed with no live transmission.`, packageResult.status, "assurance", [{ label: "Package", value: packageResult.packageId, source: `SHA-256 ${packageResult.manifestHash}` }, { label: "Live transmission", value: String(packageResult.liveTransmission), source: "External credential boundary" }])}><Fingerprint size={16} /><div><strong>{packageResult.packageId}</strong><p>{packageResult.resultsIncluded} calculated runtime results + 4,237 reference rows · SHA-256 {packageResult.manifestHash.slice(0, 16)}… · live transmission {packageResult.liveTransmission ? "enabled" : "disabled"}</p></div></button> : null}
          {packageError ? <div className="package-result"><AlertTriangle size={16} /><div><strong>Package not created</strong><p>{packageError}</p></div></div> : null}
        </aside>
      </section>

      <section className="measure-source-grid">
        <article className="panel measure-pack-panel">
          <div className="panel-title-row"><div><Eyebrow>Versioned configuration</Eyebrow><h2>Measure packs</h2></div><Tag tone="mint">7 registered</Tag></div>
          <div className="measure-pack-layout">
            <div className="measure-pack-list">
              {measurePacks.map((pack) => <button className={pack.id === selected.id ? "is-selected" : ""} type="button" key={pack.id} onClick={() => setActivePack(pack.id)}><span><strong>{pack.name}</strong><small>{pack.program} · PY {pack.paymentYear}</small></span><Tag tone={pack.status.includes("proposed") ? "amber" : pack.status.includes("future") ? "violet" : "mint"}>{pack.version}</Tag></button>)}
            </div>
            <div className="measure-detail">
              <div className="measure-detail-top"><span className="config-icon"><ClipboardCheck size={18} /></span><div><Eyebrow>Active selection</Eyebrow><h3>{selected.name}</h3></div></div>
              <dl><div><dt>Status</dt><dd>{selected.status}</dd></div><div><dt>Submission</dt><dd>{selected.submission}</dd></div><div><dt>Owner</dt><dd>{selected.owner}</dd></div><div><dt>Inputs</dt><dd>{selected.inputEvents.join(" · ")}</dd></div></dl>
              <div className="source-stack">{selectedSources.map((source) => <SourceLink href={source.url} key={source.id}>{source.title}</SourceLink>)}</div>
            </div>
          </div>
        </article>

        <article className="panel benchmark-panel">
          <div className="panel-title-row"><div><Eyebrow>Real public benchmark · {publicBenchmarks[0]?.period}</Eyebrow><h2>{publicBenchmarks[0]?.facility}, {publicBenchmarks[0]?.city}</h2></div><Tag tone="blue">CCN {publicBenchmarks[0]?.ccn}</Tag></div>
          <p className="benchmark-note">Exact values retrieved from the CMS Provider Data API. They are a public comparison fixture, not Riverbend performance.</p>
          <div className="benchmark-list">{publicBenchmarks.map((item) => <button type="button" onClick={() => openCmsDetail(item.label, `Public comparison value for ${publicBenchmarks[0]?.facility}, ${publicBenchmarks[0]?.city}; not Riverbend performance.`, "Public benchmark", "cms", [{ label: item.label, value: item.value, source: `CMS Provider Data · ${publicBenchmarks[0]?.period}` }, { label: "CCN", value: publicBenchmarks[0]?.ccn ?? "—", source: "Public facility identifier" }])} key={item.label}><span>{item.label}</span><strong>{item.value}</strong></button>)}</div>
          <SourceLink href={publicSources.find((source) => source.id === "cms-provider-data")?.url ?? "https://data.cms.gov"}>Open the CMS public dataset endpoint</SourceLink>
        </article>
      </section>

      <section className="source-registry panel">
        <div className="source-registry-title"><Database size={18} /><div><Eyebrow>Authority registry</Eyebrow><h2>Public sources monitored as configuration</h2></div></div>
        <div className="source-registry-list">{publicSources.slice(0, 6).map((source) => <div key={source.id}><span className="authority-logo">{source.authority.slice(0, 3)}</span><div><strong>{source.title}</strong><small>{source.status} · effective {source.effectiveFrom} · refresh {source.refresh}</small></div><SourceLink href={source.url}>Open source</SourceLink></div>)}</div>
        <div className="source-registry-footer"><ShieldCheck size={15} /><span>Effective-date gates block a measure release when a required authority source is stale, proposed-only or superseded.</span><CloudDownload size={15} /></div>
      </section>
    </div>
  );
}
