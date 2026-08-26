import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { auditEvents, knowledgeComments, knowledgeNotes, knowledgeNoteVersions, topologyNodes } from "../../db/schema";
import { authorizedForScope, type RuntimeActor } from "./authorization";
import { hashJson } from "./crypto";
import { RUNTIME_CONFIGURATION, RUNTIME_TENANT } from "./engine";

export async function listKnowledge(nodeId?: string) {
  const db = getDb();
  const notes = nodeId
    ? await db.select().from(knowledgeNotes).where(and(eq(knowledgeNotes.tenantId, RUNTIME_TENANT), eq(knowledgeNotes.nodeId, nodeId))).orderBy(desc(knowledgeNotes.updatedAt)).limit(30)
    : await db.select().from(knowledgeNotes).where(eq(knowledgeNotes.tenantId, RUNTIME_TENANT)).orderBy(desc(knowledgeNotes.updatedAt)).limit(30);
  const noteIds = new Set(notes.map((note) => note.noteId));
  const [allVersions, allComments] = await Promise.all([
    db.select().from(knowledgeNoteVersions).orderBy(desc(knowledgeNoteVersions.changedAt)).limit(100),
    db.select().from(knowledgeComments).orderBy(desc(knowledgeComments.createdAt)).limit(100),
  ]);
  return notes.map((note) => ({
    ...note,
    versions: allVersions.filter((version) => noteIds.has(version.noteId) && version.noteId === note.noteId),
    comments: allComments.filter((comment) => noteIds.has(comment.noteId) && comment.noteId === note.noteId),
  }));
}

export async function createKnowledgeNote(input: { nodeId: string; title: string; content: string; visibility?: string }, actor: RuntimeActor) {
  const db = getDb();
  await assertNodeAuthority(input.nodeId, actor);
  const noteId = `NOTE-${crypto.randomUUID()}`;
  const visibility = input.visibility === "role" || input.visibility === "private" ? input.visibility : "scope";
  const title = requireText(input.title, "title", 120);
  const content = requireText(input.content, "content", 4000);
  await db.insert(knowledgeNotes).values({ noteId, tenantId: RUNTIME_TENANT, nodeId: input.nodeId, title, content, version: 1, visibility, createdBy: actor.email });
  await db.insert(knowledgeNoteVersions).values({ versionId: `${noteId}:1`, noteId, version: 1, title, content, changedBy: actor.email });
  await auditKnowledge(actor, "create-knowledge-note", noteId, { nodeId: input.nodeId, visibility, version: 1 });
  return { noteId, version: 1 };
}

export async function updateKnowledgeNote(input: { noteId: string; title: string; content: string }, actor: RuntimeActor) {
  const db = getDb();
  const [note] = await db.select().from(knowledgeNotes).where(and(eq(knowledgeNotes.tenantId, RUNTIME_TENANT), eq(knowledgeNotes.noteId, input.noteId))).limit(1);
  if (!note) throw new Error("KNOWLEDGE_NOTE_NOT_FOUND");
  await assertNodeAuthority(note.nodeId, actor);
  const title = requireText(input.title, "title", 120);
  const content = requireText(input.content, "content", 4000);
  const version = note.version + 1;
  const updatedAt = new Date().toISOString();
  await db.update(knowledgeNotes).set({ title, content, version, updatedAt }).where(eq(knowledgeNotes.noteId, note.noteId));
  await db.insert(knowledgeNoteVersions).values({ versionId: `${note.noteId}:${version}`, noteId: note.noteId, version, title, content, changedBy: actor.email });
  await auditKnowledge(actor, "update-knowledge-note", note.noteId, { nodeId: note.nodeId, version });
  return { noteId: note.noteId, version };
}

export async function createKnowledgeComment(input: { noteId: string; body: string }, actor: RuntimeActor) {
  const db = getDb();
  const [note] = await db.select().from(knowledgeNotes).where(and(eq(knowledgeNotes.tenantId, RUNTIME_TENANT), eq(knowledgeNotes.noteId, input.noteId))).limit(1);
  if (!note) throw new Error("KNOWLEDGE_NOTE_NOT_FOUND");
  await assertNodeAuthority(note.nodeId, actor);
  const commentId = `COMMENT-${crypto.randomUUID()}`;
  const body = requireText(input.body, "body", 1200);
  await db.insert(knowledgeComments).values({ commentId, noteId: note.noteId, body, createdBy: actor.email });
  await auditKnowledge(actor, "comment-on-knowledge-note", note.noteId, { commentId, nodeId: note.nodeId });
  return { commentId };
}

async function assertNodeAuthority(nodeId: string, actor: RuntimeActor) {
  const db = getDb();
  const [node] = await db.select().from(topologyNodes).where(and(eq(topologyNodes.tenantId, RUNTIME_TENANT), eq(topologyNodes.nodeId, nodeId))).limit(1);
  if (!node) throw new Error("TOPOLOGY_NODE_NOT_FOUND");
  const authorization = authorizedForScope(actor, node.scopeId);
  if (!authorization.allowed) throw new Error(`AUTHORIZATION_DENIED: ${authorization.reason}`);
}

function requireText(value: string, field: string, maximum: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field.toUpperCase()}_REQUIRED`);
  if (text.length > maximum) throw new Error(`${field.toUpperCase()}_TOO_LONG`);
  return text;
}

async function auditKnowledge(actor: RuntimeActor, action: string, noteId: string, detail: Record<string, unknown>) {
  const db = getDb();
  await db.insert(auditEvents).values({
    eventId: `AUD-${crypto.randomUUID()}`,
    category: "human-action",
    actor: actor.email,
    action,
    entityType: "knowledge-note",
    entityId: noteId,
    decision: "completed",
    evidenceHash: await hashJson(detail),
    detail: JSON.stringify({ ...detail, role: actor.role, scopeId: actor.scopeId }),
    configurationVersion: RUNTIME_CONFIGURATION,
  });
}
