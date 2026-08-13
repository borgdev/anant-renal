#!/usr/bin/env node
// Build the mixed-sample xlsx fixture used by the entity compiler.
// Deterministic — same input every run.

import * as XLSX from 'xlsx';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'examples/entity-packs/mixed-sample/onboarding.xlsx';
mkdirSync(dirname(OUT), { recursive: true });

const wb = XLSX.utils.book_new();

// -------- Data sheet: DialysisSession --------
const sessions = [
  ['session_id', 'patient_id', 'session_date', 'kt_v', 'ufr_ml_kg_hr', 'vascular_access', 'complication'],
  ['S-1001', 'P-42', '2026-08-01', 1.42, 12.3, 'AVF', ''],
  ['S-1002', 'P-42', '2026-08-03', 1.38, 11.1, 'AVF', 'hypotension'],
  ['S-1003', 'P-77', '2026-08-04', 1.55, 9.8, 'CVC', ''],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sessions), 'DialysisSession');

// -------- Data sheet: Provider (reference/catalog) --------
const providers = [
  ['npi', 'name', 'specialty', 'facility_id', 'active'],
  ['1234567890', 'Ravi Menon MD', 'nephrology', 'F-001', true],
  ['1987654321', 'Aisha Khan MD', 'nephrology', 'F-001', true],
  ['1122334455', 'John Baker RN', 'nursing', 'F-002', true],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(providers), 'Provider');

// -------- Data sheet: MissedAppointment (pure numeric measurable) --------
const missed = [
  ['appointment_id', 'patient_id', 'scheduled_at', 'reason_code'],
  ['A-9001', 'P-42', '2026-07-30T10:00:00', 'transport'],
  ['A-9002', 'P-77', '2026-08-02T08:00:00', 'illness'],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(missed), 'MissedAppointment');

// -------- _dictionary (typed schema + PHI + FK) --------
const dict = [
  ['sheet', 'name', 'type', 'pk', 'phi', 'required', 'description', 'ref_sheet', 'ref_column'],
  ['DialysisSession', 'session_id', 'string', true, false, true, 'Primary key', '', ''],
  ['DialysisSession', 'patient_id', 'string', false, true, true, 'PHI \u2014 patient identifier', 'Patient', 'patient_id'],
  ['DialysisSession', 'session_date', 'date', false, false, true, '', '', ''],
  ['DialysisSession', 'kt_v', 'number', false, false, true, 'Dialysis adequacy', '', ''],
  ['DialysisSession', 'ufr_ml_kg_hr', 'number', false, false, true, 'Ultrafiltration rate', '', ''],
  ['DialysisSession', 'vascular_access', 'string', false, false, true, 'AVF|CVC|AVG', '', ''],
  ['Provider', 'npi', 'string', true, false, true, '', '', ''],
  ['Provider', 'facility_id', 'string', false, false, true, 'FK to facility', '', ''],
  ['MissedAppointment', 'appointment_id', 'string', true, false, true, '', '', ''],
  ['MissedAppointment', 'patient_id', 'string', false, true, true, '', '', ''],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dict), '_dictionary');

// -------- _entities (metadata per sheet) --------
const entities = [
  ['sheet', 'kind', 'description', 'phi', 'purpose_of_use', 'hitl', 'facility_kind'],
  ['DialysisSession', 'data', 'Per-visit dialysis session record', true, 'treatment', false, 'dialysis'],
  ['Provider', 'data', 'Provider directory (catalog)', false, 'operations', false, ''],
  ['MissedAppointment', 'data', 'Missed appointment log', true, 'operations,treatment', false, 'dialysis'],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(entities), '_entities');

// -------- _workflows (structured procedure) --------
const workflows = [
  ['workflow_id', 'workflow_name', 'step_id', 'step_name', 'role', 'requires_hitl', 'description'],
  ['wf-admit', 'ESRD Admit Workflow', 'step-1', 'Verify insurance', 'front-desk', false, 'Confirm Medicare Part B / Medicaid eligibility'],
  ['wf-admit', 'ESRD Admit Workflow', 'step-2', 'Weigh patient', 'nurse', false, 'Pre-treatment dry weight'],
  ['wf-admit', 'ESRD Admit Workflow', 'step-3', 'Assess access', 'nurse', false, 'AVF/CVC/AVG inspection'],
  ['wf-admit', 'ESRD Admit Workflow', 'step-4', 'Physician review', 'nephrologist', true, 'Sign off on treatment order'],
  ['wf-admit', 'ESRD Admit Workflow', 'step-5', 'Begin treatment', 'nurse', false, 'Cannulate + initiate'],
  ['wf-transfer', 'Facility Transfer', 'step-1', 'Notify receiving facility', 'admin', false, ''],
  ['wf-transfer', 'Facility Transfer', 'step-2', 'Send CCDA + last 3 sessions', 'admin', false, ''],
  ['wf-transfer', 'Facility Transfer', 'step-3', 'Confirm receipt', 'admin', true, 'HITL to confirm patient continuity'],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(workflows), '_workflows');

XLSX.writeFile(wb, OUT);
console.log(`Wrote ${OUT}: ${wb.SheetNames.length} sheets`);
