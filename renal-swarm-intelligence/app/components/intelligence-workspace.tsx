"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  FogExp2,
  Group,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Raycaster,
  RingGeometry,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
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
import { graphEdges, graphNodes } from "../../lib/demo-data";
import { ensureRuntime, type RuntimeSnapshot } from "../../lib/runtime/client";
import type { GraphEdge, GraphNode } from "../../lib/types";
import type { NavigationId } from "../../lib/types";
import type { OpenWorkflowDetail } from "../../lib/workflow-detail";
import { Eyebrow, Tag } from "./ui";

const nodeColors: Record<(typeof graphNodes)[number]["type"], number> = {
  enterprise: 0x63e6be,
  division: 0x5ed8e8,
  region: 0x75a8ff,
  facility: 0x8df0d0,
  patient: 0x8df0d0,
  assessment: 0xb49cff,
  signal: 0x75a8ff,
  cluster: 0xf27987,
  cell: 0x5ed8e8,
  policy: 0xb49cff,
  action: 0xefbd68,
  intervention: 0xefbd68,
  outcome: 0x63e6be,
  measure: 0xf27987,
  source: 0x9fb6ad,
};

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

const relationDetails: Record<string, { title: string; source: string; provenance: string; valid: string }> = {
  enterprise: { title: "Riverbend Kidney Care", source: "Enterprise operating model 2026.1.0", provenance: "Synthetic hierarchy · 312 facility projections", valid: "2026-08-21 08:41 CT" },
  division: { title: "Southeast Division", source: "Configured organization scope", provenance: "74 facilities · DVP decision boundary", valid: "2026-08-21 08:41 CT" },
  region: { title: "Middle Tennessee Region", source: "Configured organization scope", provenance: "18 facilities · ROD decision boundary", valid: "2026-08-21 08:41 CT" },
  franklin: { title: "Riverbend Franklin", source: "Facility twin projection", provenance: "Chairs + staff + machines + patients", valid: "2026-08-21 08:41 CT" },
  columbia: { title: "Riverbend Columbia", source: "Facility twin projection", provenance: "Cross-facility synthetic operating state", valid: "2026-08-21 08:41 CT" },
  murfreesboro: { title: "Riverbend Murfreesboro", source: "Facility twin projection", provenance: "Cross-facility synthetic operating state", valid: "2026-08-21 08:41 CT" },
  patient: { title: "Maya Ortiz", source: "Canonical patient projection", provenance: "8 signed source envelopes", valid: "2026-08-21 07:17 CT" },
  assessment: { title: "Ride answer", source: "Assessment AR-1401", provenance: "Exact answer + human confirmation", valid: "2026-08-18" },
  discharge: { title: "Hospital discharge", source: "FHIR Encounter", provenance: "hospital.transition.v2 · hash verified", valid: "2026-08-21 07:14 CT" },
  "workforce-cluster": { title: "Weekend coverage cluster", source: "Cross-facility pattern projection", provenance: "11 gaps · 3 facilities · 43 exposed treatments", valid: "2026-08-21 08:41 CT" },
  "access-cluster": { title: "Access risk cluster", source: "Quality + assessment evidence", provenance: "Typed relations only · no diagnosis inferred", valid: "2026-08-21 08:41 CT" },
  continuity: { title: "Continuity cell", source: "Cell manifest 1.0.0", provenance: "Rules + forecasting · bounded output", valid: "Replay TR-4" },
  capacity: { title: "Capacity cell", source: "Cell manifest 1.0.0", provenance: "Constraint optimization · no write access", valid: "Replay TR-4" },
  quality: { title: "Quality cell", source: "Cell manifest 1.0.0", provenance: "Deterministic measures + surveillance", valid: "Replay SI-398" },
  policy: { title: "Action policy 4.2", source: "Policy registry", provenance: "Default deny · role and purpose constrained", valid: "Release 2026.08.4" },
  plan: { title: "Coverage + chair plan", source: "Outcome harness", provenance: "Class B · ROD and FA review required", valid: "Pending authorization" },
  outcome: { title: "Treatments kept", source: "Outcome verification contract", provenance: "Coverage + chair + attendance acknowledgments", valid: "Not yet observed" },
  measure: { title: "Continuity outcome", source: "Internal outcome measure 2.1", provenance: "Derived only after verified event", valid: "Future state" },
  source: { title: "FHIR Encounter", source: "Synthetic EMR adapter", provenance: "FHIR R4 Encounter.period.end", valid: "2026-08-21 07:14 CT" },
  "cms-authority": { title: "CMS authority source", source: "Public authority registry", provenance: "Real public source · effective snapshot retained", valid: "Source-effective window" },
};

type GraphMode = "enterprise" | "patient" | "regulatory" | "swarm";
const perspectiveTypes: Record<GraphMode, (typeof graphNodes)[number]["type"][]> = {
  enterprise: ["enterprise", "division", "region", "facility", "patient", "assessment", "signal", "cluster", "cell", "policy", "intervention", "outcome", "measure", "source"],
  patient: ["facility", "patient", "assessment", "signal", "cell", "policy", "intervention", "outcome", "measure", "source"],
  regulatory: ["enterprise", "division", "region", "facility", "cluster", "policy", "outcome", "measure", "source"],
  swarm: ["region", "facility", "signal", "cluster", "cell", "policy", "intervention", "outcome"],
};
const perspectiveRoot: Record<GraphMode, string> = { enterprise: "enterprise", patient: "patient", regulatory: "cms-authority", swarm: "workforce-cluster" };
const perspectiveLabel: Record<GraphMode, string> = { enterprise: "312 facilities · 8 outcome domains", patient: "Maya Ortiz · temporal care journey", regulatory: "Authority → measure → facility impact", swarm: "Events → cells → policy → action" };

export default function IntelligenceWorkspace({ onOpenDetail }: { onOpenDetail: OpenWorkflowDetail }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState("enterprise");
  const [mode, setMode] = useState<GraphMode>("enterprise");
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Array<{ noteId: string; title: string; content: string; version: number; createdBy: string; comments: Array<Record<string, unknown>> }>>([]);
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
  const detail = relationDetails[selectedNode.id] ?? { title: selectedNode.label, source: String(runtimeNode?.attributes.source ?? runtimeNode?.attributes.resource ?? "Canonical runtime projection"), provenance: runtimeNode?.attributes.contentHash ? `SHA-256 ${String(runtimeNode.attributes.contentHash).slice(0, 16)}…` : "Typed edge with persisted provenance", valid: String(runtimeNode?.attributes.validTime ?? "Current valid-time projection") };
  const connected = useMemo(
    () => visibleEdges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id),
    [selectedNode.id, visibleEdges],
  );
  const searchMatches = useMemo(() => searchQuery.trim() ? allNodes.filter((node) => `${node.label} ${node.type} ${node.id}`.toLowerCase().includes(searchQuery.trim().toLowerCase())).slice(0, 8) : [], [allNodes, searchQuery]);

  useEffect(() => {
    let active = true;
    void ensureRuntime().then((snapshot) => {
      if (active) setRuntime(snapshot);
    }).catch((error) => {
      if (active) setRuntimeError(error instanceof Error ? error.message : "Runtime graph unavailable");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedNode?.id || !runtime) return;
    let active = true;
    void fetch(`/api/knowledge?nodeId=${encodeURIComponent(selectedNode.id)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { notes?: typeof notes; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Knowledge query failed");
        if (active) setNotes(payload.notes ?? []);
      })
      .catch((error) => { if (active) setRuntimeError(error instanceof Error ? error.message : "Knowledge query failed"); });
    return () => { active = false; };
  }, [runtime, selectedNode?.id]);

  async function createNote() {
    if (!noteTitle.trim() || !noteContent.trim()) return;
    setNoteBusy(true);
    try {
      const response = await fetch("/api/knowledge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "create-note", roleId: "dvp", nodeId: selectedNode.id, title: noteTitle, content: noteContent, visibility: "scope" }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Note write failed");
      setNoteTitle("");
      setNoteContent("");
      const refreshed = await fetch(`/api/knowledge?nodeId=${encodeURIComponent(selectedNode.id)}`, { cache: "no-store" });
      const data = await refreshed.json() as { notes?: typeof notes };
      setNotes(data.notes ?? []);
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
      const response = await fetch("/api/knowledge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "comment", roleId: "dvp", noteId, body: commentBody }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Comment write failed");
      setCommentBody("");
      const refreshed = await fetch(`/api/knowledge?nodeId=${encodeURIComponent(selectedNode.id)}`, { cache: "no-store" });
      const data = await refreshed.json() as { notes?: typeof notes };
      setNotes(data.notes ?? []);
      setRuntimeError(null);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Comment write failed");
    } finally {
      setNoteBusy(false);
    }
  }

  function openNodeDetail() {
    const target: NavigationId = selectedNode.type === "patient" ? "patient" : selectedNode.type === "assessment" ? "assessments" : selectedNode.type === "facility" ? "facility" : selectedNode.type === "measure" || selectedNode.id === "cms-authority" ? "cms" : selectedNode.type === "cell" || selectedNode.type === "policy" ? "assurance" : selectedNode.type === "intervention" || selectedNode.type === "outcome" ? "command" : "ecosystem";
    onOpenDetail({ id: selectedNode.id, kind: `${selectedNode.type} topology object`, title: detail.title, summary: `${detail.provenance}. This object has ${connected.length} visible typed relations in the ${mode} perspective.`, status: detail.valid, tone: nodeTone[selectedNode.type], owner: detail.source, scope: runtimeNode?.attributes.scopeId ? String(runtimeNode.attributes.scopeId) : perspectiveLabel[mode], metrics: [{ label: "Connected edges", value: String(connected.length) }, { label: "Perspective", value: mode }, { label: "Shared notes", value: String(notes.length) }], evidence: [{ label: "Authority / source", value: detail.source, source: detail.provenance }, { label: "Valid time", value: detail.valid, source: "Bitemporal topology projection" }, ...connected.slice(0, 8).map((edge) => ({ label: edge.relation, value: `${edge.source} → ${edge.target}`, source: "Typed relation" }))], activity: [{ time: detail.valid, title: "Object projected", detail: detail.provenance, state: "done" }, { time: "Current", title: `${connected.length} relations resolved`, detail: `${mode} perspective`, state: "current" }], steps: [{ label: "Source", detail: "Evidence authority retained", state: "done" }, { label: "Project", detail: "Node and typed edges materialized", state: "done" }, { label: "Interpret", detail: `${mode} perspective selected`, state: "current" }, { label: "Act", detail: `Continue in ${target}`, state: "pending" }], primary: { label: target === "patient" ? "Open Patient Intelligence" : target === "assessments" ? "Open Assessment Intelligence" : target === "facility" ? "Open Facility Operations" : target === "cms" ? "Open CMS Operations" : target === "assurance" ? "Open AI Assurance" : target === "command" ? "Open Outcome Command" : "Open Swarm Control", target } });
  }

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new Scene();
    scene.fog = new FogExp2(0x081411, 0.055);
    const camera = new PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0, 15);
    camera.lookAt(0, 0, 0);
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const graphGroup = new Group();
    scene.add(graphGroup);
    const nodeMeshes: Mesh[] = [];
    const nodeMap = new Map<string, Vector3>();

    for (const node of visibleNodes) nodeMap.set(node.id, new Vector3(node.x, node.y, node.z));

    for (const edge of visibleEdges) {
      const start = nodeMap.get(edge.source);
      const end = nodeMap.get(edge.target);
      if (!start || !end) continue;
      const geometry = new BufferGeometry().setFromPoints([start, end]);
      const material = new LineBasicMaterial({ color: 0x4a8d7b, transparent: true, opacity: 0.38 });
      graphGroup.add(new Line(geometry, material));
    }

    for (const node of visibleNodes) {
      const size = node.type === "enterprise" ? 0.46 : node.type === "facility" || node.type === "patient" ? 0.36 : 0.27;
      const geometry = new IcosahedronGeometry(size, 2);
      const material = new MeshBasicMaterial({ color: nodeColors[node.type], transparent: true, opacity: 0.95 });
      const mesh = new Mesh(geometry, material);
      mesh.position.set(node.x, node.y, node.z);
      mesh.userData.id = node.id;
      graphGroup.add(mesh);
      nodeMeshes.push(mesh);

      const ring = new Mesh(
        new RingGeometry(size + 0.11, size + 0.14, 48),
        new MeshBasicMaterial({ color: nodeColors[node.type], transparent: true, opacity: 0.22, side: DoubleSide }),
      );
      ring.position.copy(mesh.position);
      graphGroup.add(ring);
    }

    const particles = new BufferGeometry();
    const positions = new Float32Array(180 * 3);
    for (let index = 0; index < 180; index += 1) {
      positions[index * 3] = (Math.random() - 0.5) * 12;
      positions[index * 3 + 1] = (Math.random() - 0.5) * 10 - 1;
      positions[index * 3 + 2] = (Math.random() - 0.5) * 5;
    }
    particles.setAttribute("position", new BufferAttribute(positions, 3));
    const points = new Points(particles, new PointsMaterial({ color: 0x63e6be, size: 0.025, transparent: true, opacity: 0.36 }));
    scene.add(points);

    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const onPointerDown = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(nodeMeshes)[0];
      if (hit?.object.userData.id) setSelectedId(hit.object.userData.id as string);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    let frame = 0;
    let request = 0;
    const animate = () => {
      request = requestAnimationFrame(animate);
      frame += 0.008;
      graphGroup.rotation.y = Math.sin(frame * 0.22) * 0.05;
      points.rotation.z = frame * 0.012;
      nodeMeshes.forEach((mesh, index) => {
        const selected = mesh.userData.id === selectedId;
        const pulse = 1 + Math.sin(frame * 2 + index) * 0.035;
        const target = selected ? 1.3 : pulse;
        mesh.scale.lerp(new Vector3(target, target, target), 0.12);
      });
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(request);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      scene.traverse((object) => {
        if (object instanceof Mesh || object instanceof Line || object instanceof Points) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [mode, selectedId, visibleEdges, visibleNodes]);

  return (
    <div className="view-stack intelligence-view">
      <header className="view-heading">
        <div>
          <Eyebrow>Shared Intelligence · Obsidian-style temporal hypergraph</Eyebrow>
          <h1>Explore the enterprise renal-care topology.</h1>
          <p>Patient–facility–measure–intervention relationships, cross-facility clusters, risk propagation, regulatory impact and swarm dependencies.</p>
        </div>
        <div className="heading-actions"><button className="button button-secondary" type="button" onClick={() => setSearchOpen((current) => !current)}><Search size={15} /> {searchOpen ? "Close search" : "Search graph"}</button><button className="button button-primary" type="button" onClick={() => { setMode("patient"); setSelectedId("patient"); }}><Focus size={15} /> Focus open episode</button></div>
      </header>

      {searchOpen ? <section className="graph-search panel"><Search size={16} /><input autoFocus aria-label="Search topology objects" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search patient, facility, measure, agent, source…" />{searchMatches.length ? <div>{searchMatches.map((node) => <button type="button" key={node.id} onClick={() => { setMode("enterprise"); setSelectedId(node.id); setSearchOpen(false); setSearchQuery(""); }}><Tag tone={nodeTone[node.type]}>{node.type}</Tag><span><strong>{node.label}</strong><small>{node.id}</small></span></button>)}</div> : searchQuery ? <small>No matching topology objects.</small> : null}</section> : null}

      <section className="graph-toolbar panel">
        <div className="segmented-control" aria-label="Graph perspective">
          {(["enterprise", "patient", "regulatory", "swarm"] as GraphMode[]).map((item) => <button className={mode === item ? "is-active" : ""} key={item} onClick={() => { setMode(item); setSelectedId(perspectiveRoot[item]); }} type="button">{item}</button>)}
        </div>
        <div className="graph-time"><Clock3 size={14} /><span>Valid at</span><strong>21 Aug 2026 · 07:17 CT</strong><input aria-label="Graph time" type="range" min="0" max="100" defaultValue="100" /></div>
        <Tag tone={runtime ? "mint" : runtimeError ? "red" : "violet"}><Activity size={11} /> {visibleNodes.length} nodes · {visibleEdges.length} relations · {runtime ? "D1 projection" : "loading"}</Tag>
      </section>

      <section className="intelligence-grid">
        <article className="panel graph-panel">
          <div className="graph-stage" ref={mountRef} aria-label="Interactive Three.js enterprise renal-care hypergraph" />
          <div className="graph-overlay-top"><div><Eyebrow>{mode} perspective</Eyebrow><strong>{perspectiveLabel[mode]}</strong></div><span>Select any node · inspect typed edges</span></div>
          <div className="graph-legend">
            {Object.entries(nodeTone).map(([type, tone]) => <button type="button" key={type} onClick={() => { const match = visibleNodes.find((node) => node.type === type); if (match) setSelectedId(match.id); }}><span className={`legend-dot tag-${tone}`} />{type}</button>)}
          </div>
          <div className="graph-labels" aria-hidden="true">
            {visibleNodes.map((node) => <button className={node.id === selectedNode.id ? "is-active" : ""} key={node.id} onClick={() => setSelectedId(node.id)} style={{ left: `${50 + node.x * 7.6}%`, top: `${40 - node.y * 7.6}%` }} type="button">{node.label}</button>)}
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
            <div className="relation-list">
              {connected.length ? connected.map((edge) => {
                const outbound = edge.source === selectedId;
                const otherId = outbound ? edge.target : edge.source;
                const other = visibleNodes.find((node) => node.id === otherId);
                return <button type="button" key={`${edge.source}-${edge.target}`} onClick={() => setSelectedId(otherId)}><span>{outbound ? "→" : "←"}</span><div><small>{edge.relation}</small><strong>{other?.label}</strong></div></button>;
              }) : <p className="no-relations">No relations in this filtered perspective.</p>}
            </div>
          </article>

          <article className="panel knowledge-panel">
            <div className="panel-title-row"><div><Eyebrow>Shared institutional intelligence</Eyebrow><h2>Node-linked notes</h2></div><Tag tone="violet">{notes.length} notes</Tag></div>
            <div className="knowledge-note-list">
              {notes.slice(0, 2).map((note) => <div key={note.noteId}><strong>{note.title}</strong><p>{note.content}</p><small>v{note.version} · {note.createdBy} · {note.comments.length} comments</small>{note.comments.slice(0, 1).map((comment) => <p className="knowledge-comment" key={String(comment.commentId)}>↳ {String(comment.body)}</p>)}</div>)}
              {!notes.length ? <p className="no-relations">No shared note is attached to this node yet.</p> : null}
            </div>
            <div className="knowledge-note-form"><input aria-label="Knowledge note title" maxLength={120} onChange={(event) => setNoteTitle(event.target.value)} placeholder="Decision or operating insight" value={noteTitle} /><textarea aria-label="Knowledge note content" maxLength={4000} onChange={(event) => setNoteContent(event.target.value)} placeholder="Capture context, rationale, evidence links or a reusable playbook…" rows={3} value={noteContent} /><button className="button button-secondary" disabled={noteBusy || !runtime || !noteTitle.trim() || !noteContent.trim()} onClick={() => void createNote()} type="button">{noteBusy ? <Activity size={14} /> : <Sparkles size={14} />} Add scoped note</button></div>
            {notes[0] ? <div className="knowledge-comment-form"><input aria-label="Comment on latest note" maxLength={1200} onChange={(event) => setCommentBody(event.target.value)} placeholder="Comment on the latest note…" value={commentBody} /><button className="button button-ghost" disabled={noteBusy || !commentBody.trim()} onClick={() => void createComment(notes[0].noteId)} type="button">Comment</button></div> : null}
            {runtimeError ? <small className="knowledge-error">{runtimeError}</small> : null}
          </article>

          <button className="panel graph-contract-card drillable-surface" type="button" onClick={() => onOpenDetail({ id: "CONTRACT-TYPED-EDGE-V1", kind: "Topology contract", title: "Edges are first-class, versioned evidence", summary: "Relations carry source, validity, purpose, policy and confidence—not just endpoints.", status: "Active", tone: "violet", owner: "Enterprise architecture", scope: "All topology projections", metrics: [{ label: "Nodes", value: String(visibleNodes.length) }, { label: "Relations", value: String(visibleEdges.length) }], evidence: [{ label: "Runtime projection", value: `${runtime?.counts.topologyNodes ?? 0} nodes · ${runtime?.counts.topologyEdges ?? 0} edges`, source: runtime?.runtime.configuration ?? "reference topology" }], steps: [{ label: "Validate", detail: "Endpoint types checked", state: "done" }, { label: "Attach", detail: "Source and valid time retained", state: "done" }, { label: "Project", detail: "Perspective-safe graph built", state: "done" }, { label: "Review", detail: "Human inspection available", state: "current" }], primary: { label: "Open Configuration Studio", target: "configuration" } })}><Layers3 size={18} /><div><Eyebrow>Hypergraph contract</Eyebrow><h3>Edges are first-class, versioned evidence.</h3><p>Relations carry source, validity, purpose, policy and confidence—not just endpoints.</p></div><Braces size={18} /></button>
        </aside>
      </section>

      <section className="graph-footer-grid">
        <button className="panel graph-stat drillable-surface" type="button" onClick={openNodeDetail}><Database size={18} /><div><small>Runtime evidence objects</small><strong>{runtime?.counts.evidence ?? "—"}</strong><span>Immutable D1 records</span></div></button>
        <button className="panel graph-stat drillable-surface" type="button" onClick={() => onOpenDetail({ id: "TRACE-EVENT-CELL", kind: "Observability metric", title: "Mean event-to-cell trace", summary: "Persisted trace spans connect canonical event intake to every eligible bounded-cell execution.", status: runtime ? `${runtime.health.averageLatencyMs} ms` : "Loading", tone: "mint", owner: "AI assurance", scope: "Runtime", metrics: [{ label: "Mean latency", value: runtime ? `${runtime.health.averageLatencyMs} ms` : "—" }, { label: "Spans", value: String(runtime?.traces.length ?? 0) }], evidence: runtime?.traces.slice(0, 5).map((trace) => ({ label: trace.name, value: `${trace.durationMs} ms`, source: trace.traceId })) ?? [], primary: { label: "Open AI Assurance", target: "assurance" } })}><Activity size={18} /><div><small>Mean event-to-cell trace</small><strong>{runtime ? `${runtime.health.averageLatencyMs} ms` : "—"}</strong><span>Persisted spans</span></div></button>
        <button className="panel graph-stat drillable-surface" type="button" onClick={openNodeDetail}><CheckCircle2 size={18} /><div><small>Lineage completeness</small><strong>{runtime?.counts.events ? `${Math.round(Math.min(1, runtime.counts.evidence / runtime.counts.events) * 100)}%` : "—"}</strong><span>Event → evidence projection</span></div></button>
        <button className="panel graph-stat drillable-surface" type="button" onClick={() => onOpenDetail({ id: "SWARM-EXECUTIONS", kind: "Swarm telemetry", title: "Bounded cells executed", summary: "Each eligible cell records input hash, output hash, confidence, latency, cost and abstention reason.", status: `${runtime?.counts.executions ?? 0} traced executions`, tone: "blue", owner: "AI assurance", scope: "Runtime", metrics: [{ label: "Unique cells", value: String(new Set(runtime?.executions.map((item) => item.agentId) ?? []).size) }, { label: "Executions", value: String(runtime?.counts.executions ?? 0) }], evidence: runtime?.executions.slice(0, 8).map((item) => ({ label: item.agentId, value: item.status, source: `${item.executionId} · ${item.latencyMs} ms` })) ?? [], primary: { label: "Open AI Assurance", target: "assurance" } })}><Sparkles size={18} /><div><small>Bounded cells executed</small><strong>{new Set(runtime?.executions.map((item) => item.agentId) ?? []).size}</strong><span>{runtime?.counts.executions ?? 0} traced executions</span></div></button>
      </section>
    </div>
  );
}

function isGraphNodeType(value: string): value is GraphNode["type"] {
  return value in nodeColors;
}
