import { actorFromRequest } from "../../../lib/runtime/engine";
import { requireAdapterOrOperator } from "../../../lib/runtime/authorization";
import { createKnowledgeComment, createKnowledgeNote, listKnowledge, updateKnowledgeNote } from "../../../lib/runtime/knowledge";

function statusFor(error: unknown) {
  const message = error instanceof Error ? error.message : "KNOWLEDGE_ERROR";
  if (message === "AUTHENTICATION_REQUIRED") return 401;
  if (message.includes("AUTHORIZATION")) return 403;
  if (message.endsWith("_NOT_FOUND")) return 404;
  if (message.endsWith("_REQUIRED") || message.endsWith("_TOO_LONG")) return 400;
  if (message.includes("no such table")) return 503;
  return 500;
}

export async function GET(request: Request) {
  try {
    const actor = actorFromRequest(request);
    requireAdapterOrOperator(actor, "knowledge");
    const nodeId = new URL(request.url).searchParams.get("nodeId") ?? undefined;
    return Response.json({ notes: await listKnowledge(nodeId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unexpected knowledge error" }, { status: statusFor(error) });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const actor = actorFromRequest(request, typeof payload.roleId === "string" ? payload.roleId : undefined);
    requireAdapterOrOperator(actor, "knowledge");
    const operation = typeof payload.operation === "string" ? payload.operation : "";
    if (operation === "create-note") {
      if (typeof payload.nodeId !== "string") return Response.json({ error: "nodeId is required" }, { status: 400 });
      const result = await createKnowledgeNote({ nodeId: payload.nodeId, title: String(payload.title ?? ""), content: String(payload.content ?? ""), visibility: typeof payload.visibility === "string" ? payload.visibility : undefined }, actor);
      return Response.json({ result }, { status: 201 });
    }
    if (operation === "update-note") {
      if (typeof payload.noteId !== "string") return Response.json({ error: "noteId is required" }, { status: 400 });
      return Response.json({ result: await updateKnowledgeNote({ noteId: payload.noteId, title: String(payload.title ?? ""), content: String(payload.content ?? "") }, actor) });
    }
    if (operation === "comment") {
      if (typeof payload.noteId !== "string") return Response.json({ error: "noteId is required" }, { status: 400 });
      return Response.json({ result: await createKnowledgeComment({ noteId: payload.noteId, body: String(payload.body ?? "") }, actor) }, { status: 201 });
    }
    return Response.json({ error: "Unsupported knowledge operation" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unexpected knowledge error" }, { status: statusFor(error) });
  }
}
