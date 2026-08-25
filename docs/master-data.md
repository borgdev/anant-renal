# Master-Data Analysis — Healthcare Harness

A classification of every entity the harness manages, split into **master data** (reference
records you create / maintain / re-use) vs **transactional / derived** (produced at runtime by
the sim). Master data is the "admin CRUD" surface. Storage is the swappable `SqlStore`/`SqlDb`
seam (SQLite default for zero-config dev; **Postgres `anant-health` on `localhost:5432`** via
`HH_STORAGE=postgres HH_DATABASE_URL=postgres://postgres:postgres@localhost:5432/anant-health`
— see `docs/spec-gap-fhir-analysis.md` §8 for the migration).

## Classification

### A. Core master data (Settings → CRUD) ✅ implemented
| Entity | Key fields | Source today | SQL table |
|---|---|---|---|
| **Realm** | id, mode, trajectoryEngine, createdAt | `RealmRegistry` + `realm_snapshots` | `realm_snapshots` |
| **Facility** | id, realmId, name, kind | `populateFacility` seed / graph | `facilities` |
| **Unit** | id, facilityId, realmId, code | seed / graph | `units` |
| **Patient** | id, facilityId, unitId, realmId, name, age, sex, trajectory, labs, vitals | seed / graph | `patients` |

Creating a realm with a seed auto-populates Facility → Units → Patients.

### B. Master data — existing catalogs (read-only views today; candidates for CRUD)
| Entity | Key fields | Source today | Notes / recommended admin |
|---|---|---|---|
| **Assessment** (screeners/scales) | id, title, loinc, domain, itemCount | `admin-ui/assessments.json` / `src/assessments` | ✅ Settings CRUD — `/admin/settings/assessments` |
| **Lifecycle stage** | id, order, label, kind | `admin-ui/lifecycle.json` | ✅ Settings CRUD — `/admin/settings/lifecycle` |
| **CMS Measure** (eCQM catalog) | id, programId, name, description | `admin-ui/measures.json` + synced `loadFromDisk` | read-only catalog (from source registry); CRUD optional |
| **Knowledge source** | id, name, category, tier, cadence, credentials | `src/knowledge` registry + `research.json` | management exists (sync/credentials); full CRUD optional |
| **Agent spec** (published agents) | id, packId, displayName, trigger, plan, governance, billing | YAML packs → `AgentAuthoringService` | authoring workflow exists (drafts→publish) — not "master CRUD" |
| **Nudge template** | nudgeKind, channel, description, expectedEffect | M25 (delivered ad-hoc) | ✅ Settings CRUD — `/admin/settings/nudges` |
| **Billing plan / tier** | planId, displayName, tiers, rates | `DEFAULT_BILLING_PLAN` constant | config — promote to editable master (future) |
| **Org structure** | OrgPack: departments/teams/roles, edges | `src/realm/org-graph.ts` OrgPack | config — promote to editable master (future) |
| **Rule** (YAML policy rules) | id, on, when, then | realm rules engine | per-realm rules; a shared catalog is future work |

### C. Transactional / derived (NOT master data — no CRUD)
| Entity | Kind | Storage |
|---|---|---|
| Nudge delivery | transactional (per patient) | `nudge_ledger` |
| Counterfactual run | transactional | `counterfactual_runs` |
| Billing usage / invoice | transactional | `billing_usage` |
| Realm snapshot | derived checkpoint | `realm_snapshots` (snapshot_json) |
| Episodes, self-models, attributions | derived (runtime) | in-memory realm |
| Presences, effects, perceptions, experiences, plans, intents | runtime | in-memory realm |
| Liquid model artifacts (CfC/LTC weights) | derived / file | `.harness/liquid/` |

## CRUD surface (Settings admin)

| Tab | CRUD | Backed by |
|---|---|---|
| Facilities | ✅ | `/admin/settings/facilities` |
| Units | ✅ | `/admin/settings/units` |
| Patients | ✅ | `/admin/settings/patients` |
| Realms | list + delete snapshot | `/admin/settings/realms` |
| Assessments | ✅ | `/admin/settings/assessments` |
| Lifecycle | ✅ | `/admin/settings/lifecycle` |
| Nudges | ✅ (templates) | `/admin/settings/nudges` |

## Reusable data grid (`dataGrid()`)

Every data grid in the admin console renders through the single reusable component
`dataGrid(opts)` in `admin-ui/index.html`. It uses **TanStack Table core** (`@tanstack/table-core@8.21.3`
from esm.sh, headless) with a plain-table fallback when the CDN is unreachable.

```js
dataGrid({
  el: 'some-grid',        // container element id (mounted by the component)
  filename: 'export-name', // base name for CSV/JSON export
  columns: [{
    key: 'id', label: 'ID',
    sortable: true,         // default true
    filter: true,           // default true (per-column filter row)
    align: 'left',          // or 'right'
    hide: false,            // hide from header/body but keep in Columns menu
    render: (value, row) => `<code>${esc(value)}</code>`,  // custom cell renderer
  }],
  data: rows,
  pageSize: 10, search: true, columnFilters: true, export: true, columnsToggle: true,
  empty: 'No records.',
})
```

Features: sticky-header sorting, per-column filters + global search, pagination + page-size,
column visibility toggle, CSV/JSON export, and custom cell renderers (pills, badges, code,
action buttons). `render()` returns `{ refresh(data) }` to swap data in place (used by the
Agents pack filter and Nudge ledger).

Row actions survive re-renders two ways: **event delegation** on the container for
`[data-edit]` / `[data-del]` (Settings CRUD tabs, via `bindCrudActions`), and inline `onclick`
for stateless actions (Clone, Observe).

## Design rule
Master-data CRUD is the **only** write surface for reference records. Transactional writes
(nudges, counterfactuals, billing) happen through their dedicated flows and are never edited
via master-data CRUD.
