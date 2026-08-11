# Packs

Packs are the extension unit of the harness. Every pack:

- declares a `manifest.yaml` with id, version, `extends`, `applies_to`, `capabilities`, `cms_universe`, and `required_controls`
- exports an `index.ts` that registers ontology, DQ rules, workflows, quality measures, and (optionally) a replay reducer
- contributes zero surprises to the healthcare-core runtime — everything the core enforces is enforced identically for every pack

## Layout

```
packs/
  healthcare-core/           generic core pack (required by every specialty pack)
  dialysis-provider/         dialysis operator ontology + workflows
    missed-treatment/        sub-pack: missed-treatment recovery
    labs/                    sub-pack: lab review
    scheduling/              sub-pack: chair + shift scheduling
    hospitalization/         sub-pack: hospitalization transition
    vascular-access/         sub-pack: access surveillance
  ckd-navigation/            CKD -> ESRD navigation
  payer/                     payer prior-auth + utilization mgmt
  cms-universe/              executable metadata for CoC/QIP/PPS
```

Every pack registers its `DomainPack` descriptor with the `PackRegistry` at
boot. Sub-packs declare `extends: [{ id: dialysis-provider, versionRange: ^0.2.0 }]`
so removing a parent pack removes its children safely.
