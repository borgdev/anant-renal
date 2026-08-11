# Contributing

## Local setup

```
npm install
npm run typecheck
npm test
```

The `ui/` directory has its own `package.json`; treat it as a separate workspace.

## Adding a pack

1. Create `packs/<pack-id>/manifest.yaml`.
2. Add `packs/<pack-id>/index.ts` exporting a `DomainPack` descriptor.
3. Add ontology + DQ rules + state machines + (optional) quality measures + (optional) replay reducer.
4. Register the pack in `packs/index.ts` and in `examples/dialysis-replay.ts` / `ui/lib/demo-data.ts` if it should appear in the demo.
5. Add a test file under `tests/` that exercises at least one workflow + one DQ rule + one measure.

## Style

- Prefer immutable structures; return frozen objects from state-machine helpers.
- Every access decision must be audited.
- Every DQ finding must carry `entityId` + `evidence`.
- Every measure must return `evidenceIds` covering everything counted.
- No `any`. No implicit returns. Turn on `noUncheckedIndexedAccess` in tsconfig.

## Test coverage bar

- Every state machine has legal + illegal transition tests.
- Every measure has at least one happy-path test with concrete numerator + denominator.
- Every adapter has a parse test + a mapping test.
