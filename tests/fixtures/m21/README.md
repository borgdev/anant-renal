# M21 evaluator fixtures

Minimal but real ELM JSON library that exercises the full CQL evaluator pipeline:
- Named library `M21Basic` version `1.0.0`
- Retrieves FHIR `Patient`, `Condition`, `Observation`
- Populations:
  - Initial Population: exists([Patient])
  - Denominator: Initial Population and exists([Condition] where code in "Hypertension")
  - Denominator Exclusions: exists([Condition] where code in "Pregnancy")
  - Numerator: exists([Observation] where code in "Systolic BP" and value < 140)

The value sets are inline (source='inline-library') so the test needs no VSAC creds.
