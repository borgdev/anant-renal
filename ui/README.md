# Healthcare Harness UI

Next.js App Router UI for the harness. Ships with:

- Overview dashboard (replay snapshot, packs, measures)
- Missed-treatment case queue + lab review queue
- Replay viewer with per-measure numerator/denominator
- Audit ledger browser with content hashes
- QAPI Kanban board
- Pack registry
- Quality measure catalog

```
cd ui
npm install
npm run dev
```

The UI imports the harness core directly (`../src/**`) — no HTTP layer required
for the demo. Replace `lib/demo-data.ts` with API-backed loaders for prod
deployments.
