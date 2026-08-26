import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const schemaUrl = new URL("../db/control-plane.portable.sql", import.meta.url);

test("control-plane schema uses the SQLite and PostgreSQL shared SQL subset", async () => {
  const sql = await readFile(schemaUrl, "utf8");
  for (const forbidden of [
    /\bAUTOINCREMENT\b/i,
    /\bWITHOUT\s+ROWID\b/i,
    /\bPRAGMA\b/i,
    /\bjson_extract\s*\(/i,
    /\bdatetime\s*\(/i,
    /\bSERIAL\b/i,
    /\bJSONB\b/i,
    /\bGENERATED\s+ALWAYS\b/i,
  ]) {
    assert.equal(forbidden.test(sql), false, "portable schema contains " + forbidden);
  }
  for (const table of [
    "tenant",
    "identity_subject",
    "role_grant",
    "agent_definition",
    "canonical_event",
    "evidence_object",
    "outcome_episode",
    "agent_run",
    "agent_message",
    "work_item",
    "work_item_evidence",
    "work_item_activity",
    "work_item_action",
    "action_decision",
    "outbox_message",
    "acknowledgement",
    "audit_record",
  ]) {
    assert.match(sql, new RegExp("CREATE TABLE IF NOT EXISTS " + table + "\\b"));
  }
});

test("portable control-plane schema executes and closes a workflow in SQLite", async () => {
  const sql = await readFile(schemaUrl, "utf8");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(sql);
  const now = "2026-08-22T12:00:00.000Z";
  db.prepare("INSERT INTO tenant VALUES (?, ?, ?, ?)").run("tenant-demo", "Synthetic renal enterprise", "active", now);
  db.prepare("INSERT INTO identity_subject VALUES (?, ?, ?, ?, ?, ?)").run("subject-1", "tenant-demo", "workspace-user", "operator@example.test", "active", now);
  db.prepare("INSERT INTO configuration_release VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("release-1", "tenant-demo", "1.0.0", "active", "a".repeat(64), "operator@example.test", "operator@example.test", now, null, now);
  db.prepare("INSERT INTO agent_definition VALUES (" + Array(25).fill("?").join(", ") + ")").run(
    "agent-definition-1", "tenant-demo", "assessment-cell", "1.0.0", "Assessment intelligence", "ai-agent", "grounded language extraction",
    JSON.stringify(["fa"]), JSON.stringify(["assessment.response.v1"]), JSON.stringify(["assessment.fact-candidate.v1"]), JSON.stringify(["request-human-confirmation"]),
    JSON.stringify(["patient-scoped"]), "[]", "C", 9400, 5000, 100, "abstain", 1, "active", "1.0.0", "b".repeat(64), now, null, now,
  );
  db.prepare("INSERT INTO canonical_event VALUES (" + Array(19).fill("?").join(", ") + ")").run(
    "event-1", "tenant-demo", "assessment.response.v1", "1.0.0", "patient", "SYN-10042", "care-coordination", now, now,
    "episode-1", null, "synthetic-emr", "QuestionnaireResponse", "tenant-demo:SYN-10042", "trace-1", JSON.stringify(["phi"]), "{}", "c".repeat(64), "accepted",
  );
  db.prepare("INSERT INTO evidence_object VALUES (" + Array(14).fill("?").join(", ") + ")").run(
    "evidence-1", "tenant-demo", "patient", "SYN-10042", "assessment-answer", "event-1", "Tuesday ride unavailable", "{}", 9600,
    "care-coordination", now, null, now, "d".repeat(64),
  );
  db.prepare("INSERT INTO outcome_episode VALUES (" + Array(18).fill("?").join(", ") + ")").run(
    "episode-1", "tenant-demo", "treatment-continuity", "facility", "facility-franklin", "SYN-10042", "Post-discharge continuity",
    "awaiting-approval", "critical", 9600, "fa", "B", "Request coordinator review", now, null, 1, "1.0.0", now,
  );
  db.prepare("INSERT INTO agent_run VALUES (" + Array(15).fill("?").join(", ") + ")").run(
    "run-1", "tenant-demo", "agent-definition-1", "event-1", "episode-1", "trace-1", "completed", "e".repeat(64), "f".repeat(64),
    9600, 28, 5, null, now, now,
  );
  db.prepare("INSERT INTO work_item VALUES (" + Array(18).fill("?").join(", ") + ")").run(
    "work-item-1", "tenant-demo", "outcome-episode", "episode-1", "episode-1", "facility-franklin", "Post-discharge continuity",
    "Coordinate the next treatment", "awaiting-approval", "fa", now, "B", "coordinate", 1, now, null, now, "1.0.0",
  );
  db.prepare("INSERT INTO work_item_evidence VALUES (" + Array(7).fill("?").join(", ") + ")").run("wie-1", "tenant-demo", "work-item-1", "evidence-1", 1, "care-coordination", now);
  db.prepare("INSERT INTO work_item_action VALUES (" + Array(13).fill("?").join(", ") + ")").run(
    "action-1", "tenant-demo", "work-item-1", "request-coordinator-review", "B", JSON.stringify(["fa"]), 1, "work-item-1:v1",
    "kafka-outbox", "coordinator.task.accepted.v1", JSON.stringify({ afterMinutes: 30 }), "approved", now,
  );
  db.prepare("INSERT INTO action_decision VALUES (" + Array(11).fill("?").join(", ") + ")").run(
    "decision-1", "tenant-demo", "action-1", "subject-1", "fa", "facility-franklin", "approved", "action-boundary@5.0.0", "[]", "1".repeat(64), now,
  );
  db.prepare("INSERT INTO outbox_message VALUES (" + Array(14).fill("?").join(", ") + ")").run(
    "outbox-1", "tenant-demo", "action-1", "coordinator.task.requested.v1", "episode-1", "{}", "2".repeat(64), "published", 1,
    null, null, null, now, now,
  );
  db.prepare("INSERT INTO acknowledgement VALUES (" + Array(8).fill("?").join(", ") + ")").run(
    "ack-1", "tenant-demo", "outbox-1", "coordinator.task.accepted.v1", "workflow-service", "{}", "3".repeat(64), now,
  );
  const result = db.prepare(
    "SELECT w.work_item_id, a.status, k.acknowledgement_type FROM work_item w JOIN work_item_action a ON a.work_item_id = w.work_item_id JOIN outbox_message o ON o.action_id = a.action_id JOIN acknowledgement k ON k.outbox_id = o.outbox_id",
  ).get();
  assert.deepEqual({ ...result }, {
    work_item_id: "work-item-1",
    status: "approved",
    acknowledgement_type: "coordinator.task.accepted.v1",
  });
  db.close();
});
