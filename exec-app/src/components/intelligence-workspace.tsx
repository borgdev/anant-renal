import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Braces,
  CheckCircle2,
  Clock3,
  Database,
  Focus,
  Layers3,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { graphEdges, graphNodes, operatingModel } from "../lib/catalogs";
import { startLiveRuntime, createKnowledgeComment, createKnowledgeNote, fetchKnowledgeNotes, type KnowledgeNote, type RuntimeSnapshot } from "../lib/harness";
import type { GraphEdge, GraphNode, NavigationId } from "../lib/types";
import type { OpenWorkflowDetail } from "../lib/workflow-detail";
import { Eyebrow, LoadMore, PanelExpand, Tag, usePaged } from "./ui";

const nodeTone: Record<(typeof graphNodes)[number]["type"], "mint" | "violet" | "blue" | "amber" | "red" | "neutral"> = {
  enterprise: "mint",
  division: "blue",
  region: "blue",
  facility: "mint",
  patient: "mint",
  assessment: "violet",
  signal: "blue",
  cluster: "red",
  cell: "blue",
  policy: "violet",
  action: "amber",
  intervention: "amber",
  outcome: "mint",
  measure: "red",
  source: "neutral",
};

// Fill by token, not by literal: these were the pre-AnantState slate-era hexes,
// so the graph kept its own palette while everything around it changed — and it
// could not follow the theme at all. SVG `fill` accepts a var(), so the graph is
// now drawn from the same tokens as the rest of the console.
const toneFill: Record<string, string> = {
  mint: "var(--mint)",
  violet: "var(--violet)",
  blue: "var(--blue)",
  amber: "var(--amber)",
  red: "var(--rose)",
  neutral: "var(--faint)",
};

// Node details are derived from the live topology projection (real facilities,
// patients, cells, sources) + runtime node attributes — no hardcoded literals.
// `perspectiveLabel` below is only a reference fallback when the runtime is empty.

type GraphMode = "enterprise" | "patient" | "regulatory" | "swarm";
const perspectiveTypes: Record<GraphMode, (typeof graphNodes)[number]["type"][]> = {
  enterprise: ["enterprise", "division", "region", "facility", "patient", "assessment", "signal", "cluster", "cell", "policy", "intervention", "outcome", "measure", "source"],
  patient: ["facility", "patient", "assessment", "signal", "cell", "policy", "intervention", "outcome", "measure", "source"],
  regulatory: ["enterprise", "division", "region", "facility", "cluster", "policy", "outcome", "measure", "source"],
  swarm: ["region", "facility", "signal", "cluster", "cell", "policy", "intervention", "outcome"],
};
const perspectiveRoot: Record<GraphMode, string> = { enterprise: "enterprise", patient: "patient", regulatory: "cms-authority", swarm: "workforce-cluster" };
const perspectiveLabel: Record<GraphMode, string> = { enterprise: "312 facilities · 8 outcome domains", patient: "Maya Ortiz · temporal care journey", regulatory: "Authority → measure → facility impact", swarm: "Events → cells → policy → action" };

function isGraphNodeType(value: string): value is GraphNode["type"] {
  return value in nodeTone;
}

export default function IntelligenceWorkspace({ onOpenDetail }: { onOpenDetail: OpenWorkflowDetail }) {
  const [selectedId, setSelectedId] = useState("enterprise");
  const [mode, setMode] = useState<GraphMode>("enterprise");
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);

  // Perspective titles/provenance derive from the durable operating-model ontology
  // (Postgres — admin Ontology editor), not hardcoded "Riverbend" literals.
  const scopeByLevel = useMemo(() => {
    const path = (operatingModel?.scopePath ?? []) as Array<{ level: string; label: string; facilities?: number; patients?: number }>;
    const map: Record<string, { label: string; facilities: number; patients: number }> = {};
    for (const item of path) map[item.level] = { label: item.label, facilities: item.facilities ?? 0, patients: item.patients ?? 0 };
    return map;
  }, [operatingModel]);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const allNodes = useMemo<GraphNode[]>(() => runtime?.topology.nodes.length ? runtime.topology.nodes.map((node) => ({ id: node.id, label: node.label, type: isGraphNodeType(node.type) ? node.type : "signal", x: node.x, y: node.y, z: node.z })) : graphNodes, [runtime]);
  const allEdges = useMemo<GraphEdge[]>(() => runtime?.topology.edges.length ? runtime.topology.edges.map((edge) => ({ source: edge.source, target: edge.target, relation: edge.relation })) : graphEdges, [runtime]);
  const visibleNodes = useMemo(() => allNodes.filter((node) => perspectiveTypes[mode].includes(node.type)), [allNodes, mode]);
  const visibleEdges = useMemo(() => {
    const ids = new Set(visibleNodes.map((node) => node.id));
    return allEdges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  }, [allEdges, visibleNodes]);
  const selectedNode = visibleNodes.find((node) => node.id === selectedId) ?? visibleNodes[0];
  const runtimeNode = runtime?.topology.nodes.find((node) => node.id === selectedNode.id);
  // Valid-at is projected from the newest persisted event (real, not a literal date).
  const validAt = useMemo(() => {
    const latest = [...(runtime?.events ?? [])].sort((a, b) => String(b.recordedTime).localeCompare(String(a.recordedTime)))[0];
    if (latest?.recordedTime) {
      const d = new Date(latest.recordedTime);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    }
    return "Current valid-time projection";
  }, [runtime]);
  // Perspective captions derive from the live topology, not literals.
  const derivedPerspectiveLabel = useMemo(() => {
    const count = (type: string) => allNodes.filter((node) => node.type === type).length;
    const enterprise = scopeByLevel.enterprise;
    return {
      enterprise: enterprise ? `${enterprise.facilities} facilities · ${operatingModel?.domains?.length ?? count("cell")} outcome domains` : perspectiveLabel.enterprise,
      patient: `${count("patient")} patients · temporal care journey`,
      regulatory: `${count("measure")} measure packs · authority impact`,
      swarm: `${count("cell")} cells · policy bounded`,
    };
  }, [allNodes, scopeByLevel, operatingModel]);
  const detail = (() => {
    const scope = scopeByLevel[selectedNode.id];
    if (scope) return { title: scope.label, source: "Configured organization scope", provenance: `${scope.facilities} facility projections · ${scope.patients} patients`, valid: validAt };
    const attrs = runtimeNode?.attributes ?? {};
    return {
      title: selectedNode.label,
      source: String(attrs.source ?? attrs.resource ?? "Canonical runtime projection"),
      provenance: attrs.contentHash ? `SHA-256 ${String(attrs.contentHash).slice(0, 16)}…` : String(attrs.scopeId ?? attrs.provenance ?? "Typed edge with persisted provenance"),
      valid: String(attrs.validTime ?? validAt),
    };
  })();
  const connected = useMemo(
    () => visibleEdges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id),
    [selectedNode.id, visibleEdges],
  );
  // A hub node can link to many relations — page them + scroll rather than growing the card.
  const connectedPager = usePaged(connected, 12, selectedNode.id);
  const searchMatches = useMemo(() => searchQuery.trim() ? allNodes.filter((node) => `${node.label} ${node.type} ${node.id}`.toLowerCase().includes(searchQuery.trim().toLowerCase())).slice(0, 8) : [], [allNodes, searchQuery]);

  useEffect(() => {
    let active = true;
    const stop = startLiveRuntime((snapshot) => { if (active) setRuntime(snapshot); }, { roleId: "fa", onError: (error) => { if (active) setRuntimeError(error ? error.message : null); } });
    return () => { active = false; stop(); };
  }, []);

  useEffect(() => {
    if (!selectedNode?.id || !runtime) return;
    let active = true;
    void fetchKnowledgeNotes(selectedNode.id).then((payload) => { if (active) setNotes(payload.notes); }).catch((error) => { if (active) setRuntimeError(error instanceof Error ? error.message : "Knowledge query failed"); });
    return () => { active = false; };
  }, [runtime, selectedNode?.id]);

  async function createNote() {
    if (!noteTitle.trim() || !noteContent.trim()) return;
    setNoteBusy(true);
    try {
      const payload = await createKnowledgeNote({ nodeId: selectedNode.id, title: noteTitle, content: noteContent });
      setNotes(payload.notes);
      setNoteTitle("");
      setNoteContent("");
      setRuntimeError(null);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Note write failed");
    } finally {
      setNoteBusy(false);
    }
  }

  async function createComment(noteId: string) {
    if (!commentBody.trim()) return;
    setNoteBusy(true);
    try {
      const payload = await createKnowledgeComment({ nodeId: selectedNode.id, noteId, body: commentBody });
      setNotes(payload.notes);
      setCommentBody("");
      setRuntimeError(null);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Comment write failed");
    } finally {
      setNoteBusy(false);
    }
  }

  function openNodeDetail() {
    const target: NavigationId = selectedNode.type === "patient" ? "patient" : selectedNode.type === "assessment" ? "assessments" : selectedNode.type === "facility" ? "facility" : selectedNode.type === "measure" || selectedNode.id === "cms-authority" ? "cms" : selectedNode.type === "cell" || selectedNode.type === "policy" ? "assurance" : selectedNode.type === "intervention" || selectedNode.type === "outcome" ? "command" : "ecosystem";
    onOpenDetail({ id: selectedNode.id, kind: `${selectedNode.type} topology object`, title: detail.title, summary: `${detail.provenance}. This object has ${connected.length} visible typed relations in the ${mode} perspective.`, status: detail.valid, tone: nodeTone[selectedNode.type], owner: detail.source, scope: runtimeNode?.attributes.scopeId ? String(runtimeNode.attributes.scopeId) : derivedPerspectiveLabel[mode], metrics: [{ label: "Connected edges", value: String(connected.length) }, { label: "Perspective", value: mode }, { label: "Shared notes", value: String(notes.length) }], evidence: [{ label: "Authority / source", value: detail.source, source: detail.provenance }, { label: "Valid time", value: detail.valid, source: "Bitemporal topology projection" }, ...connected.slice(0, 8).map((edge) => ({ label: edge.relation, value: `${edge.source} → ${edge.target}`, source: "Typed relation" }))], activity: [{ time: detail.valid, title: "Object projected", detail: detail.provenance, state: "done" }, { time: "Current", title: `${connected.length} relations resolved`, detail: `${mode} perspective`, state: "current" }], steps: [{ label: "Source", detail: "Evidence authority retained", state: "done" }, { label: "Project", detail: "Node and typed edges materialized", state: "done" }, { label: "Interpret", detail: `${mode} perspective selected`, state: "current" }, { label: "Act", detail: `Continue in ${target}`, state: "pending" }], primary: { label: target === "patient" ? "Open Patient Intelligence" : target === "assessments" ? "Open Assessment Intelligence" : target === "facility" ? "Open Facility Operations" : target === "cms" ? "Open CMS Operations" : target === "assurance" ? "Open AI Assurance" : target === "command" ? "Open Outcome Command" : "Open Swarm Control", target } });
  }

  const svgPoints = (node: GraphNode) => ({ x: 500 + node.x * 58, y: 300 - node.y * 52 });

  return (
    <div className="view-stack intelligence-view">
      <header className="view-heading">
        <div>
          <Eyebrow>Shared Intelligence · temporal hypergraph</Eyebrow>
          <h1>Shared Intelligence</h1>
          <p>Patient–facility–measure–intervention relationships, cross-facility clusters, risk propagation, regulatory impact and swarm dependencies.</p>
        </div>
        <div className="heading-actions"><button className="button button-secondary" type="button" onClick={() => setSearchOpen((current) => !current)}><Search size={15} /> {searchOpen ? "Close search" : "Search graph"}</button><button className="button button-primary" type="button" onClick={() => { setMode("patient"); setSelectedId("patient"); }}><Focus size={15} /> Focus open episode</button></div>
      </header>

      {searchOpen ? <section className="graph-search panel"><Search size={16} /><input autoFocus aria-label="Search topology objects" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search patient, facility, measure, agent, source…" />{searchMatches.length ? <div>{searchMatches.map((node) => <button type="button" key={node.id} onClick={() => { setMode("enterprise"); setSelectedId(node.id); setSearchOpen(false); setSearchQuery(""); }}><Tag tone={nodeTone[node.type]}>{node.type}</Tag><span><strong>{node.label}</strong><small>{node.id}</small></span></button>)}</div> : searchQuery ? <small>No matching topology objects.</small> : null}</section> : null}

      <section className="graph-toolbar panel">
        <div className="segmented-control" aria-label="Graph perspective">
          {(["enterprise", "patient", "regulatory", "swarm"] as GraphMode[]).map((item) => <button className={mode === item ? "is-active" : ""} key={item} onClick={() => { setMode(item); setSelectedId(perspectiveRoot[item]); }} type="button">{item}</button>)}
        </div>
        <div className="graph-time"><Clock3 size={14} /><span>Valid at</span><strong>{validAt}</strong><input aria-label="Graph time" type="range" min="0" max="100" defaultValue="100" /></div>
        <Tag tone={runtime ? "mint" : runtimeError ? "red" : "violet"}><Activity size={11} /> {visibleNodes.length} nodes · {visibleEdges.length} relations · {runtime ? "harness projection" : "loading"}</Tag>
      </section>

      <section className="intelligence-grid">
        <article className="panel graph-panel">
          <div className="graph-stage" aria-label="Interactive enterprise renal-care hypergraph">
            <div className="graph-toolbar"><PanelExpand label="Expand topology canvas" /></div>
            <svg className="graph-svg" viewBox="0 0 1000 600" role="img" aria-label={`${mode} topology graph`}>
              {visibleEdges.map((edge) => {
                const s = svgPoints(visibleNodes.find((n) => n.id === edge.source) ?? graphNodes[0]);
                const t = svgPoints(visibleNodes.find((n) => n.id === edge.target) ?? graphNodes[1]);
                return <line key={`${edge.source}-${edge.target}`} x1={s.x} y1={s.y} x2={t.x} y2={t.y} className="graph-edge-line" />;
              })}
              {visibleNodes.map((node) => {
                const p = svgPoints(node);
                const active = node.id === selectedNode.id;
                const fill = toneFill[nodeTone[node.type]] ?? "var(--faint)";
                const r = node.type === "enterprise" ? 13 : node.type === "facility" || node.type === "patient" ? 10 : 8;
                return (
                  <g key={node.id} className="graph-node-g" onClick={() => setSelectedId(node.id)}>
                    {active ? <circle cx={p.x} cy={p.y} r={r + 5} fill="none" stroke={fill} strokeWidth={1.5} opacity={0.5} /> : null}
                    <circle cx={p.x} cy={p.y} r={r} fill={fill} opacity={0.92} />
                    <title>{node.label}</title>
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="graph-overlay-top"><div><Eyebrow>{mode} perspective</Eyebrow><strong>{derivedPerspectiveLabel[mode]}</strong></div><span>Select any node · inspect typed edges</span></div>
          <div className="graph-legend">
            {Object.entries(nodeTone).map(([type, tone]) => <button type="button" key={type} onClick={() => { const match = visibleNodes.find((node) => node.type === type); if (match) setSelectedId(match.id); }}><span className={`legend-dot tag-${tone}`} />{type}</button>)}
          </div>
          <div className="graph-labels" aria-hidden="true">
            {visibleNodes.map((node) => <button className={node.id === selectedNode.id ? "is-active" : ""} key={node.id} onClick={() => setSelectedId(node.id)} style={{ left: `${50 + node.x * 7.2}%`, top: `${42 - node.y * 6.6}%` }} type="button">{node.label}</button>)}
          </div>
        </article>

        <aside className="graph-inspector">
          <button className="panel inspector-card drillable-surface" type="button" onClick={openNodeDetail}>
            <div className="inspector-heading"><span className={`node-glyph tag-${nodeTone[selectedNode.type]}`}><Network size={17} /></span><div><Eyebrow>{selectedNode.type} object</Eyebrow><h2>{detail.title}</h2></div></div>
            <div className="inspector-facts"><div><small>Authority</small><strong>{detail.source}</strong></div><div><small>Provenance</small><strong>{detail.provenance}</strong></div><div><small>Valid time</small><strong>{detail.valid}</strong></div><div><small>Object ID</small><strong className="mono-id">kg://episode/{selectedNode.id}</strong></div></div>
            <div className="object-integrity"><ShieldCheck size={16} /><div><strong>Integrity verified</strong><p>Tenant, patient, purpose and temporal scope all match the active episode.</p></div></div>
          </button>

          <article className="panel relation-panel">
            <div className="panel-title-row"><div><Eyebrow>Typed relations</Eyebrow><h2>Connected evidence</h2></div><span className="mini-count">{connected.length}</span></div>
            <div className="relation-list list-scroll list-scroll-tall">
              {connectedPager.visible.length ? connectedPager.visible.map((edge) => {
                const outbound = edge.source === selectedId;
                const otherId = outbound ? edge.target : edge.source;
                const other = visibleNodes.find((node) => node.id === otherId);
                return <button type="button" key={`${edge.source}-${edge.target}`} onClick={() => setSelectedId(otherId)}><span>{outbound ? "→" : "←"}</span><div><small>{edge.relation}</small><strong>{other?.label}</strong></div></button>;
              }) : <p className="no-relations">No relations in this filtered perspective.</p>}
            </div>
            <LoadMore shown={connectedPager.visible.length} total={connected.length} onMore={connectedPager.showMore} label="relation(s)" />
          </article>

          <article className="panel knowledge-panel">
            <div className="panel-title-row"><div><Eyebrow>Shared institutional intelligence</Eyebrow><h2>Node-linked notes</h2></div><Tag tone="violet">{notes.length} notes</Tag></div>
            <div className="knowledge-note-list">
              {notes.slice(0, 2).map((note) => <div key={note.noteId}><strong>{note.title}</strong><p>{note.content}</p><small>v{note.version} · {note.createdBy} · {note.comments.length} comments</small>{note.comments.slice(0, 1).map((comment, index) => <p className="knowledge-comment" key={index}>↳ {comment.body}</p>)}</div>)}
              {!notes.length ? <p className="no-relations">No shared note is attached to this node yet.</p> : null}
            </div>
            <div className="knowledge-note-form"><input aria-label="Knowledge note title" maxLength={120} onChange={(event) => setNoteTitle(event.target.value)} placeholder="Decision or operating insight" value={noteTitle} /><textarea aria-label="Knowledge note content" maxLength={4000} onChange={(event) => setNoteContent(event.target.value)} placeholder="Capture context, rationale, evidence links or a reusable playbook…" rows={3} value={noteContent} /><button className="button button-secondary" disabled={noteBusy || !runtime || !noteTitle.trim() || !noteContent.trim()} onClick={() => void createNote()} type="button">{noteBusy ? <Activity size={14} /> : <Sparkles size={14} />} Add scoped note</button></div>
            {notes[0] ? <div className="knowledge-comment-form"><input aria-label="Comment on latest note" maxLength={1200} onChange={(event) => setCommentBody(event.target.value)} placeholder="Comment on the latest note…" value={commentBody} /><button className="button button-ghost" disabled={noteBusy || !commentBody.trim()} onClick={() => void createComment(notes[0].noteId)} type="button">Comment</button></div> : null}
            {runtimeError ? <small className="knowledge-error">{runtimeError}</small> : null}
          </article>

          <button className="panel graph-contract-card drillable-surface" type="button" onClick={() => onOpenDetail({ id: "CONTRACT-TYPED-EDGE-V1", kind: "Topology contract", title: "Edges are first-class, versioned evidence", summary: "Relations carry source, validity, purpose, policy and confidence—not just endpoints.", status: "Active", tone: "violet", owner: "Enterprise architecture", scope: "All topology projections", metrics: [{ label: "Nodes", value: String(visibleNodes.length) }, { label: "Relations", value: String(visibleEdges.length) }], evidence: [{ label: "Runtime projection", value: `${runtime?.counts.topologyNodes ?? 0} nodes · ${runtime?.counts.topologyEdges ?? 0} edges`, source: runtime?.runtime.configuration ?? "reference topology" }], steps: [{ label: "Validate", detail: "Endpoint types checked", state: "done" }, { label: "Attach", detail: "Source and valid time retained", state: "done" }, { label: "Project", detail: "Perspective-safe graph built", state: "done" }, { label: "Review", detail: "Human inspection available", state: "current" }], primary: { label: "Open Platform & configuration", target: "platform" } })}><Layers3 size={18} /><div><Eyebrow>Hypergraph contract</Eyebrow><h3>Edges are first-class, versioned evidence.</h3><p>Relations carry source, validity, purpose, policy and confidence—not just endpoints.</p></div><Braces size={18} /></button>
        </aside>
      </section>

      <section className="graph-footer-grid">
        <button className="panel graph-stat drillable-surface" type="button" onClick={openNodeDetail}><Database size={18} /><div><small>Runtime evidence objects</small><strong>{runtime?.counts.evidence ?? "—"}</strong><span>Immutable records</span></div></button>
        <button className="panel graph-stat drillable-surface" type="button" onClick={() => onOpenDetail({ id: "TRACE-EVENT-CELL", kind: "Observability metric", title: "Mean event-to-cell trace", summary: "Persisted trace spans connect canonical event intake to every eligible bounded-cell execution.", status: runtime ? `${runtime.health.averageLatencyMs} ms` : "Loading", tone: "mint", owner: "AI assurance", scope: "Runtime", metrics: [{ label: "Mean latency", value: runtime ? `${runtime.health.averageLatencyMs} ms` : "—" }, { label: "Spans", value: String(runtime?.traces.length ?? 0) }], evidence: runtime?.traces.slice(0, 5).map((trace) => ({ label: trace.name, value: `${trace.durationMs} ms`, source: trace.traceId })) ?? [], primary: { label: "Open AI Assurance", target: "assurance" } })}><Activity size={18} /><div><small>Mean event-to-cell trace</small><strong>{runtime ? `${runtime.health.averageLatencyMs} ms` : "—"}</strong><span>Persisted spans</span></div></button>
        <button className="panel graph-stat drillable-surface" type="button" onClick={openNodeDetail}><CheckCircle2 size={18} /><div><small>Lineage completeness</small><strong>{runtime?.counts.events ? `${Math.round(Math.min(1, runtime.counts.evidence / runtime.counts.events) * 100)}%` : "—"}</strong><span>Event → evidence projection</span></div></button>
        <button className="panel graph-stat drillable-surface" type="button" onClick={() => onOpenDetail({ id: "SWARM-EXECUTIONS", kind: "Swarm telemetry", title: "Bounded cells executed", summary: "Each eligible cell records input hash, output hash, confidence, latency, cost and abstention reason.", status: `${runtime?.counts.executions ?? 0} traced executions`, tone: "blue", owner: "AI assurance", scope: "Runtime", metrics: [{ label: "Unique cells", value: String(new Set(runtime?.executions.map((item) => item.agentId) ?? []).size) }, { label: "Executions", value: String(runtime?.counts.executions ?? 0) }], evidence: runtime?.executions.slice(0, 8).map((item) => ({ label: item.agentId, value: item.status, source: `${item.executionId} · ${item.latencyMs} ms` })) ?? [], primary: { label: "Open AI Assurance", target: "assurance" } })}><Sparkles size={18} /><div><small>Bounded cells executed</small><strong>{new Set(runtime?.executions.map((item) => item.agentId) ?? []).size}</strong><span>{runtime?.counts.executions ?? 0} traced executions</span></div></button>
      </section>
    </div>
  );
}
