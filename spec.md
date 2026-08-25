# Anant Healthcare App — Full Entity Hypergraph, FHIR-Native, Realm-First Admin Journey

**Status**: reference doc for `hh-admin-ui` and `packs/healthcare-core`.
**Grounded in**:
- Repo types: `src/twin/types.ts`, `src/realm/types.ts`, `src/behaviors/types.ts`, `src/hypergraph/types.ts`, `src/knowledge/types.ts`, `src/identity/types.ts`, `src/measures/types.ts`, `packs/healthcare-core/index.ts` (25 packs total under `packs/`).
- External standards: [FHIR R4 (~145 resources)](https://hl7.org/fhir/R4/resourcelist.html), [US Core STU7 (~26 profiles)](https://www.hl7.org/fhir/us/core/profiles-and-extensions.html), [QICore STU6 (~30 profiles)](https://build.fhir.org/ig/HL7/fhir-qi-core/profiles.html), [USCDI v5 (22 data classes)](https://isp.healthit.gov/sites/default/files/2024-07/USCDI-Version-5-July-2024-Final.pdf), [CMS Blue Button 2.0](https://bluebutton.cms.gov/), [HL7 THO external code systems](https://terminology.hl7.org/external_terminologies.html).
- Legacy + live-observability standards (all normalize to FHIR internally): [HL7 v2.x messaging](https://www.hl7.org/implement/standards/product_section.cfm?section=13), [HL7 v2-to-FHIR IG](https://build.fhir.org/ig/HL7/v2-to-fhir/), [C-CDA R2.1](https://www.hl7.org/implement/standards/product_brief.cfm?product_id=492), [C-CDA on FHIR](https://hl7.org/fhir/us/ccda/), [FHIR Subscription topic-based (R5 backport)](https://build.fhir.org/ig/HL7/fhir-subscription-backport-ig/), [FHIRcast](https://fhircast.org/), [IHE ITI profiles (XDS/XCA/XCPD/PDQ/PIX)](https://profiles.ihe.net/ITI/), [TEFCA / QHIN](https://rce.sequoiaproject.org/), [Carequality](https://carequality.org/), [CommonWell](https://www.commonwellalliance.org/), [Direct Project](https://directproject.org/), [X12 5010 (270/271/276/277/278/834/835/837)](https://x12.org/), [NCPDP SCRIPT](https://www.ncpdp.org/), [NEMSIS 3.5](https://nemsis.org/).

**Purpose**: (1) treat the healthcare app as a first-class hypergraph, not a bag of loose types; (2) every clinical/administrative/financial entity is FHIR-native — carries its FHIR resource type, US Core + QICore profile lineage, and canonical code systems; (3) the full universe of US healthcare is covered — 40+ practice domains across 25 packs; (4) admin journey is **realm first**, everything else flows from the realm.

The core gap this doc closes: the substrate has a typed hypergraph engine (`src/hypergraph/`) but **no pack currently registers nodes or edges into it**. The healthcare domain lives as loose `EntityKind` strings on `EntityRecord` and union arms on `WorldEffect`. This doc is the population plan — every node has a FHIR resource, every hyperedge is a FHIR `Reference()` chain typed at schema level.

---

## Table of contents

1. Corrected admin user journey (realm-first, FHIR-aware, interop-bridged)
2. Node types — the atoms
   - 2.1 Substrate primitives (domain-independent)
   - 2.2 Healthcare-domain nodes, FHIR-shaped
   - 2.3 Terminology & value-set nodes
   - 2.4 Payer / financial-graph nodes
   - 2.5 Quality-measure nodes (FHIR Clinical Reasoning)
   - 2.6 Population / SDOH / public-health nodes
   - 2.7 Research / trial / evidence nodes
   - 2.8 Interoperability ingest primitives (HL7 v2, C-CDA, X12, NCPDP, NEMSIS, Direct, IHE, HIE networks)
   - 2.9 Live-observability primitives (FHIR Subscription topic-based, FHIRcast, MLLP, event stream)
3. Hyperedge types — the many-to-many relationships (all typed after FHIR `Reference()`)
4. The full healthcare universe — 40+ domains × 25 packs
5. Knowledge sources — every authoritative source, tier, cadence, license
6. Admin UI screens — one per node/edge cluster, no duplicates
7. What's missing from the repo (the honest gap list)
8. Invariants
9. Coverage check

---

## 1. Corrected admin user journey (realm-first, FHIR-aware)

Previous journey drift: admin landed on a pack page, picked features, then hunted for where twins live. Wrong order. A realm is the substrate's world — every entity is meaningless outside a realm.

```
   1. Sign in                        (IdentityPrincipal)
        └─► scoped to orgId + facilityIds

   2. Choose or create a REALM       (RealmId, RealmMode)
        └─► mode: sim | twin
        └─► clock: wall | accelerated
        └─► FHIR base URL (twin mode only): SMART on FHIR endpoint or bulk-export endpoint

   3. Install PACKS into the realm   (DomainPack)
        └─► healthcare-core mandatory
        └─► domain packs optional (see §4 for the full universe)

   4. Terminology bootstrap          (§2.3)
        └─► RxNorm, LOINC, SNOMED CT (via UMLS), ICD-10-CM, ICD-10-PCS,
            CPT/HCPCS, NDC, CVX, UCUM — one-time credential wizard
        └─► USCDI v5 must-support value sets pinned

   5. Wire KNOWLEDGE SOURCES         (KnowledgeSource + PackSourceSubscription)
        └─► admin sees exactly which sources each installed pack requires
        └─► credentials wizard on any source with tier != 'public'
        └─► freshness contract auto-derived from strictest pack requirement

   5b. Wire INTEROP BRIDGE           (§2.8 + §2.9 — the live-observability spine)
        └─► MLLP endpoints for HL7 v2 (ADT/ORM/ORU/SIU/MDM/DFT/BAR/VXU/RAS/RGV/PPR)
        └─► C-CDA inbound (XDS.b, XDR, XDM, DocumentReference upload)
        └─► X12 5010 partners (270/271/276/277/278/834/835/837 P/I/D)
        └─► NCPDP SCRIPT (e-prescribing) + NCPDP D.0 (retail claims)
        └─► NEMSIS 3.5 for EMS (crosswalked to FHIR)
        └─► Direct Project (S/MIME messaging) address per realm
        └─► HIE / network registration: TEFCA QHIN, Carequality, CommonWell, eHealth Exchange
        └─► IHE actor bindings: XDS.b Repository/Registry, XCA Gateway, XCPD, PDQ, PIX
        └─► FHIR Subscription topic-based endpoints (R5 backport on R4B)
        └─► FHIRcast hubs for clinical context sync (Patient-open, ImagingStudy-open)
        └─► Every inbound legacy artifact is parsed → mapped → emitted as FHIR resources +
            typed HyperNodes; the raw artifact is retained by DocumentReference + Provenance
            for round-trip and audit

   6. Populate the REALM             (§2.2)
        └─► sim: seed generators produce US Core-conformant Bundle
        └─► twin: connect EHR via FHIR — Bulk Data $export or Subscription
        └─► twin: OR ingest via §2.8 legacy channels — everything becomes FHIR internally
        └─► every ingested resource lands as both an EntityRecord AND a HyperNode

   7. Mint TWINS                     (Twin — persona | device)
        └─► every Patient resource → twin.persona
        └─► every Practitioner → twin.persona
        └─► every Device (with UDI) → twin.device
        └─► every physical Location resource that acts (chair, pump) → twin.device
        └─► voice channels + skills + policy predicates attached per pack

   8. Bind BEHAVIORS to twin cohorts (Behavior from installed packs)
        └─► which behaviors run for which twin cohort

   9. Compose EXPERIENCES            (Experience — auto at tick time)
        └─► substrate ticks each twin; behaviors observe; candidates ranked

  10. Observe RUNTIME                (SessionEvent stream + provenance + live subs)
        └─► every effect, nudge, memory entry, FHIR resource change visible
        └─► every inbound v2 / CDA / X12 / NCPDP / NEMSIS artifact visible as
            interop-ingest edge + resulting FHIR resource + provenance chain
        └─► FHIR Subscription topics + FHIRcast events wired into the same
            SessionEvent stream — one ledger for legacy + modern channels
```

The admin UI **must enforce this order**. Step 6 (populate) cannot be reached before step 2 (choose realm). Step 7 (mint twin) requires a realm to bind to and terminology loaded to interpret the resource's coded fields. Step 5b (interop bridge) unlocks *live* twin mode — a realm with no bridge can still run in sim mode or in twin-via-Bulk-Data mode, but is not a live-observable system until at least one channel in §2.8/§2.9 is bound to it.

---

## 2. Node types (the atoms of the healthcare hypergraph)

Every node type below is registered against `HypergraphSchema`. Attributes listed are the exact required set. **FHIR resource** column names the R4 resource; **US Core / QICore** column names the applicable profile (— when none exists).

### 2.1 Substrate primitives (domain-independent)

| Node type | Required attributes | FHIR resource | Source |
|---|---|---|---|
| `twin.persona` | `id`, `owner`, `attestation`, `createdAt`, `walletBalanceUsd`, `fhirRef` (Patient or Practitioner) | Patient / Practitioner / RelatedPerson | `src/twin/types.ts` |
| `twin.device` | `id`, `owner`, `attestation`, `createdAt`, `walletBalanceUsd`, `fhirRef` (Device) | Device / Location (bed / chair) | `src/twin/types.ts` |
| `voice-channel` | `channel`, `available`, `schemaRef` | Communication / CommunicationRequest | `src/twin/types.ts` |
| `skill` | `name`, `pack`, `inputSchemaRef`, `outputSchemaRef`, `metered` | — (skill is not a FHIR resource) | `src/twin/types.ts` |
| `policy-predicate` | `action`, `realm`, `effect`, `reason` | Consent / Contract (when policy is patient-facing) | `src/twin/types.ts` |
| `memory-entry` | `id`, `at`, `kind`, `payloadHash`, `sourceUri`, `contentHash` | Provenance (always paired) | `src/twin/types.ts` |
| `wallet` / `wallet-ledger-entry` | `publicKey`, `balanceUsd`, `id`, `at`, `amountUsd`, `reason`, `effectId` | Account / ChargeItem | `src/twin/types.ts` |
| `realm` | `realmId`, `mode`, `clockKind`, `orgId`, `fhirBaseUrl?`, `bulkExportGroup?` | — (realm is a substrate concept) | `src/realm/types.ts` |
| `agent-presence` | `presenceId`, `agentSpecId`, `runId`, `role`, `clearance`, `attention`, `spawnedAt` | Provenance.agent | `src/realm/types.ts` |
| `world-effect` | `effectId`, `presenceId`, `agentSpecId`, `emittedAt`, `realmAt`, `effectKind`, `status` | — (effect is intent; realized effect becomes a FHIR resource change) | `src/realm/types.ts` |
| `perceived-event` | `eventId`, `presenceId`, `at`, `realmAt`, `kind` | Subscription / SubscriptionStatus | `src/realm/types.ts` |
| `behavior` | `id`, `pack`, `name`, `rationale` | PlanDefinition | `src/behaviors/types.ts` |
| `experience` | `id`, `twinId`, `realm`, `at`, `firedBehaviorsCount`, `candidatesCount` | GuidanceResponse | `src/behaviors/types.ts` |
| `candidate-action.system-episode` | `id`, `behaviorId`, `pack`, `subjectTwinId`, `realm`, `at`, `priority`, `rationale`, `capability`, `argsHash` | Task | `src/behaviors/types.ts` |
| `candidate-action.human-nudge` | `id`, `behaviorId`, `pack`, `subjectTwinId`, `realm`, `at`, `priority`, `rationale`, `channel`, `payloadHash`, `register`, `expiresAt`, `ackRequired` | CommunicationRequest | `src/behaviors/types.ts` |
| `pack` | `id`, `version`, `appliesToOrgKinds`, `capabilitiesJson`, `requiredControlsJson` | ImplementationGuide | `packs/*/index.ts` |
| `knowledge-source` | `id`, `name`, `publisher`, `category`, `tier`, `format`, `cadence`, `homepage`, `license`, `description` | — | `src/knowledge/types.ts` |
| `knowledge-artifact` | `id`, `sourceId`, `category`, `title`, `contentHash`, `sourceVersion`, `canonicalUrl`, `fetchedAt`, `extractorId`, `extractorVersion` | Library / Bundle / Composition (as applicable) | `src/knowledge/types.ts` |
| `pack-source-subscription` | `packId`, `sourceId`, `freshnessRequirement`, `criticality`, `createdAt`, `updatedAt` | — (edge) | `src/knowledge/types.ts` |
| `sync-outcome` | `sourceId`, `startedAt`, `finishedAt`, `status`, `fetched`, `extracted`, `bytesIn`, `changesCount` | — | `src/knowledge/types.ts` |
| `identity-principal` | `subjectId`, `email`, `role`, `clearance`, `orgId`, `source` | Person / PractitionerRole | `src/identity/types.ts` |
| `session-event` | `seq`, `at`, `realmId`, `kind`, `causeEventId?`, `payloadHash`, `merkleRoot` | AuditEvent | `src/hypergraph/ledger.ts` |

### 2.2 Healthcare-domain nodes, FHIR-shaped

Every node below carries a `fhirRef` attribute (`ResourceType/id`) so it round-trips to the source EHR. `Ref → node type` in the last column shows which other nodes it edges to.

#### Administrative / Base

| Node type | Attributes (required + must-support) | FHIR resource | US Core STU7 profile | QICore STU6 profile | Refs |
|---|---|---|---|---|---|
| `patient` | `patientId`, `fhirRef`, `mrn`, `nameHash`, `birthDate`, `gender`, `phiClearanceLevel`, `raceCode?`, `ethnicityCode?`, `sexParameterForClinicalUse?`, `pronouns?`, `interpreterNeeded?` | Patient | US Core Patient | QICore Patient | organization, generalPractitioner |
| `practitioner` | `practitionerId`, `fhirRef`, `nameHash`, `npi`, `licenseNumber?`, `licenseState?`, `active` | Practitioner | US Core Practitioner | QICore Practitioner | qualification-issuer(Organization) |
| `practitioner-role` | `practitionerRoleId`, `fhirRef`, `practitionerId`, `organizationId`, `code`, `active`, `period?` | PractitionerRole | US Core PractitionerRole | — | practitioner, organization, location |
| `related-person` | `relatedPersonId`, `fhirRef`, `patientId`, `relationship`, `nameHash`, `active` | RelatedPerson | US Core RelatedPerson | — | patient |
| `organization` | `organizationId`, `fhirRef`, `orgKind` (payer / provider / lab / pharmacy / gov), `name`, `active`, `identifier` | Organization | US Core Organization | QICore Organization | parent-organization |
| `location` | `locationId`, `fhirRef`, `name`, `physicalType`, `status`, `orgId`, `facilityId?` | Location | US Core Location | QICore Location | organization, part-of(location) |
| `healthcare-service` | `serviceId`, `fhirRef`, `orgId`, `locationId?`, `category`, `type`, `active` | HealthcareService | — | — | organization, location |
| `endpoint` | `endpointId`, `fhirRef`, `connectionType`, `payloadType`, `address`, `status` | Endpoint | US Core Endpoint | — | organization |
| `facility` | `facilityId`, `orgId`, `facilityKind` (hospital / clinic / dialysis-center / SNF / home-health-agency / behavioral / pharmacy / dental / vision / imaging / DME / hospice / urgent-care / FQHC / RHC / IHS / VA / tribal), `licenses[]`, `accreditations[]`, `beds`, `chairs`, `ccn?` (CMS Certification Number) | Location + Organization composite | US Core Location | — | organization, location |
| `unit` | `unitId`, `facilityId`, `unitKind` (ICU / med-surg / ED / dialysis-floor / procedure-suite / OR / L&D / NICU / PICU / behavioral / imaging / lab / pharmacy), `bedCount`, `chairCount`, `staffingModel` | Location (subtype) | US Core Location | — | facility, part-of |
| `equipment` | `equipmentId`, `fhirRef`, `equipmentKind` (dialysis-chair / vent / monitor / infusion-pump / IoT-gateway / imaging-modality / bed / wheelchair / ambulance / defibrillator), `state`, `serialNumber?`, `udi?`, `manufacturer?`, `model?`, `twinId?` | Device (+ US Core Implantable Device for implants) | US Core Implantable Device | QICore Device | patient, location |

#### Encounter / workflow

| Node type | Attributes | FHIR resource | US Core | QICore | Refs |
|---|---|---|---|---|---|
| `encounter` | `encounterId`, `fhirRef`, `patientId`, `class`, `type[]`, `serviceType?`, `priority?`, `startAt`, `endAt?`, `dispositionKind?`, `locationId?` | Encounter | US Core Encounter | QICore Encounter | patient, practitioner, location, diagnosis |
| `appointment` | `appointmentId`, `fhirRef`, `patientId`, `status`, `startAt`, `endAt`, `type`, `slot[]?` | Appointment | — | — | patient, practitioner, location |
| `episode-of-care` | `episodeId`, `fhirRef`, `patientId`, `orgId`, `status`, `startAt`, `endAt?`, `type[]?`, `diagnosis[]?` | EpisodeOfCare | — | — | patient, managing-organization |
| `flag` | `flagId`, `fhirRef`, `patientId`, `code`, `status`, `period?` | Flag | — | QICore Flag | patient |

#### Clinical

| Node type | Attributes | FHIR resource | US Core | QICore | Refs |
|---|---|---|---|---|---|
| `condition-encounter-diagnosis` | `conditionId`, `fhirRef`, `patientId`, `encounterId`, `code` (ICD-10-CM / SNOMED), `clinicalStatus`, `verificationStatus`, `onsetDateTime?`, `abatementDateTime?` | Condition | US Core Condition Encounter Diagnosis | QICore Condition Encounter Diagnosis | patient, encounter |
| `condition-problem-health-concern` | `conditionId`, `fhirRef`, `patientId`, `code`, `category` (problem-list-item / health-concern), `clinicalStatus`, `recordedDate` | Condition | US Core Condition Problems and Health Concerns | QICore Condition Problems Health Concerns | patient |
| `allergy-intolerance` | `allergyId`, `fhirRef`, `patientId`, `code` (RxNorm / SNOMED), `category` (medication / food / environment / biologic), `criticality`, `clinicalStatus`, `verificationStatus`, `reaction[]?` | AllergyIntolerance | US Core AllergyIntolerance | QICore AllergyIntolerance | patient |
| `procedure` | `procedureId`, `fhirRef`, `patientId`, `encounterId?`, `code` (CPT / HCPCS / SNOMED / ICD-10-PCS), `status`, `performedDateTime?`, `bodySite?` | Procedure | US Core Procedure | QICore Procedure | patient, encounter, performer |
| `observation.vital` | `observationId`, `fhirRef`, `patientId`, `code` (LOINC), `effectiveDateTime`, `valueQuantity`, `unit` (UCUM), `interpretation?` | Observation | US Core Vital Signs (subset) | — | patient, encounter |
| `observation.lab` | `observationId`, `fhirRef`, `patientId`, `code` (LOINC), `effectiveDateTime`, `valueQuantity?` or `valueCodeableConcept?`, `unit?` (UCUM), `referenceRange?`, `interpretation?` (H/L/HH/LL/A), `specimenId?` | Observation | US Core Laboratory Result Observation | — | patient, specimen, diagnostic-report |
| `observation.smoking-status` | `observationId`, `fhirRef`, `patientId`, `valueCodeableConcept` | Observation | US Core Smoking Status | — | patient |
| `observation.sdoh` | `observationId`, `fhirRef`, `patientId`, `code`, `category` (SDOH), `valueCodeableConcept?` | Observation | US Core SDOH Assessment | — | patient |
| `observation.pregnancy-status` | `observationId`, `fhirRef`, `patientId`, `code` (LOINC 82810-3), `valueCodeableConcept` | Observation | US Core Pregnancy Status | — | patient |
| `observation.sex-parameter-for-clinical-use` | `observationId`, `fhirRef`, `patientId`, `valueCodeableConcept` | Observation | US Core SPCU (USCDI v5) | — | patient |
| `observation.pediatric` | `observationId`, `fhirRef`, `patientId`, `code`, `valueQuantity`, `unit` | Observation | US Core Pediatric BMI-for-Age / Weight-for-Height / Head Occipital-frontal Circumference | — | patient |
| `observation.advance-directive` | `observationId`, `fhirRef`, `patientId`, `code`, `valueCodeableConcept` | Observation | US Core Advance Directive Observation (USCDI v5) | — | patient |
| `family-member-history` | `historyId`, `fhirRef`, `patientId`, `relationship`, `condition[]?` | FamilyMemberHistory | — | QICore FamilyMemberHistory | patient |
| `body-structure` | `structureId`, `fhirRef`, `patientId`, `location`, `morphology?` | BodyStructure | — | QICore BodyStructure | patient |
| `clinical-impression` | `impressionId`, `fhirRef`, `patientId`, `status`, `effectiveDateTime`, `assessor` | ClinicalImpression | — | — | patient, practitioner, encounter |
| `adverse-event` | `adverseEventId`, `fhirRef`, `patientId`, `event`, `seriousness`, `severity`, `date`, `outcome?` | AdverseEvent | — | QICore AdverseEvent | patient |

#### Diagnostic

| Node type | Attributes | FHIR resource | US Core | QICore | Refs |
|---|---|---|---|---|---|
| `diagnostic-report.lab` | `reportId`, `fhirRef`, `patientId`, `code`, `status`, `effectiveDateTime`, `issued`, `result[]` | DiagnosticReport | US Core DiagnosticReport Profile for Laboratory Results Reporting | QICore DiagnosticReport (Lab) | patient, encounter, observation |
| `diagnostic-report.note` | `reportId`, `fhirRef`, `patientId`, `code`, `status`, `effectiveDateTime`, `issued`, `conclusion?` | DiagnosticReport | US Core DiagnosticReport Profile for Report and Note Exchange | QICore DiagnosticReport (Report/Note) | patient, encounter |
| `specimen` | `specimenId`, `fhirRef`, `patientId`, `type`, `collectionDateTime?`, `bodySite?` | Specimen | US Core Specimen | — | patient |
| `imaging-study` | `imagingStudyId`, `fhirRef`, `patientId`, `status`, `modality[]`, `started`, `series[]` | ImagingStudy | — | QICore ImagingStudy | patient, encounter |
| `imaging-manifest` | `manifestId`, `fhirRef`, `patientId`, `sourceEndpoint`, `study[]` (DICOM UIDs) | ImagingManifest (deprecated → DocumentManifest) | — | — | patient |
| `document-reference` | `documentReferenceId`, `fhirRef`, `patientId`, `type`, `category`, `date`, `status`, `contentAttachment` | DocumentReference | US Core DocumentReference | — | patient, encounter, author |
| `composition` | `compositionId`, `fhirRef`, `patientId`, `type`, `date`, `status`, `title`, `section[]` | Composition | — | — | patient, author, encounter |

#### Medication

| Node type | Attributes | FHIR resource | US Core | QICore | Refs |
|---|---|---|---|---|---|
| `medication` | `medicationId`, `fhirRef`, `code` (RxNorm / NDC), `form?`, `ingredient[]?` | Medication | US Core Medication | — | manufacturer(Organization) |
| `medication-request` | `medRequestId`, `fhirRef`, `patientId`, `status`, `intent`, `code` (RxNorm), `dose`, `route`, `frequency`, `authoredOn`, `requesterId` | MedicationRequest | US Core MedicationRequest | QICore MedicationRequest / QICore MedicationNotRequested | patient, requester, medication |
| `medication-dispense` | `dispenseId`, `fhirRef`, `patientId`, `medRequestId?`, `status`, `code`, `quantity`, `daysSupply?`, `whenHandedOver` | MedicationDispense | US Core MedicationDispense | QICore MedicationDispense | patient, medication-request, performer(Pharmacy) |
| `medication-administration` | `administrationId`, `fhirRef`, `patientId`, `status`, `effectiveDateTime`, `code`, `dose`, `route`, `performer[]` | MedicationAdministration | US Core MedicationAdministration | QICore MedicationAdministration / MedicationNotAdministered | patient, encounter, medication-request, performer |
| `medication-statement` | `statementId`, `fhirRef`, `patientId`, `status`, `code`, `effectivePeriod?`, `dateAsserted` | MedicationStatement | US Core MedicationStatement | QICore MedicationStatement | patient |
| `immunization` | `immunizationId`, `fhirRef`, `patientId`, `status`, `vaccineCode` (CVX), `occurrenceDateTime`, `lotNumber` (USCDI v5), `primarySource`, `site?`, `route?` | Immunization | US Core Immunization | QICore Immunization | patient, encounter, performer |
| `immunization-recommendation` | `recId`, `fhirRef`, `patientId`, `date`, `recommendation[]` | ImmunizationRecommendation | — | — | patient |
| `vision-prescription` | `visionRxId`, `fhirRef`, `patientId`, `status`, `dateWritten`, `lensSpecification[]` | VisionPrescription | — | — | patient, prescriber |

#### Care coordination

| Node type | Attributes | FHIR resource | US Core | QICore | Refs |
|---|---|---|---|---|---|
| `care-plan` | `carePlanId`, `fhirRef`, `patientId`, `status`, `intent`, `category`, `period?`, `activity[]?` | CarePlan | US Core CarePlan | QICore CarePlan | patient, careTeam, author |
| `care-team` | `careTeamId`, `fhirRef`, `patientId`, `status`, `period?`, `participant[]` | CareTeam | US Core CareTeam | QICore CareTeam | patient, participant(Practitioner / RelatedPerson) |
| `goal` | `goalId`, `fhirRef`, `patientId`, `lifecycleStatus`, `achievementStatus?`, `category?`, `description`, `target[]?` | Goal | US Core Goal | QICore Goal | patient, expressedBy |
| `service-request` | `serviceRequestId`, `fhirRef`, `patientId`, `status`, `intent`, `category?`, `code`, `authoredOn`, `requesterId`, `occurrence?` | ServiceRequest | US Core ServiceRequest | QICore ServiceRequest | patient, requester, performer |
| `nutrition-order` | `nutritionOrderId`, `fhirRef`, `patientId`, `status`, `intent`, `dateTime`, `oralDiet?`, `supplement[]?`, `enteralFormula?` | NutritionOrder | — | QICore NutritionOrder | patient, encounter, requester |
| `communication` | `communicationId`, `fhirRef`, `patientId?`, `status`, `sent`, `received?`, `recipient[]`, `sender?`, `payload[]` | Communication | — | QICore Communication (+ Done / Not Done) | patient, sender, recipient |
| `communication-request` | `communicationRequestId`, `fhirRef`, `patientId?`, `status`, `authoredOn`, `recipient[]`, `payload[]`, `priority?` | CommunicationRequest | — | QICore CommunicationRequest | patient, requester, recipient |
| `questionnaire` | `questionnaireId`, `fhirRef`, `url`, `title`, `status`, `item[]` | Questionnaire | US Core Questionnaire | QICore Questionnaire | — |
| `questionnaire-response` | `qrId`, `fhirRef`, `patientId`, `questionnaire`, `status`, `authored`, `item[]` | QuestionnaireResponse | US Core QuestionnaireResponse | QICore QuestionnaireResponse | patient, questionnaire, author |
| `consent` | `consentId`, `fhirRef`, `patientId`, `status`, `scope`, `category`, `dateTime`, `policyRule?`, `provision?` | Consent | — | — | patient, organization |
| `task` | `taskId`, `fhirRef`, `status`, `intent`, `priority?`, `code?`, `focus?`, `for?`, `authoredOn`, `owner?` | Task | — | QICore Task (+ Done / Rejected) | for(Patient), owner(Practitioner), requester |
| `provenance` | `provenanceId`, `fhirRef`, `target[]`, `occurredDateTime`, `recorded`, `agent[]`, `entity[]?` | Provenance | US Core Provenance | — | target, agent |

#### Financial (revenue cycle + payer)

| Node type | Attributes | FHIR resource | US Core | QICore | Refs |
|---|---|---|---|---|---|
| `coverage` | `coverageId`, `fhirRef`, `patientId`, `status`, `payorId`, `subscriberId`, `beneficiary`, `relationship?`, `period?`, `class[]?` (group / plan / subgroup) | Coverage | US Core Coverage | QICore Coverage | patient, payor(Organization) |
| `coverage-eligibility-request` | `eligibilityId`, `fhirRef`, `patientId`, `status`, `purpose[]`, `created`, `insurer`, `item[]?` | CoverageEligibilityRequest | — | — | patient, insurer |
| `coverage-eligibility-response` | `eligibilityResponseId`, `fhirRef`, `patientId`, `status`, `purpose[]`, `outcome`, `insurance[]` | CoverageEligibilityResponse | — | — | patient, insurer, request |
| `claim` | `claimId`, `fhirRef`, `patientId`, `status`, `type`, `use`, `created`, `insurer`, `provider`, `total?` | Claim | — | QICore Claim | patient, insurer, provider |
| `claim-response` | `claimResponseId`, `fhirRef`, `claimId`, `status`, `outcome`, `disposition?`, `payment?`, `total[]?` | ClaimResponse | — | QICore ClaimResponse | claim, insurer |
| `explanation-of-benefit` | `eobId`, `fhirRef`, `patientId`, `status`, `type`, `use`, `insurer`, `provider`, `outcome`, `item[]?`, `total[]?` | ExplanationOfBenefit | — (CARIN Blue Button) | — | patient, insurer, provider, claim |
| `account` | `accountId`, `fhirRef`, `patientId?`, `status`, `type?`, `balance?`, `coverage[]?` | Account | — | — | patient, coverage |
| `charge-item` | `chargeItemId`, `fhirRef`, `patientId`, `status`, `code`, `occurrenceDateTime`, `quantity?`, `priceOverride?` | ChargeItem | — | — | patient, encounter, performer |
| `charge-item-definition` | `cidId`, `fhirRef`, `url`, `status`, `code`, `propertyGroup[]?` | ChargeItemDefinition | — | — | — |
| `invoice` | `invoiceId`, `fhirRef`, `patientId?`, `status`, `date`, `type?`, `totalNet?`, `totalGross?`, `lineItem[]?` | Invoice | — | — | patient, account |
| `payment-notice` | `paymentNoticeId`, `fhirRef`, `status`, `recipient`, `amount`, `paymentStatus?` | PaymentNotice | — | — | recipient(Organization) |
| `payment-reconciliation` | `reconciliationId`, `fhirRef`, `status`, `period?`, `paymentIssuer?`, `outcome?`, `detail[]?` | PaymentReconciliation | — | — | paymentIssuer |
| `enrollment-request` / `enrollment-response` | ids, `fhirRef`, `status`, `insurer`, `candidate`, `outcome?` | EnrollmentRequest / EnrollmentResponse | — | — | insurer, candidate(Patient) |
| `contract` | `contractId`, `fhirRef`, `status`, `subject[]?`, `authority?`, `type?`, `term[]?` | Contract | — | — | subject, authority |
| `prior-auth` | `priorAuthId`, `patientId`, `payerId`, `serviceCode`, `requestedAt`, `status`, `decidedAt?`, `decision?`, `expiresAt?` | Task on Claim (use=preauth) OR CoverageEligibilityRequest | — | — | patient, payer, related-order |

### 2.3 Terminology & value-set nodes

Every code system the healthcare app must recognize is a first-class node. Canonical FHIR URIs listed match [HL7 THO external code systems](https://terminology.hl7.org/external_terminologies.html).

| Node type | Attributes | Canonical URI | Maintainer | License | Cadence |
|---|---|---|---|---|---|
| `code-system.rxnorm` | `version`, `contentHash`, `conceptsCount` | `http://www.nlm.nih.gov/research/umls/rxnorm` | NLM | Free | Weekly |
| `code-system.loinc` | `version`, `contentHash`, `conceptsCount` | `http://loinc.org` | Regenstrief | Free | Biannual |
| `code-system.snomed-ct` | `version`, `contentHash`, `edition`, `conceptsCount` | `http://snomed.info/sct` | SNOMED International | UMLS License (Free US) | Biannual |
| `code-system.icd-10-cm` | `version`, `contentHash` (annual) | `http://hl7.org/fhir/sid/icd-10-cm` | CDC/NCHS | Free (US) | Annual (Oct 1) |
| `code-system.icd-10-pcs` | `version`, `contentHash` | `http://www.cms.gov/Medicare/Coding/ICD10` | CMS | Free (US) | Annual (Oct 1) |
| `code-system.cpt` | `version`, `contentHash` | `http://www.ama-assn.org/go/cpt` | AMA | Licensed | Annual |
| `code-system.hcpcs` | `version`, `contentHash` | `https://www.cms.gov/Medicare/Coding/MedHCPCSGenInfo` | CMS | Free | Quarterly |
| `code-system.ndc` | `version`, `contentHash` | `http://hl7.org/fhir/sid/ndc` | FDA | Free | Continuous |
| `code-system.cvx` | `version`, `contentHash` | `http://hl7.org/fhir/sid/cvx` | CDC | Free | As needed |
| `code-system.ucum` | `version`, `contentHash` | `http://unitsofmeasure.org` | Regenstrief | Free | As needed |
| `code-system.hcp-taxonomy` | `version`, `contentHash` | `http://nucc.org/provider-taxonomy` | NUCC | Free | Semiannual |
| `code-system.race-ombcategory` | `version` | `urn:oid:2.16.840.1.113883.6.238` | CDC | Free | Stable |
| `code-system.ethnicity-ombcategory` | `version` | `urn:oid:2.16.840.1.113883.6.238` | CDC | Free | Stable |
| `value-set` | `valueSetUrl`, `oid?`, `expansionDate`, `codesCount`, `source` (inline-measure / inline-library / vsac / unresolved) | — | VSAC (mostly) | UMLS | Per-source |
| `concept-map` | `id`, `sourceUri`, `targetUri`, `group[]` | — | mixed | mixed | — |

### 2.4 Payer / financial-graph nodes (already covered in §2.2 Financial + these payer-side additions)

| Node type | Attributes | FHIR resource / spec | Notes |
|---|---|---|---|
| `bb2-eob-import` | `importId`, `patientId`, `beneficiaryId`, `dataAsOf`, `resourcesCount` | CARIN Blue Button EOB | via [CMS BB 2.0 API](https://bluebutton.cms.gov/) — Patient, Coverage, EOB only |
| `bcda-export-job` | `jobId`, `groupId`, `since?`, `resourceTypes`, `status`, `outputManifest` | FHIR Bulk Data `$export` | via [BCDA](https://developer.cms.gov/) |
| `da-vinci-pas-request` | `pasRequestId`, `patientId`, `payerId`, `serviceRequestId`, `status` | Da Vinci PAS (Prior Auth Support) | payer IG |
| `da-vinci-crd-hook` | `hookId`, `hook`, `context`, `cards[]` | Da Vinci CRD (Coverage Requirements Discovery) | payer IG |
| `da-vinci-dtr-questionnaire` | `qrId`, `patientId`, `payerContext`, `status` | Da Vinci DTR (Documentation Templates & Rules) | payer IG |

### 2.5 Quality-measure nodes (FHIR Clinical Reasoning)

| Node type | Attributes | FHIR resource | Notes |
|---|---|---|---|
| `measure` | `measureId`, `cmsId`, `name`, `version`, `status`, `libraryRefsJson`, `contentHash`, `effectivePeriod?` | Measure | already in `src/measures/types.ts` |
| `measure-library` | `libraryId`, `name`, `version`, `cqlHash`, `elmJsonHash?`, `valueSetRefsJson`, `codeSystemRefsJson` | Library | CQL/ELM logic bundle |
| `measure-report.individual` | `reportId`, `measureId`, `patientId`, `evaluatedAt`, `measurementPeriod`, `populations[]`, `met` | MeasureReport (type=individual) | one row per patient per measure per period |
| `measure-report.summary` | `reportId`, `measureId`, `evaluatedAt`, `measurementPeriod`, `populations[]`, `numerator`, `denominator`, `rate` | MeasureReport (type=summary) | aggregated |
| `measure-report.subject-list` | `reportId`, `measureId`, `evaluatedAt`, `measurementPeriod`, `subjectListId` | MeasureReport (type=subject-list) | Group of patients meeting criteria |
| `plan-definition` | `planDefId`, `url`, `version`, `status`, `type?`, `action[]` | PlanDefinition | protocol/order-set logic |
| `activity-definition` | `activityDefId`, `url`, `version`, `status`, `kind`, `code?` | ActivityDefinition | template for orderable action |

### 2.6 Population / SDOH / public-health nodes

| Node type | Attributes | FHIR resource | Notes |
|---|---|---|---|
| `group` | `groupId`, `fhirRef`, `type`, `actual`, `code?`, `member[]?` | Group | patient cohorts (measure denominators, trial arms) |
| `population` | `populationId`, `realmId`, `criteriaHash`, `memberCount` | Group + Measure population criteria | derived |
| `hie-import` | `hieImportId`, `sourceEndpoint`, `patientId`, `resourcesCount`, `importedAt` | Bundle from HIE query | via TEFCA-QHIN or direct HIE FHIR |
| `sdoh-assessment` | `sdohAssessmentId`, `patientId`, `at`, `gravity?` (Gravity Project), `domain`, `finding` | Observation (US Core SDOH) + Condition | Gravity Project value sets |
| `nhsn-safr-report` | `reportId`, `facilityId`, `period`, `moduleKind` (infection / dialysis-event / neonatal) | MeasureReport per CDC NHSN SAFR IG | via [CDC NHSN SAFR](https://www.cdc.gov/nhsn/fhirportal/) |
| `ecr-report` | `ecrId`, `patientId`, `condition`, `submittedAt`, `stateAgency` | Bundle per eCR (electronic Case Reporting) IG | public health |
| `case-report` | `caseReportId`, `patientId`, `condition`, `submittedAt` | Composition (eCR) | reportable condition |
| `syndromic-surveillance` | `syndromicId`, `facilityId`, `visitAt`, `chiefComplaint` | HL7 v2 ADT feed (bridge) | ESSENCE / BioSense |

### 2.7 Research / trial / evidence nodes  

| Node type | Attributes | FHIR resource | Notes |
|---|---|---|---|
| `research-study` | `studyId`, `fhirRef`, `title`, `status`, `phase?`, `condition[]?`, `sponsor?` | ResearchStudy | ClinicalTrials.gov mapping |
| `research-subject` | `subjectId`, `fhirRef`, `patientId`, `studyId`, `status`, `period?` | ResearchSubject | enrollment |
| `evidence` | `evidenceId`, `fhirRef`, `url`, `title`, `status`, `assertion` | Evidence | ICER, USPSTF |
| `evidence-variable` | `evidenceVariableId`, `fhirRef`, `url`, `characteristic[]` | EvidenceVariable | PICO variables |
| `citation` | `citationId`, `fhirRef`, `url`, `citedArtifact` | Citation | PubMed article record |
| `molecular-sequence` | `sequenceId`, `fhirRef`, `patientId?`, `type`, `coordinateSystem`, `identifier` | MolecularSequence | genomics |
| `genomic-variant` | `variantId`, `fhirRef`, `patientId`, `sequenceId`, `identifier[]?` | Observation (Genomics IG) | HGVS |
| `pharmacogenomic` | `pgxId`, `fhirRef`, `patientId`, `medication?`, `finding` | Observation (PGx IG) | CPIC guidelines |

### 2.8 Interoperability ingest primitives — legacy standards mapped to FHIR

Every live US healthcare system still receives more HL7 v2 messages and C-CDA documents per day than direct FHIR calls. Da Vinci's payer graph runs on X12 5010 underneath. Pharmacies run on NCPDP. EMS runs on NEMSIS. The harness treats each of these as a **first-class ingest node** with a **deterministic mapping to FHIR** (per the HL7 v2-to-FHIR IG and C-CDA-on-FHIR IG). The raw artifact is retained by DocumentReference; the parsed content becomes typed FHIR resources + HyperNodes; provenance links them.

#### HL7 v2.x messages (canonical [v2.5.1 / v2.6 / v2.8 messaging](https://www.hl7.org/implement/standards/product_section.cfm?section=13); mapping per [v2-to-FHIR IG](https://build.fhir.org/ig/HL7/v2-to-fhir/))

| Node type | Attributes | v2 message | FHIR target(s) after mapping | Notes |
|---|---|---|---|---|
| `v2.adt` | `messageId`, `messageType` (A01–A62), `sendingApp`, `receivingApp`, `messageDateTime`, `patientId`, `visitNumber?`, `rawHash`, `mllpConnectionId?` | ADT^A01/A02/A03/A04/A05/A06/A07/A08/A11/A12/A13/A28/A31/A40/A44/A47 | Patient + Encounter + Location + Observation (allergies via IAM) + Provenance | admits/discharges/transfers/merges/demographics |
| `v2.orm` | `messageId`, `orderControl`, `placerOrderNumber`, `fillerOrderNumber?`, `patientId`, `orderingProviderId`, `rawHash` | ORM^O01 / OMG^O19 / OML^O21 / OMI^O23 / OMP^O09 | ServiceRequest + MedicationRequest (per code system) + Provenance | outbound orders |
| `v2.oru` | `messageId`, `patientId`, `orderNumber?`, `resultStatus`, `observationDateTime`, `rawHash` | ORU^R01 / ORU^R30 / ORU^R32 | DiagnosticReport + Observation + Specimen + Provenance | lab + imaging + POC results |
| `v2.siu` | `messageId`, `appointmentId`, `patientId`, `resourceId`, `startDateTime`, `duration`, `rawHash` | SIU^S12/S13/S14/S15/S17/S26 | Appointment + Schedule + Slot + Provenance | scheduling |
| `v2.mdm` | `messageId`, `documentType`, `patientId`, `activityDateTime`, `rawHash` | MDM^T01/T02/T04/T06/T08/T10/T11 | DocumentReference + Composition + Provenance | clinical document notification |
| `v2.dft` | `messageId`, `patientId`, `transactionType`, `transactionAmount`, `transactionDateTime`, `rawHash` | DFT^P03/P11 | ChargeItem + Account + Provenance | detailed financial transaction |
| `v2.bar` | `messageId`, `accountNumber`, `patientId`, `guarantorId?`, `rawHash` | BAR^P01/P02/P05/P06/P10/P12 | Account + Coverage + RelatedPerson (guarantor) + Provenance | account/billing |
| `v2.vxu` | `messageId`, `patientId`, `immunizationEventDateTime`, `rawHash` | VXU^V04 | Immunization + Provenance | to IIS registries |
| `v2.ras` | `messageId`, `patientId`, `medicationOrderNumber`, `administrationDateTime`, `rawHash` | RAS^O17 / RDS^O13 / RGV^O15 / RDE^O11 | MedicationAdministration + MedicationDispense + Provenance | pharmacy admin/dispense |
| `v2.ppr` | `messageId`, `patientId`, `problemActionCode`, `problemDateTime`, `rawHash` | PPR^PC1/PC2/PC3 | Condition + Provenance | patient problem list |
| `v2.rde` | `messageId`, `patientId`, `orderControl`, `medicationCode`, `rawHash` | RDE^O11 | MedicationRequest + Provenance | pharmacy encoded order |
| `v2.mfn` | `messageId`, `masterFileType`, `recordActionCode`, `rawHash` | MFN^M01/M02/M04/M05/M06/M08/M09/M11 | CodeSystem / ValueSet / Location / Practitioner (per master-file type) | master file notification |
| `v2.qbp / v2.rsp` | `queryId`, `queryTag`, `queryName`, `responseStatus`, `rawHash` | QBP^Q11/Q13/Q15/Q21 · RSP^K11/K13/K15/K21 | Query event (no resource) | ad-hoc queries |
| `v2.ack` | `messageId`, `acknowledgmentCode` (AA/AE/AR/CA/CE/CR), `referencedMessageId`, `rawHash` | ACK / ACK^*.* | AuditEvent + Provenance | delivery/parse ack |

#### C-CDA (Clinical Document Architecture) documents (per [C-CDA R2.1](https://www.hl7.org/implement/standards/product_brief.cfm?product_id=492); mapping per [C-CDA on FHIR IG](https://hl7.org/fhir/us/ccda/))

| Node type | Attributes | C-CDA templateId | FHIR target(s) | Notes |
|---|---|---|---|---|
| `cda.ccd` | `documentId`, `patientId`, `authorInstitution`, `effectiveTime`, `sections[]`, `rawHash` | 2.16.840.1.113883.10.20.22.1.2 | DocumentReference + Composition + (Condition, MedicationStatement, AllergyIntolerance, Immunization, Observation, Procedure) per section | Continuity of Care Document |
| `cda.discharge-summary` | `documentId`, `patientId`, `dischargeDate`, `rawHash` | 2.16.840.1.113883.10.20.22.1.8 | DocumentReference + Composition + Encounter + Condition + MedicationRequest | inpatient discharge |
| `cda.hp` | `documentId`, `patientId`, `visitDate`, `rawHash` | 2.16.840.1.113883.10.20.22.1.3 | DocumentReference + Composition + Condition + Observation | history & physical |
| `cda.consult-note` | `documentId`, `patientId`, `consultantId`, `rawHash` | 2.16.840.1.113883.10.20.22.1.4 | DocumentReference + Composition + Condition + Observation | consultation |
| `cda.progress-note` | `documentId`, `patientId`, `encounterId?`, `rawHash` | 2.16.840.1.113883.10.20.22.1.9 | DocumentReference + Composition + Observation | progress |
| `cda.op-note` | `documentId`, `patientId`, `procedureDate`, `rawHash` | 2.16.840.1.113883.10.20.22.1.7 | DocumentReference + Composition + Procedure + Observation | operative |
| `cda.procedure-note` | `documentId`, `patientId`, `procedureDate`, `rawHash` | 2.16.840.1.113883.10.20.22.1.6 | DocumentReference + Composition + Procedure | non-OR procedure |
| `cda.referral-note` | `documentId`, `patientId`, `referringProviderId`, `rawHash` | 2.16.840.1.113883.10.20.22.1.14 | DocumentReference + Composition + ServiceRequest | referral |
| `cda.transfer-summary` | `documentId`, `patientId`, `rawHash` | 2.16.840.1.113883.10.20.22.1.13 | DocumentReference + Composition + Condition + MedicationRequest | care setting transfer |
| `cda.care-plan` | `documentId`, `patientId`, `rawHash` | 2.16.840.1.113883.10.20.22.1.15 | DocumentReference + Composition + CarePlan + Goal + ServiceRequest | care plan document |
| `cda.diagnostic-imaging-report` | `documentId`, `patientId`, `studyId`, `rawHash` | 2.16.840.1.113883.10.20.22.1.5 (DIR) | DocumentReference + DiagnosticReport + ImagingStudy | radiology report |
| `cda.qrda-i` | `documentId`, `patientId`, `measurementPeriod`, `measures[]`, `rawHash` | 2.16.840.1.113883.10.20.24.1.2 | MeasureReport (type=individual) + Composition | QRDA Category I |
| `cda.qrda-iii` | `documentId`, `providerId`, `measurementPeriod`, `measures[]`, `rawHash` | 2.16.840.1.113883.10.20.27.1.2 | MeasureReport (type=summary) + Composition | QRDA Category III |
| `cda.consent` | `documentId`, `patientId`, `consentPolicy`, `rawHash` | 2.16.840.1.113883.10.20.22.1.16 | DocumentReference + Consent | consent directive |

#### X12 5010 (billing / eligibility / enrollment)

| Node type | Attributes | X12 transaction | FHIR target(s) | Notes |
|---|---|---|---|---|
| `x12.270` | `interchangeId`, `payerId`, `patientId`, `serviceTypeCodes[]`, `rawHash` | 270 Eligibility Inquiry | CoverageEligibilityRequest | Da Vinci PDex crosswalk |
| `x12.271` | `interchangeId`, `patientId`, `benefitsResponse`, `rawHash` | 271 Eligibility Response | CoverageEligibilityResponse | benefit detail |
| `x12.276` | `interchangeId`, `claimId?`, `rawHash` | 276 Claim Status Inquiry | Task + reference to Claim | AR follow-up |
| `x12.277` | `interchangeId`, `claimStatus[]`, `rawHash` | 277/277CA Claim Status Response | ClaimResponse (partial) | payer response |
| `x12.278` | `interchangeId`, `serviceRequestId`, `rawHash` | 278 Services Review (prior auth) | ServiceRequest + Task + Claim (proposed) | Da Vinci PAS crosswalk |
| `x12.834` | `interchangeId`, `sponsorId`, `memberChanges[]`, `rawHash` | 834 Benefit Enrollment | Coverage + Patient + Practitioner | employer/payer enrollment |
| `x12.835` | `interchangeId`, `checkNumber?`, `payments[]`, `rawHash` | 835 Remittance Advice | PaymentReconciliation + ClaimResponse | ERA |
| `x12.837p` | `interchangeId`, `claimId`, `patientId`, `serviceLines[]`, `rawHash` | 837 Professional | Claim + ExplanationOfBenefit (adjudicated) | professional billing |
| `x12.837i` | `interchangeId`, `claimId`, `patientId`, `serviceLines[]`, `rawHash` | 837 Institutional | Claim + ExplanationOfBenefit | hospital/facility billing |
| `x12.837d` | `interchangeId`, `claimId`, `patientId`, `serviceLines[]`, `rawHash` | 837 Dental | Claim + ExplanationOfBenefit | dental billing (CDT codes) |

#### NCPDP (pharmacy)

| Node type | Attributes | NCPDP standard | FHIR target(s) | Notes |
|---|---|---|---|---|
| `ncpdp.script.newrx` | `transactionId`, `prescriberId`, `patientId`, `medicationCode` (RxNorm/NDC), `rawHash` | NCPDP SCRIPT NewRx | MedicationRequest | e-prescribing |
| `ncpdp.script.refillrx` | `transactionId`, `originalRxRef`, `rawHash` | NCPDP SCRIPT RefillRequest / RefillResponse | MedicationRequest (renewal) | refill workflow |
| `ncpdp.script.cancelrx` | `transactionId`, `originalRxRef`, `rawHash` | NCPDP SCRIPT CancelRx | MedicationRequest (status=cancelled) | discontinue |
| `ncpdp.script.rxchange` | `transactionId`, `originalRxRef`, `changeType`, `rawHash` | NCPDP SCRIPT RxChangeRequest/Response | MedicationRequest (amendment) | prior-auth / therapeutic swap |
| `ncpdp.script.rxfill` | `transactionId`, `originalRxRef`, `rawHash` | NCPDP SCRIPT RxFill / RxHistory | MedicationDispense | fill notification |
| `ncpdp.d0-claim` | `transactionId`, `patientId`, `ndc`, `rawHash` | NCPDP Telecom D.0 | Claim (pharmacy) + ClaimResponse | retail pharmacy claim |
| `ncpdp.formulary-benefit` | `formularyId`, `rawHash` | NCPDP Formulary & Benefit Standard | List (formulary) + Coverage | payer formulary |

#### NEMSIS (EMS) + Direct + Fax / paper

| Node type | Attributes | Source spec | FHIR target(s) | Notes |
|---|---|---|---|---|
| `nemsis.epcr` | `pcrId`, `agencyId`, `incidentDateTime`, `patientId?`, `dispositionCode`, `rawHash` | [NEMSIS 3.5](https://nemsis.org/) | Encounter + Location + Procedure + Observation + Patient (unmatched) | electronic patient care report |
| `direct.message` | `directAddressFrom`, `directAddressTo`, `messageId`, `attachments[]`, `rawHash` | [Direct Project](https://directproject.org/) | Communication + DocumentReference (per attachment) | S/MIME clinical email |
| `fax.inbound` | `faxId`, `fromNumber`, `pageCount`, `ocrText?`, `rawHash` | fax bridge | DocumentReference + Composition (post-OCR) | still ~30% of US referral volume |
| `paper.scan` | `scanId`, `patientId?`, `docType?`, `rawHash` | scanner bridge | DocumentReference | paper backlog |

#### HIE / trust networks (the "where does the message come from" node)

| Node type | Attributes | Network | Notes |
|---|---|---|---|
| `hie.network` | `networkId` (`tefca-qhin` / `carequality` / `commonwell` / `ehealthexchange` / `state-hie.<state>`), `participantId`, `endpoints[]`, `trustFramework`, `status` | multiple | one row per network the realm participates in |
| `hie.query` | `queryId`, `networkId`, `patientDemographics`, `queryType` (`document-query` / `patient-discovery` / `bulk-export`), `at`, `resultsCount`, `rawHash` | any | outbound query |
| `hie.subscription` | `subscriptionId`, `networkId`, `topic` (patient-open / admit / discharge / medication-change), `endpoint`, `status` | Sequoia FHIR-native + IHE Subscription | inbound notifications |
| `ihe.xds-repository` | `repositoryOid`, `endpointUrl`, `status` | IHE ITI-42/ITI-43 | XDS.b Repository actor |
| `ihe.xds-registry` | `registryOid`, `endpointUrl`, `status` | IHE ITI-18/ITI-42 | XDS.b Registry actor |
| `ihe.xca-gateway` | `homeCommunityId`, `initiatingGatewayUrl?`, `respondingGatewayUrl?`, `status` | IHE ITI-38/ITI-39 | Cross-Community Access |
| `ihe.xcpd-gateway` | `homeCommunityId`, `endpointUrl`, `status` | IHE ITI-55/ITI-56 | Cross-Community Patient Discovery |
| `ihe.pdq-consumer` | `endpointUrl`, `status` | IHE ITI-21/ITI-22 | Patient Demographics Query |
| `ihe.pix-consumer` | `endpointUrl`, `status` | IHE ITI-9/ITI-10 | Patient Identifier Cross-Reference |

### 2.9 Live-observability primitives — the streaming spine

A harness is a **live observable system** or it isn't. Substrate SessionEvent is the internal ledger; §2.9 nodes are the wire-level channels that keep the realm current in twin mode. All emit `session-event` on transition and are queryable through the same hyperedge graph.

| Node type | Attributes | FHIR / spec anchor | Notes |
|---|---|---|---|
| `mllp-listener` | `listenerId`, `host`, `port`, `tlsCert?`, `sendingAppFilter?`, `status` | HL7 Lower Layer Protocol | inbound v2 socket per partner |
| `mllp-client` | `clientId`, `remoteHost`, `remotePort`, `tlsClientCert?`, `status` | HL7 LLP | outbound v2 (VXU to IIS, ELR to state) |
| `subscription.topic` | `subscriptionId`, `topic` (`http://hl7.org/SubscriptionTopic/*`), `channelType` (`rest-hook` / `websocket` / `email` / `message`), `endpoint`, `heartbeatPeriod`, `status` | [FHIR Subscription topic-based, R5 backport on R4B](https://build.fhir.org/ig/HL7/fhir-subscription-backport-ig/) | Subscription + SubscriptionTopic + SubscriptionStatus |
| `subscription.event` | `eventId`, `subscriptionId`, `eventNumber`, `notificationType`, `focus[]`, `at` | SubscriptionStatus + Bundle (notification) | one event per fire |
| `fhircast.hub` | `hubId`, `hubUrl`, `subscribedTopics[]`, `status` | [FHIRcast](https://fhircast.org/) | clinical context sync (Patient-open / ImagingStudy-open / Encounter-open) |
| `fhircast.event` | `eventId`, `hubId`, `event` (`Patient-open` / `Patient-close` / `ImagingStudy-open` / etc.), `context[]`, `at` | FHIRcast Event | context change fanout |
| `websocket-channel` | `channelId`, `endpoint`, `subscriberCount`, `status` | FHIR Subscription channelType=websocket | primary browser channel |
| `event-stream` | `streamId`, `partition?`, `retention?`, `schemaRef`, `status` | Kafka-compatible / NATS | internal stream backing session-event |
| `kafka-bridge` | `bridgeId`, `topic`, `direction` (`inbound` / `outbound`), `partner`, `status` | Kafka Connect / mirroring | multi-realm event fanout |
| `smart-launch-context` | `launchId`, `iss`, `patient?`, `encounter?`, `practitioner?`, `at` | [SMART App Launch v2](https://hl7.org/fhir/smart-app-launch/) | SMART on FHIR launch context |
| `udap-registration` | `registrationId`, `communityId`, `endpointUri`, `trustAnchorId`, `status` | [UDAP](https://www.udap.org/) | Trust community registration (FHIR at Scale) |
| `pixel-cursor.session` | `sessionId`, `realmId`, `viewer`, `openedAt`, `contextRef` | (harness-native, keyed to fhircast) | cursor / focus session (what a clinician is currently viewing) — the observability's UI edge |

**Total node types: 149** (22 substrate + 83 healthcare-domain + 44 interop + 10 live-observability + 3 pixel/streaming overlap — see §2.8/§2.9 for the interop/observability count).

---

## 3. Hyperedge types (typed FHIR reference chains)

Every FHIR `Reference()` becomes a role slot on a hyperedge. The hypergraph is what makes it possible to ask questions like "which patients in which realms hit CMS165 numerator in Q3 using RxNorm at what version?" — a query that spans clinical, quality, terminology, and provenance in one hop.

### 3.1 Substrate hyperedges

| Edge type | Roles → node types | Attributes |
|---|---|---|
| `realm-membership` | `realm` → realm; `member` (multi) → any healthcare node | `joinedAt`, `role` |
| `twin-composition` | `twin` → twin.persona / twin.device; `voice` (multi) → voice-channel; `skill` (multi) → skill; `policy` (multi) → policy-predicate; `wallet` → wallet | — |
| `twin-memory` | `twin` → twin.*; `entry` → memory-entry | — |
| `wallet-ledger` | `wallet` → wallet; `entry` → wallet-ledger-entry; `caused-by` → world-effect | — |
| `experience-composition` | `experience` → experience; `subject-twin` → twin.*; `fired-behavior` (multi) → behavior; `candidate` (multi) → candidate-action.*; `committed` (optional) → candidate-action.*; `realm` → realm | `at`, `rationale` |
| `effect-attribution` | `effect` → world-effect; `presence` → agent-presence; `agent-run` → agent-run; `experience` (optional) → experience; `subject` → any healthcare node | — |
| `presence-scope` | `presence` → agent-presence; `realm` → realm; `facility` → facility; `unit` (multi, optional) → unit; `patient` (multi, optional) → patient | `perceptualRange`, `clearance`, `purposeOfUse` |
| **`pack-source-subscription`** | `pack` → pack; `source` → knowledge-source; `used-by-behavior` (multi) → behavior; `used-by-measure` (multi, optional) → measure; `used-by-plan-definition` (multi, optional) → plan-definition | `scope`, `freshnessRequirement`, `criticality`, `transformId` |
| `source-artifact-provenance` | `source` → knowledge-source; `artifact` → knowledge-artifact; `sync-outcome` → sync-outcome | `sourceVersion`, `fetchedAt` |
| `session-event-causality` | `event` → session-event; `caused-by` (optional) → session-event; `emitted-by` → agent-presence / behavior; `about` → any node | `merkleRoot` |
| `identity-scope` | `principal` → identity-principal; `org` → organization (root); `facility` (multi) → facility; `realm` (multi) → realm | `role`, `clearance`, `purposeOfUse` |

### 3.2 FHIR-native clinical hyperedges

Each edge below corresponds to one or more `Reference()` fields on a FHIR resource. The hypergraph makes them typed and multi-role instead of scattered pointers.

| Edge type | Roles → node types | FHIR Reference source | Attributes |
|---|---|---|---|
| **`encounter-context`** | `encounter` → encounter; `patient` → patient; `location` (multi, optional) → location; `admitting` (optional) → practitioner; `attending` (optional) → practitioner; `service-provider` (optional) → organization | `Encounter.subject`, `Encounter.location`, `Encounter.participant`, `Encounter.serviceProvider` | `startAt`, `endAt` |
| **`care-team`** | `care-team-node` → care-team; `patient` → patient; `participant` (multi) → practitioner / related-person / practitioner-role; `managing-org` (optional) → organization | `CareTeam.subject`, `CareTeam.participant.member`, `CareTeam.managingOrganization` | `period` |
| `care-plan-composition` | `care-plan` → care-plan; `patient` → patient; `care-team` (optional) → care-team; `author` (multi) → practitioner; `goal` (multi, optional) → goal; `activity-reference` (multi, optional) → service-request / medication-request / task | `CarePlan.subject`, `CarePlan.careTeam`, `CarePlan.author`, `CarePlan.goal`, `CarePlan.activity.reference` | — |
| `order-thread.lab` | `service-request` → service-request; `patient` → patient; `requester` → practitioner; `performer` (optional, multi) → practitioner / organization; `resulting-report` (optional, multi) → diagnostic-report.lab; `resulting-observation` (multi, optional) → observation.lab; `specimen` (multi, optional) → specimen | `ServiceRequest.subject/requester/performer`, `DiagnosticReport.basedOn`, `Observation.basedOn`, `Specimen.request` | — |
| `order-thread.med` | `medication-request` → medication-request; `patient` → patient; `requester` → practitioner; `medication` → medication; `dispense` (multi, optional) → medication-dispense; `administration` (multi, optional) → medication-administration | `MedicationRequest.subject/requester/medicationReference`, `MedicationDispense.authorizingPrescription`, `MedicationAdministration.request` | — |
| `order-thread.imaging` | `service-request` → service-request; `patient` → patient; `requester` → practitioner; `study` (optional) → imaging-study; `report` (optional) → diagnostic-report.note | `ServiceRequest.subject`, `ImagingStudy.basedOn`, `DiagnosticReport.basedOn` | — |
| `order-thread.procedure` | `service-request` → service-request; `patient` → patient; `requester` → practitioner; `performed-procedure` (optional) → procedure | `ServiceRequest.subject`, `Procedure.basedOn` | — |
| `diagnostic-report-composition` | `report` → diagnostic-report.*; `patient` → patient; `encounter` (optional) → encounter; `performer` (multi, optional) → practitioner / organization; `result` (multi) → observation.lab; `specimen` (multi, optional) → specimen | `DiagnosticReport.subject/encounter/performer/result/specimen` | — |
| `observation-derivation` | `derived` → observation.*; `patient` → patient; `derived-from` (multi) → observation.* | `Observation.derivedFrom` | — |
| `condition-context` | `condition` → condition-*; `patient` → patient; `encounter` (optional) → encounter; `asserter` (optional) → practitioner | `Condition.subject/encounter/asserter` | — |
| `allergy-context` | `allergy` → allergy-intolerance; `patient` → patient; `recorder` (optional) → practitioner; `reaction-substance` (multi, optional) → medication / substance-concept | `AllergyIntolerance.patient/recorder`, `AllergyIntolerance.reaction.substance` | — |
| `immunization-context` | `immunization` → immunization; `patient` → patient; `performer` (multi, optional) → practitioner / practitioner-role; `encounter` (optional) → encounter; `manufacturer` (optional) → organization | `Immunization.patient/encounter/performer/manufacturer` | — |
| `medication-administration-context` | `administration` → medication-administration; `patient` → patient; `medication` → medication; `medication-request` (optional) → medication-request; `encounter` (optional) → encounter; `performer` (multi) → practitioner; `equipment` (optional) → equipment (pump) | `MedicationAdministration.subject/context/request/medicationReference/performer` | `givenAt`, `dose` |
| **`chair-assignment`** (dialysis-specific applied to Device) | `device` → equipment (chair); `patient` → patient; `location` → location (dialysis-floor); `assigning-staff` → practitioner; `treatment-encounter` → encounter | Device + Location + Encounter cross-reference | `assignedAt`, `releasedAt` |
| `document-reference-composition` | `document` → document-reference; `patient` → patient; `author` (multi, optional) → practitioner; `encounter` (optional) → encounter | `DocumentReference.subject/author/context.encounter` | — |
| `provenance-attribution` | `provenance` → provenance; `target` (multi) → any FHIR-shaped node; `agent` (multi) → practitioner / device / organization; `entity` (multi, optional) → any node | `Provenance.target/agent.who/entity.what` | `occurredDateTime`, `recorded` |
| `questionnaire-response-thread` | `response` → questionnaire-response; `patient` → patient; `questionnaire` → questionnaire; `author` (optional) → practitioner / patient | `QuestionnaireResponse.subject/questionnaire/author` | — |
| `task-lineage` | `task` → task; `for` → patient; `owner` (optional) → practitioner; `requester` (optional) → practitioner; `focus` (optional) → any node; `part-of` (optional) → task | `Task.for/owner/requester/focus/partOf` | — |
| **`hitl-approval-thread`** | `approval` → approval; `pending-effect` → world-effect; `requester-presence` → agent-presence; `approver-staff` → practitioner; `related-task` (optional) → task | — | — |

### 3.3 Financial hyperedges

| Edge type | Roles → node types | FHIR Reference source | Attributes |
|---|---|---|---|
| **`insurance-coverage`** | `coverage` → coverage; `patient` → patient; `payor` → organization; `subscriber` (optional) → patient / related-person; `plan-artifact` (optional) → knowledge-artifact | `Coverage.beneficiary/payor/subscriber` | `effectiveStart`, `effectiveEnd` |
| `eligibility-thread` | `request` → coverage-eligibility-request; `response` (optional) → coverage-eligibility-response; `patient` → patient; `insurer` → organization | `CoverageEligibilityRequest.patient/insurer` | — |
| **`prior-auth-thread`** | `priorAuth` → prior-auth; `patient` → patient; `payer` → organization; `service-code-artifact` (optional) → knowledge-artifact; `submitter-staff` → practitioner; `related-order` (optional, multi) → service-request / medication-request | `Task.for/for-code`, `Claim.patient/insurer` | — |
| **`claim-thread`** | `claim` → claim; `patient` → patient; `insurer` → organization; `provider` → organization / practitioner; `encounter` (optional) → encounter; `response` (optional) → claim-response; `eob` (optional) → explanation-of-benefit; `resubmitted-from` (optional) → claim | `Claim.patient/insurer/provider`, `ClaimResponse.request`, `ExplanationOfBenefit.claim` | — |
| `account-billing` | `account` → account; `patient` → patient; `charge-item` (multi) → charge-item; `coverage` (multi, optional) → coverage; `invoice` (optional) → invoice | `Account.subject`, `ChargeItem.account`, `Invoice.subject/account` | — |
| `bb2-import-thread` | `import` → bb2-eob-import; `patient` → patient; `eob` (multi) → explanation-of-benefit; `coverage` (multi, optional) → coverage | CMS BB 2.0 Bundle | `dataAsOf` |
| `bcda-job` | `job` → bcda-export-job; `group` → group; `resulting-resource` (multi) → any FHIR node | FHIR Bulk Data | `since`, `status` |
| `da-vinci-pas-thread` | `pas-request` → da-vinci-pas-request; `patient` → patient; `payer` → organization; `service-request` → service-request; `claim-response` (optional) → claim-response | Da Vinci PAS IG | — |
| `da-vinci-crd-thread` | `hook` → da-vinci-crd-hook; `patient` (optional) → patient; `medication-request` (optional) → medication-request; `service-request` (optional) → service-request | Da Vinci CRD | — |

### 3.4 Quality / measure hyperedges

| Edge type | Roles → node types | Attributes |
|---|---|---|
| **`measure-evaluation-provenance`** | `report` → measure-report.*; `measure` → measure; `library` (multi) → measure-library; `value-set` (multi) → value-set; `source` (multi) → knowledge-source; `patients-evaluated` (multi) → patient; `realm` → realm | `evaluatedAt`, `measurementPeriodStart`, `measurementPeriodEnd` |
| `measure-population-membership` | `report` → measure-report.summary; `measure` → measure; `population-code` (attr) → 'initial-population' / 'denominator' / 'numerator' / etc.; `patient` (multi) → patient | `at` |
| `plan-definition-composition` | `plan-def` → plan-definition; `activity-def` (multi) → activity-definition; `library` (multi) → measure-library; `used-by-behavior` (optional, multi) → behavior | — |

### 3.5 Terminology hyperedges

| Edge type | Roles → node types | Attributes |
|---|---|---|
| `value-set-membership` | `value-set` → value-set; `code-system` → code-system.*; `member-code` (attr) | `codesCount` |
| `concept-map-mapping` | `concept-map` → concept-map; `source-system` → code-system.*; `target-system` → code-system.* | — |
| `used-in-measure` | `code-system` → code-system.*; `value-set` (multi) → value-set; `measure` (multi) → measure | — |

### 3.6 Population / SDOH / public-health hyperedges

| Edge type | Roles → node types | Attributes |
|---|---|---|
| `sdoh-thread` | `assessment` → sdoh-assessment; `patient` → patient; `finding` (optional) → condition-problem-health-concern; `intervention` (optional, multi) → service-request; `resource-referral` (optional, multi) → healthcare-service | — |
| `case-report-thread` | `report` → case-report; `patient` → patient; `condition` → condition-*; `submitter` → organization; `receiver` → organization (state agency) | — |
| `nhsn-submission` | `report` → nhsn-safr-report; `facility` → facility; `population` → group | `period` |

### 3.7 Research hyperedges

| Edge type | Roles → node types | Attributes |
|---|---|---|
| `trial-enrollment` | `subject` → research-subject; `patient` → patient; `study` → research-study | `period` |
| `evidence-support` | `evidence` → evidence; `study` (multi, optional) → research-study; `citation` (multi, optional) → citation | — |
| `pgx-thread` | `pgx-result` → pharmacogenomic; `patient` → patient; `medication` (optional) → medication; `guideline` (optional) → knowledge-artifact | — |

### 3.8 Runtime hyperedges

| Edge type | Roles → node types | Attributes |
|---|---|---|
| **`ambient-delivery`** (M25) | `nudge` → candidate-action.human-nudge; `subject-twin` → twin.persona; `via-channel` → voice-channel; `via-equipment` (optional) → equipment; `ack-memory-entry` (optional) → memory-entry | `deliveredAt`, `ackedAt`, `droppedReason` |
| **`rehearsal-fork`** (M24) | `rehearsal-realm` → realm; `parent-realm` → realm; `forked-at-event` → session-event | `forkedAt`, `variantSeed` |
| **`federation`** (M26) | `parent-realm` → realm; `child-realm` (multi) → realm; `shared-pack` (multi) → pack; `boundary-policy` (multi) → policy-predicate | — |

### 3.9 Interop-ingest hyperedges (legacy artifact → FHIR resources + provenance)

Every inbound v2 / CDA / X12 / NCPDP / NEMSIS artifact carries the same three-role invariant: the **ingest node** (raw), the **FHIR resources** it produced, and the **provenance** that records the mapping. The pack that consumed the artifact is on the edge. Because it's hyper-edged, one v2 ADT^A08 can update Patient + Encounter + Location in a single mapping and every one of those FHIR resources shows up on the same edge.

| Edge type | Roles → node types | Mapping spec / FHIR anchor | Attributes |
|---|---|---|---|
| **`v2-to-fhir-map`** | `source-message` → v2.* (any); `target-resource` (multi) → patient / encounter / observation / medication-request / diagnostic-report / immunization / appointment / document-reference / condition / ...; `emitting-pack` → pack; `provenance` → provenance | [v2-to-FHIR IG](https://build.fhir.org/ig/HL7/v2-to-fhir/) | `mapVersion`, `mapRuleSet`, `mappedAt` |
| **`cda-to-fhir-map`** | `source-document` → cda.* (any); `target-resource` (multi) → document-reference / composition / condition / medication-statement / allergy-intolerance / immunization / observation / procedure / diagnostic-report / measure-report / consent / care-plan; `emitting-pack` → pack; `provenance` → provenance | [C-CDA on FHIR IG](https://hl7.org/fhir/us/ccda/) | `mapVersion`, `templateOid`, `mappedAt` |
| **`x12-to-fhir-map`** | `source-transaction` → x12.*; `target-resource` (multi) → coverage / coverage-eligibility-* / claim / claim-response / explanation-of-benefit / payment-reconciliation / task / service-request; `emitting-pack` → pack; `provenance` → provenance | Da Vinci PDex/PAS crosswalks; X12 5010 TR3 | `mapVersion`, `interchangeControlNumber`, `mappedAt` |
| **`ncpdp-to-fhir-map`** | `source-transaction` → ncpdp.*; `target-resource` (multi) → medication-request / medication-dispense / claim / list (formulary); `emitting-pack` → pack; `provenance` → provenance | NCPDP SCRIPT ↔ FHIR mapping | `scriptVersion`, `mappedAt` |
| **`nemsis-to-fhir-map`** | `source-epcr` → nemsis.epcr; `target-resource` (multi) → encounter / procedure / observation / location / patient; `emitting-pack` → pack; `provenance` → provenance | NEMSIS 3.5 ↔ FHIR crosswalk (NEMSIS TAC) | `nemsisVersion`, `mappedAt` |
| **`direct-message-thread`** | `source-message` → direct.message; `attachments` (multi, optional) → document-reference; `target-communication` → communication; `emitting-pack` → pack; `provenance` → provenance | Direct Project | `directTrustBundle`, `deliveredAt` |
| **`fax-ocr-thread`** | `source-fax` → fax.inbound; `target-document` → document-reference; `target-composition` (optional) → composition; `emitting-pack` → pack; `provenance` → provenance | — | `ocrEngine`, `ocrConfidence`, `mappedAt` |

### 3.10 HIE / network hyperedges (where each ingested artifact came from)

| Edge type | Roles → node types | Notes |
|---|---|---|
| **`hie-participation`** | `realm` → realm; `network` → hie.network; `bound-endpoint` (multi) → endpoint | one edge per realm × network |
| **`hie-query-thread`** | `query` → hie.query; `network` → hie.network; `patient-matched` (optional, multi) → patient; `resulting-import` (optional, multi) → hie-import | request ↔ response ↔ imported bundle |
| **`ihe-actor-binding`** | `realm` → realm; `actor` → ihe.xds-repository / ihe.xds-registry / ihe.xca-gateway / ihe.xcpd-gateway / ihe.pdq-consumer / ihe.pix-consumer | which IHE actors this realm exposes/consumes |
| **`carequality-directory-entry`** | `realm` → realm; `endpoint` → endpoint; `directory-attributes` (attributes) | published in the Sequoia directory |

### 3.11 Streaming / live-observability hyperedges

These edges are what make the harness a **live observable system**: every subscription event, FHIRcast context change, MLLP delivery, and internal event-stream write is a first-class edge, not a side-channel log.

| Edge type | Roles → node types | Attributes |
|---|---|---|
| **`subscription-topic-fanout`** | `subscription` → subscription.topic; `focus-resource` (multi) → any FHIR node; `delivered-event` (multi) → subscription.event; `subscriber-endpoint` → endpoint | `topicUrl`, `matchCount` |
| **`fhircast-context-thread`** | `hub` → fhircast.hub; `event` (multi) → fhircast.event; `subject` → patient / encounter / imaging-study; `cursor-session` (optional, multi) → pixel-cursor.session | `startedAt`, `endedAt?` |
| **`mllp-ingest`** | `listener` → mllp-listener; `partner-app` (attribute-only); `ingested-message` (multi) → v2.*; `ack-sent` (multi) → v2.ack | `receivedAt`, `parseStatus` |
| **`mllp-egress`** | `client` → mllp-client; `sent-message` → v2.*; `ack-received` (optional) → v2.ack | `sentAt`, `partnerAck` |
| **`event-stream-projection`** | `stream` → event-stream; `source-session-event` (multi) → session-event; `projection-consumer` (multi) → pack | `offset`, `lastReadAt` |
| **`smart-launch-thread`** | `launch-context` → smart-launch-context; `launched-app-endpoint` → endpoint; `patient` (optional) → patient; `encounter` (optional) → encounter; `practitioner` (optional) → practitioner | `scope`, `expiresAt` |
| **`cursor-attention`** | `cursor-session` → pixel-cursor.session; `viewing-patient` (optional) → patient; `viewing-encounter` (optional) → encounter; `viewing-imaging-study` (optional) → imaging-study; `focused-panel` (attribute) | `focusChangedAt` — substrate can observe *what a clinician is looking at* to time nudges |

**Total hyperedge types: 60** (11 substrate + 18 clinical + 9 financial + 3 quality + 3 terminology + 3 population + 3 research + 3 runtime + 7 interop-ingest + 4 HIE + 7 streaming/observability).

---

## 4. The full healthcare universe — 40+ domains × 25 packs

Every domain currently in `packs/` — plus the ones that need to exist for the app to be a full US healthcare app.

| Domain | Existing pack | Primary FHIR resources | Primary code systems | Notes |
|---|---|---|---|---|
| **Core (org, PHI, provenance, temporal)** | `healthcare-core` ✓ | Patient, Practitioner, Organization, Location, Encounter, Provenance, AuditEvent | — | mandatory |
| Primary care | `primary-care-deep` ✓ | Condition, Observation.vital, MedicationRequest, Immunization, Goal, CarePlan | ICD-10-CM, RxNorm, CPT, LOINC, CVX | USPSTF preventive screenings |
| Emergency dept | `ed-throughput` ✓ | Encounter (class=EMER), Observation.vital, Condition, Procedure | ICD-10-CM, LOINC, SNOMED | door-to-doc, LWBS metrics |
| Urgent care | `urgent-care-deep` ✓ | Encounter, MedicationRequest, ServiceRequest | ICD-10-CM, RxNorm | throughput + billing |
| Hospital inpatient | (in `healthcare-core`) | Encounter (class=IMP), Procedure, MedicationAdministration | ICD-10-PCS, HCPCS | LOS + readmission |
| Hospital-at-home | `hospital-at-home` ✓ | Encounter (extension=at-home), Device (IoT), Observation (RPM) | CPT, HCPCS | CMS AHCaH waiver |
| **Nephrology / dialysis** | `ckd-navigation` ✓ · `dialysis-deep` ✓ · `dialysis-provider` ✓ | Encounter (class=dialysis), Procedure (dialysis-tx), Observation (Kt/V, URR, vascular access) | LOINC (Kt/V), SNOMED (access types), RxNorm (renal-adjusted) | KDIGO, ESRD PPS, 2728/2746 forms |
| Care management / CCM | `care-management` ✓ | CarePlan, CareTeam, Task, Communication | ICD-10-CM, CPT (99490 CCM) | 2015 Cures Act CCM |
| Home health | `home-health` ✓ | Encounter (class=HH), ServiceRequest, MedicationAdministration | HCPCS (G-codes), ICD-10-CM | PDGM, OASIS |
| Long-term care | `long-term-care` ✓ | Encounter, Assessment (MDS 3.0) | ICD-10-CM, HCPCS | PDPM, MDS |
| Behavioral health | `behavioral-health` ✓ | Condition (F-codes), CarePlan, MedicationRequest, ServiceRequest | ICD-10-CM (F), SNOMED, DSM-5 crosswalks | 42 CFR Part 2, PHQ-9/GAD-7 |
| Oncology | `oncology-deep` ✓ · `oncology-provider` ✓ | Condition (C-codes), MedicationRequest (chemo), Procedure, MolecularSequence, Observation (tumor markers) | ICD-10-CM (C), NCCN, HGVS, HemOnc.org RxNorm | staging, OCM/EOM |
| Infusion | `infusion-provider` ✓ | ServiceRequest (infusion), MedicationAdministration, Encounter | RxNorm, HCPCS (J-codes) | Part B drugs |
| Radiology / imaging | `radiology` ✓ | ImagingStudy, DiagnosticReport (Report/Note), Observation | LOINC (rad), RadLex | DICOM SR, ACR AI |
| Payer / plan | `payer` ✓ | Coverage, CoverageEligibilityRequest/Response, Claim, ClaimResponse, EOB | ICD-10-CM, CPT, HCPCS, X12 837/835 crosswalks | Da Vinci PDex/PAS/CRD/DTR |
| Revenue cycle | `revenue-cycle` ✓ | Claim, ChargeItem, Account, Invoice, PaymentReconciliation | CPT, HCPCS, ICD-10-CM | AR days, denial rate |
| Research / pharma | `research-pharma` ✓ | ResearchStudy, ResearchSubject, Evidence, Citation | MedDRA, WHODrug, CT.gov | 21 CFR Part 11 |
| CMS quality universe | `cms-universe` ✓ · `flagship-agents` ✓ | Measure, Library, MeasureReport | eCQM catalog (CMS165, CMS122, CMS117, ...) | ~30 eCQMs |
| Policy templates | `policy-templates` ✓ | Consent, Contract | — | reusable predicates |
| Ontology core | `ontology-core` ✓ | CodeSystem, ValueSet, ConceptMap | UMLS | terminology substrate |
| Lifecycle core | `lifecycle-core` ✓ | (behaviors) | — | lifecycle behaviors |
| Mixed sample clinic | `mixed-sample-clinic` ✓ | (seeded realm) | — | test scenarios |
| **Pharmacy (dispensing)** | *(needs new pack `pharmacy`)* | MedicationDispense, MedicationRequest, Medication, Patient | RxNorm, NDC, NCPDP SCRIPT | outpatient / mail order / 340B |
| **Dental** | *(needs new pack `dental`)* | Encounter (class=AMB), Procedure, ChargeItem | CDT (ADA), SNOMED | ADA CDT code system |
| **Vision / optometry** | *(needs new pack `vision`)* | VisionPrescription, Encounter, Procedure | CPT, HCPCS | frame/lens SKU |
| **DME (durable medical equipment)** | *(needs new pack `dme`)* | DeviceRequest, SupplyRequest, SupplyDelivery | HCPCS (DMEPOS), NDC (supplies) | prior-auth heavy |
| **Hospice** | *(needs new pack `hospice`)* | Encounter (class=hospice), CarePlan, MedicationRequest | ICD-10-CM (Z51.5), HCPCS (Q-codes) | 6-month prognosis rule |
| **FQHC / community health** | *(subclass in `primary-care-deep`)* | Encounter, ChargeItem | HCPCS (T-codes), UDS reporting | HRSA UDS |
| **Rural (RHC / CAH)** | *(subclass in `healthcare-core`)* | Encounter, Location | HCPCS | CAH cost report |
| **Public health / eCR / syndromic** | *(needs new pack `public-health`)* | Composition (eCR), MessageHeader, MeasureReport (NHSN) | LOINC, SNOMED, ICD-10-CM (reportable) | CDC eCR, NHSN SAFR |
| **Genomics / precision** | *(subclass in `research-pharma`)* | MolecularSequence, Observation (Genomics IG) | HGVS, LOINC, HL7 Clinical Genomics IG | CPIC PGx |
| **SDOH** | *(subclass across packs; needs shared value sets)* | Observation (SDOH), Condition (Z-codes), Goal, ServiceRequest | LOINC (SDOH panels), SNOMED, Gravity Project value sets | HL7 SDOH-CC IG |
| **Occupational health** | *(needs new pack `occupational`)* | Observation (fitness for duty), Immunization, DocumentReference | ICD-10-CM, CPT, OSHA 300 | employer sponsors |
| **Telehealth** | *(cross-cutting extension on Encounter)* | Encounter (class=VR / telehealth), Communication | CPT (POS-02/10), HCPCS (Q3014) | licensure state matrix |
| **Ambulance / EMS** | *(needs new pack `ems`)* | Encounter, Location, Procedure | NEMSIS 3.5 ↔ FHIR crosswalk, HCPCS (A-codes) | via `nemsis-to-fhir-map` edge (§3.9) |
| **Lab reference** | *(subclass of order-thread.lab)* | ServiceRequest, DiagnosticReport, Observation, Specimen | LOINC, SNOMED | LIS integration |
| **Pathology** | *(subclass of `radiology` for reports)* | DiagnosticReport, Specimen, Observation | SNOMED (topography/morphology), LOINC | CAP eCC |
| **IoT / RPM (remote patient monitoring)** | *(cross-cutting; twin.device is primary)* | Device, Observation, DeviceMetric | LOINC, UCUM, IEEE 11073 | CPT 99453/99454/99457 |
| **Population health** | *(subclass of `care-management` + `flagship-agents`)* | Group, Measure, MeasureReport | eCQM catalog | ACO/MSSP |
| **Interop / TEFCA-QHIN** | *(needs new pack `interop`)* | Bundle, MessageHeader, Endpoint, Subscription, SubscriptionTopic, SubscriptionStatus | UDAP, IHE ITI, v2-to-FHIR, C-CDA-on-FHIR | QHIN + Carequality + CommonWell + eHealth Exchange participation; owns §2.8 + §2.9 |
| **Live streaming / observability** | *(cross-cutting; owned by `interop` pack)* | Subscription, SubscriptionTopic, SubscriptionStatus | FHIRcast, R5 Subscription backport | MLLP listeners + FHIRcast hubs + event-stream projections |
| **Enterprise identity** | (in `src/identity`) | Person, PractitionerRole | — | SMART on FHIR + WorkOS |

**42 domains, 25 existing packs, ~14 pack gaps to fill for full US healthcare coverage.**

---

## 5. Knowledge sources — the full universe

The pack↔source hypergraph is the load-bearing many-to-many. Every source below is a `KnowledgeSource` node. Packs subscribe via `PackSourceSubscription` edges with per-pack scope + criticality. Source universe is grouped by category.

### 5.1 Drug references

| Source ID | Name | Publisher | Tier | Cadence | Notes |
|---|---|---|---|---|---|
| `nlm.rxnorm` | RxNorm | NLM | api-key | Weekly | canonical drug normalization |
| `nlm.rxnav.interactions` | RxNav DDI | NLM | public | Weekly | drug-drug interaction |
| `fda.dailymed.spl` | DailyMed SPL | FDA | public | Daily | structured product labeling |
| `fda.openfda.drug-label` | OpenFDA Drug Label | FDA | public | Daily | drug labeling API |
| `fda.faers` | FAERS | FDA | public | Quarterly | adverse events |
| `fda.orange-book` | Orange Book | FDA | public | Monthly | approved products + patents |
| `fda.recalls` | Enforcement Reports | FDA | public | Weekly | drug/device recalls |
| `ashp.shortages` | ASHP Drug Shortages | ASHP | public | Daily | shortage list |
| `micromedex` | Micromedex | IBM/Merative | licensed | On-license | commercial drug reference |
| `uptodate` | UpToDate | Wolters Kluwer | licensed | On-license | clinical reference |
| `lexicomp` | Lexicomp | Wolters Kluwer | licensed | On-license | drug info |
| `ismp.high-alert` | ISMP High-Alert Medications | ISMP | public | Annual | safety list |
| `cpic.guidelines` | CPIC Pharmacogenomic Guidelines | CPIC | public | Quarterly | PGx |
| `hemonc.rxnorm` | HemOnc.org RxNorm regimens | HemOnc.org | public | Continuous | oncology regimens |

### 5.2 Terminology & code systems

| Source ID | Name | Publisher | Tier | Cadence |
|---|---|---|---|---|
| `nlm.vsac` | VSAC value sets | NLM | api-key | Continuous |
| `nlm.umls` | UMLS Metathesaurus | NLM | api-key | Semiannual |
| `nlm.snomed-us` | SNOMED CT US edition | NLM (IHTSDO US) | api-key | Semiannual |
| `regenstrief.loinc` | LOINC | Regenstrief | public | Biannual |
| `regenstrief.ucum` | UCUM | Regenstrief | public | As needed |
| `nucc.taxonomy` | NUCC Provider Taxonomy | NUCC | public | Semiannual |
| `cdc.icd-10-cm` | ICD-10-CM | CDC/NCHS | public | Annual |
| `cms.icd-10-pcs` | ICD-10-PCS | CMS | public | Annual |
| `cms.hcpcs` | HCPCS | CMS | public | Quarterly |
| `ama.cpt` | CPT | AMA | licensed | Annual |
| `fda.ndc` | NDC directory | FDA | public | Continuous |
| `cdc.cvx` | CVX (vaccines) | CDC | public | As needed |

### 5.3 Clinical guidelines

| Source ID | Name | Publisher | Tier | Cadence |
|---|---|---|---|---|
| `uspstf.recommendations` | USPSTF Recommendations | USPSTF | public | Continuous |
| `cdc.acip` | ACIP Immunization Schedules | CDC | public | Annual (Feb) |
| `aap.bright-futures` | AAP Bright Futures | AAP | public | Every 3 years |
| `kdigo.ckd` | KDIGO CKD | KDIGO | public | Multi-year |
| `kdigo.dialysis` | KDOQI Vascular Access | KDOQI | public | Multi-year |
| `idsa.guidelines` | IDSA Clinical Guidelines | IDSA | public | Continuous |
| `nccn.guidelines` | NCCN Guidelines | NCCN | licensed | Continuous |
| `aacn.protocols` | AACN Practice Alerts | AACN | public | As needed |
| `ana.standards` | ANA Standards | ANA | licensed | Multi-year |
| `cdc.mmwr-rr` | MMWR Recommendations & Reports | CDC | public | Continuous |
| `cdc.ipc` | CDC IPC Guidelines | CDC | public | Continuous |
| `nhsn.definitions` | NHSN Event Definitions | CDC | public | Annual |

### 5.4 Coverage & payer policy

| Source ID | Name | Publisher | Tier | Cadence |
|---|---|---|---|---|
| `cms.ncd` | National Coverage Determinations | CMS | public | Continuous |
| `cms.lcd` | Local Coverage Determinations | MACs | public | Continuous |
| `cms.mcd-articles` | Medicare Coverage DB articles | CMS | public | Continuous |
| `cms.esrd-pps` | ESRD PPS fee schedule | CMS | public | Annual |
| `cms.pfs` | Physician Fee Schedule | CMS | public | Annual |
| `cms.opps` | OPPS fee schedule | CMS | public | Annual |
| `cms.ipps` | IPPS fee schedule | CMS | public | Annual |
| `cms.dmepos` | DMEPOS fee schedule | CMS | public | Quarterly |
| `cms.pdpm-grouper` | PDPM Grouper | CMS | public | Annual |
| `cms.pdgm-grouper` | PDGM Grouper | CMS | public | Annual |
| `cms.clfs` | Clinical Lab Fee Schedule | CMS | public | Annual |
| `cms.mpfs-rvu` | MPFS RVU | CMS | public | Annual |
| `cms.blue-button-2` | CMS Blue Button 2.0 | CMS | api-key (patient OAuth) | Continuous |
| `cms.bcda` | Beneficiary Claims Data API | CMS | api-key (ACO / MA / VBP) | Continuous |
| `carin.blue-button-ig` | CARIN Blue Button IG | HL7 CARIN | public | Multi-year |
| `payer.medical-policy.*` | Payer medical policies | per-payer | entitlement | Per-payer |

### 5.5 Quality (eCQM + digital measures)

| Source ID | Name | Publisher | Tier | Cadence |
|---|---|---|---|---|
| `cms.ecqm-fhir` | eCQM content (FHIR/QICore) | CMS | public | Annual |
| `cms.ecqm-qdm` | eCQM content (QDM legacy) | CMS | public | Annual |
| `ncqa.hedis` | HEDIS Measures | NCQA | licensed | Annual |
| `cms.mips-measures` | MIPS Quality Measures | CMS | public | Annual |
| `cms.stars-measures` | Medicare Stars | CMS | public | Annual |

### 5.6 Public health / registries / trials

| Source ID | Name | Publisher | Tier | Cadence |
|---|---|---|---|---|
| `nih.pubmed` | PubMed | NLM | public | Daily |
| `nih.medline` | MedlinePlus | NLM | public | Daily |
| `nih.clinicaltrials-gov` | ClinicalTrials.gov | NIH | public | Daily |
| `cdc.wonder` | CDC WONDER | CDC | public | Weekly |
| `cdc.essence` | ESSENCE syndromic | CDC | entitlement | Real-time |
| `state.pdmp.*` | State PDMP | per-state | entitlement | Real-time |
| `nppes.npi` | NPPES NPI Registry | CMS | public | Weekly |
| `oig.exclusions` | OIG Exclusions LEIE | OIG | public | Monthly |
| `sam.gov` | SAM.gov Exclusions | GSA | public | Daily |
| `hrsa.uds` | HRSA UDS Reporting | HRSA | public | Annual |
| `state.license.*` | State provider licensure | per-state | entitlement | Per-state |
| `gravity.value-sets` | Gravity Project SDOH VSs | HL7 SDOH-CC | public | Continuous |

### 5.7 Interoperability & implementation guides

| Source ID | Name | Publisher | Tier | Cadence |
|---|---|---|---|---|
| `hl7.uscore` | US Core STU7 | HL7 | public | Annual |
| `hl7.qicore` | QICore STU6 | HL7 | public | Annual |
| `hl7.davinci-*` | Da Vinci IGs (PAS, PDex, CRD, DTR, CDex, HRex) | HL7 Da Vinci | public | Continuous |
| `hl7.sdoh-cc` | SDOH-CC IG | HL7 | public | Annual |
| `hl7.ecr` | eCR (electronic Case Reporting) IG | HL7 / CDC | public | Annual |
| `hl7.ihe-profiles` | IHE ITI profiles (XDS.b, XCA, XCPD, PDQ, PIX) | IHE | public | Annual |
| `onc.uscdi` | USCDI (v5, v6) | ONC | public | Annual |
| `hl7.v2` | HL7 v2.x messaging standard (v2.5.1 / v2.6 / v2.8 / v2.9) | HL7 | public / member | Multi-year |
| `hl7.v2-to-fhir` | v2-to-FHIR IG (canonical ADT/ORM/ORU/SIU/MDM/DFT/BAR/VXU/RAS/PPR mapping rules) | HL7 | public | Continuous |
| `hl7.c-cda` | Consolidated CDA R2.1 (CCD, DS, H&P, Consult, OpNote, ProgressNote, ProcedureNote, ReferralNote, TransferSummary, CarePlan, DIR, Consent) | HL7 | public / member | Multi-year |
| `hl7.ccda-on-fhir` | C-CDA on FHIR IG | HL7 | public | Continuous |
| `hl7.fhircast` | FHIRcast (clinical context sync) | HL7 | public | Continuous |
| `hl7.subscription-backport` | FHIR Subscription topic-based (R5 backport on R4B) | HL7 | public | Continuous |
| `hl7.smart-app-launch` | SMART App Launch v2 (SMART on FHIR) | HL7 | public | Annual |
| `hl7.bulk-data` | FHIR Bulk Data Access IG | HL7 | public | Annual |
| `udap.trust-community` | UDAP trust community registration | UDAP.org | public / community | Continuous |
| `sequoia.tefca` | TEFCA QHIN SOPs & directory | Sequoia Project / RCE | public | Continuous |
| `sequoia.carequality` | Carequality directory + implementer's guide | Sequoia Project | member | Continuous |
| `commonwell.services` | CommonWell services + directory | CommonWell Alliance | member | Continuous |
| `ehealthexchange` | eHealth Exchange participant directory | eHealth Exchange | member | Continuous |
| `directtrust` | DirectTrust anchor bundles + provider directory | DirectTrust | member | Continuous |
| `x12.5010-tr3` | X12 5010 Technical Reports Type 3 (270/271/276/277/278/834/835/837 P/I/D) | X12 | member (paid) | Multi-year |
| `ncpdp.script` | NCPDP SCRIPT (e-prescribing) implementation guide | NCPDP | member (paid) | Annual |
| `ncpdp.telecom-d0` | NCPDP Telecom D.0 + Formulary & Benefit Standard | NCPDP | member (paid) | Annual |
| `nemsis.data-dictionary` | NEMSIS 3.5 data dictionary + XSD | NEMSIS TAC | public | Continuous |

### 5.8 Customer-supplied

| Source ID template | Name | Publisher | Tier | Cadence |
|---|---|---|---|---|
| `customer.formulary.<orgId>` | Local formulary | customer | customer-supplied | Manual |
| `customer.order-sets.<orgId>` | Local order sets | customer | customer-supplied | Manual |
| `customer.antibiogram.<orgId>` | Local antibiogram | customer | customer-supplied | Manual |
| `customer.protocol.<orgId>` | Local protocol/pathway | customer | customer-supplied | Manual |

**~110 sources total across drug (14), terminology (12), guideline (12), payer (16), quality (5), public health (12), interop + legacy standards + trust networks (27), customer-supplied (4).** This is what packs subscribe to via `pack-source-subscription`. The interop set (§5.7) is what powers the live-observability spine — v2, C-CDA, X12, NCPDP, NEMSIS, IHE, TEFCA/QHIN, Carequality, CommonWell, eHealth Exchange, DirectTrust, UDAP — every ingested artifact carries a pointer back to the source spec that defined its shape.

---

## 6. Admin UI screens (one per node/edge cluster, no duplicates)

Grouped by the corrected user journey. Each screen has one job.

| Journey step | Screen | Primary nodes | Primary edges | Notes |
|---|---|---|---|---|
| 1 | **Sign in** | identity-principal | identity-scope | OIDC / SAML / WorkOS |
| 2 | **Realms** | realm | realm-membership | list + create; `mode` (sim / twin) is the fork point |
| 3 | **Realm > Packs** | pack | pack node registration | shows installed + available across the 42-domain universe (§4) |
| 4a | **Realm > Terminology** | code-system.*, value-set, concept-map | value-set-membership, used-in-measure | terminology bootstrap wizard |
| 4b | **Realm > Sources** | knowledge-source, pack-source-subscription | pack-source-subscription, source-artifact-provenance | credential wizard, freshness contract |
| 4c | **Realm > Sources > Sync history** | sync-outcome, knowledge-artifact | source-artifact-provenance | append-only |
| 5a | **Realm > FHIR Bridge** | endpoint, bcda-export-job, bb2-eob-import, hie-import | (import edges) | Bulk `$export`, Subscription, HIE query |
| 5b-1 | **Realm > Interop > MLLP** | mllp-listener, mllp-client, v2.* (all types) | mllp-ingest, mllp-egress, v2-to-fhir-map | per-partner v2 sockets + parse status + ACK queue |
| 5b-2 | **Realm > Interop > Documents** | cda.*, direct.message, fax.inbound, paper.scan | cda-to-fhir-map, direct-message-thread, fax-ocr-thread | C-CDA + Direct + fax/paper inbound |
| 5b-3 | **Realm > Interop > X12 & NCPDP** | x12.*, ncpdp.* | x12-to-fhir-map, ncpdp-to-fhir-map | payer + pharmacy trading partners |
| 5b-4 | **Realm > Interop > EMS** | nemsis.epcr | nemsis-to-fhir-map | inbound ePCRs from EMS agencies |
| 5b-5 | **Realm > Interop > HIE / Networks** | hie.network, hie.query, hie.subscription, ihe.* | hie-participation, hie-query-thread, ihe-actor-binding, carequality-directory-entry | TEFCA/QHIN + Carequality + CommonWell + eHealth Exchange + IHE actors |
| 5b-6 | **Realm > Interop > Streams** | subscription.topic, subscription.event, fhircast.hub, fhircast.event, websocket-channel, event-stream, kafka-bridge | subscription-topic-fanout, fhircast-context-thread, event-stream-projection | live subscription + FHIRcast + internal streams |
| 5b-7 | **Realm > Interop > Trust & Launch** | smart-launch-context, udap-registration | smart-launch-thread | SMART on FHIR launches + UDAP trust communities |
| 5b-8 | **Realm > Interop > Cursor / Attention** | pixel-cursor.session | cursor-attention, fhircast-context-thread | what a clinician is looking at right now (timing signal for nudges) |
| 5b | **Realm > Population** | facility, unit, organization, location, practitioner, practitioner-role, equipment | encounter-context (empty until 6) | seed (sim) or bridge (twin) |
| 6a | **Realm > Patients** | patient, encounter, episode-of-care, flag | encounter-context, care-team, care-plan-composition | active + historical; drill-in reveals encounter timeline |
| 6b | **Realm > Twins** | twin.persona, twin.device | twin-composition, twin-memory | one row per twin; voice channels + skills + policy count |
| 6c | **Realm > Devices / RPM** | equipment, device (implantable) | medication-administration-context (pump), chair-assignment | IoT + implantables |
| 7a | **Realm > Behaviors** | behavior, plan-definition, activity-definition | plan-definition-composition | per-installed-pack behavior list; cohort scoping |
| 7b | **Realm > Consent & Policy** | consent, contract, policy-predicate | (policy edges) | patient-facing consents + operator predicates |
| 8a | **Realm > Live** | experience, candidate-action.*, world-effect | experience-composition, effect-attribution, ambient-delivery | tick-by-tick observability |
| 8b | **Realm > Approvals (HITL)** | approval, task | hitl-approval-thread, task-lineage | approval queue |
| 9a | **Realm > Clinical > Orders** | service-request, medication-request | order-thread.* (lab/med/imaging/procedure) | orders + results |
| 9b | **Realm > Clinical > Meds** | medication, medication-request, medication-dispense, medication-administration, medication-statement | order-thread.med, medication-administration-context, allergy-context | reconciliation view |
| 9c | **Realm > Clinical > Labs & Diagnostics** | diagnostic-report.*, observation.*, specimen, imaging-study | diagnostic-report-composition | results view |
| 9d | **Realm > Clinical > Immunizations** | immunization, immunization-recommendation | immunization-context | CVX-coded |
| 9e | **Realm > Clinical > Care plans & Teams** | care-plan, care-team, goal, task | care-plan-composition, care-team | longitudinal care |
| 9f | **Realm > Clinical > Docs & Notes** | document-reference, composition, questionnaire, questionnaire-response | document-reference-composition, questionnaire-response-thread | notes + assessments |
| 9g | **Realm > Financial > Coverage** | coverage, coverage-eligibility-request/response | insurance-coverage, eligibility-thread | benefit lookup |
| 9h | **Realm > Financial > Prior auth** | prior-auth, da-vinci-pas-request | prior-auth-thread, da-vinci-pas-thread | Da Vinci PAS |
| 9i | **Realm > Financial > Claims & EOB** | claim, claim-response, explanation-of-benefit, account, charge-item, invoice, payment-reconciliation | claim-thread, account-billing | full revenue cycle |
| 9j | **Realm > Quality > Measures** | measure, measure-library, value-set, measure-report.* | measure-evaluation-provenance, measure-population-membership | eCQM computation |
| 9k | **Realm > Population > SDOH** | sdoh-assessment, group | sdoh-thread | Gravity value sets |
| 9l | **Realm > Population > Public Health** | case-report, ecr-report, nhsn-safr-report, syndromic-surveillance | case-report-thread, nhsn-submission | public-health reporting |
| 9m | **Realm > Research** | research-study, research-subject, evidence, citation, molecular-sequence, pharmacogenomic | trial-enrollment, evidence-support, pgx-thread | trials + genomics |
| 9n | **Realm > Provenance** | session-event, provenance | session-event-causality, provenance-attribution | Merkle-anchored timeline |
| 9o | **Realm > Wallets** | wallet, wallet-ledger-entry | wallet-ledger | per-twin economics |
| — | **Cross-realm > Source fanout** | knowledge-source | pack-source-subscription | many-to-many view (a source consumed by N packs) |
| — | **Cross-realm > Rehearsals** (M24) | realm | rehearsal-fork | forked realms per parent |
| — | **Federation** (M26) | realm | federation | parent → children |

**41 screens.** Zero overlap. Each screen is one hyperedge query + attribute display. The 8 new screens under step 5b are what turn a realm from "static snapshot" into a **live-observable system** — they surface every legacy message, every network query, every live event on the same substrate as the FHIR resources they produce.

---

## 7. What's missing from the repo (the honest gap list)

To make the admin UI implementable against this hypergraph:

1. **`packs/healthcare-core/nodes.ts`** — register every §2 node type (all 105) against `HypergraphSchema` on pack load.
2. **`packs/healthcare-core/edges.ts`** — register every §3 hyperedge type (all 42).
3. **`src/realm/entity-record.ts`** — bridge from the existing `EntityRecord` (string-keyed `state`) to typed `HyperNode` insertion. Every `applyEffect` emits both an `EntityRecord` patch AND a `HyperNode` upsert.
4. **`src/fhir/mapper/`** — deterministic FHIR R4 resource → `HyperNode` mapping. One mapper per FHIR resource type; profile-aware (US Core / QICore).
5. **`src/fhir/bridge/`** — three modes:
   - `bulk-export` (Group `$export` per BCDA + generic Bulk Data)
   - `subscription` (FHIR R5 Subscription topic-based, back-portable to R4B channel-based)
   - `smart-on-fhir` (per-user OAuth for read/write)
6. **`src/terminology/store/`** — code-system loaders for all 12 sources in §5.2 with content-hash pinning per realm.
7. **`src/hypergraph/queries/healthcare/`** — canned queries backing each admin screen (e.g. `careTeamFor(patientId)`, `sourceFanout(sourceId)`, `measureReportsForRealm(realmId, period)`, `orderThreadFor(patientId, kind)`).
8. **`packs/pharmacy/`, `packs/dental/`, `packs/vision/`, `packs/dme/`, `packs/hospice/`, `packs/public-health/`, `packs/occupational/`, `packs/ems/`, `packs/interop/`** — the ~14 missing packs from §4.
9. **`hh-admin-ui/src/routes/`** — one route per §6 screen (41 routes), wired to (7).
10. **`src/interop/v2/`** — HL7 v2 parser (per v2-to-FHIR IG) + MLLP listener/client + per-message-type mapper modules (`adt.ts`, `orm.ts`, `oru.ts`, `siu.ts`, `mdm.ts`, `dft.ts`, `bar.ts`, `vxu.ts`, `ras.ts`, `ppr.ts`, `rde.ts`, `mfn.ts`).
11. **`src/interop/cda/`** — C-CDA R2.1 parser + per-templateOid mapper (CCD, DS, H&P, Consult, OpNote, Progress, Procedure, Referral, Transfer, CarePlan, DIR, QRDA I/III, Consent) per C-CDA-on-FHIR IG.
12. **`src/interop/x12/`** — X12 5010 parser + per-transaction mapper (270/271/276/277/278/834/835/837 P/I/D) with Da Vinci PDex/PAS crosswalks.
13. **`src/interop/ncpdp/`** — NCPDP SCRIPT + Telecom D.0 parser + per-transaction mapper.
14. **`src/interop/nemsis/`** — NEMSIS 3.5 ePCR parser + FHIR mapper.
15. **`src/interop/direct/`** — Direct Project (S/MIME) inbound + outbound.
16. **`src/interop/hie/`** — IHE ITI actors (XDS.b Repo/Registry, XCA, XCPD, PDQ, PIX) + TEFCA/QHIN + Carequality + CommonWell + eHealth Exchange adapters.
17. **`src/interop/streams/`** — FHIR Subscription topic-based (R5 backport) engine, FHIRcast hub, WebSocket channel, event-stream projection layer.
18. **`src/interop/smart/`** — SMART on FHIR launch + UDAP trust community registration.
19. **`packs/interop/`** — the pack that registers every §2.8/§2.9 node type and every §3.9/§3.10/§3.11 edge type against the schema; subscribes to `hl7.v2`, `hl7.v2-to-fhir`, `hl7.c-cda`, `hl7.ccda-on-fhir`, `hl7.fhircast`, `hl7.subscription-backport`, `hl7.smart-app-launch`, `hl7.bulk-data`, `hl7.ihe-profiles`, `sequoia.tefca`, `sequoia.carequality`, `commonwell.services`, `ehealthexchange`, `directtrust`, `udap.trust-community`, `x12.5010-tr3`, `ncpdp.script`, `ncpdp.telecom-d0`, `nemsis.data-dictionary`.

None of these are large files individually. This is missing wiring + a handful of new packs + the interop bridge layer, not new architecture — the substrate machinery is already there. The interop layer (10–19) is the difference between "looks like a healthcare app" and "is a live observable US healthcare system".

---

## 8. Invariants that must hold across the hypergraph

- **Every non-substrate node carries a `realmId` attribute.** No node lives outside a realm. Enforced at `HypergraphSchema.registerNode` time.
- **Every FHIR-shaped node carries a `fhirRef` attribute** (`ResourceType/id`) so it round-trips to the source EHR.
- **Every hyperedge that binds a domain node also binds the realm.** No cross-realm edges except the four whitelisted ones: `rehearsal-fork`, `federation`, `pack-source-subscription`, `source-artifact-provenance`.
- **Every `world-effect` node is causally linked to a `presence` and an `agent-run` via `effect-attribution`.** No effect without an actor.
- **Every `memory-entry` node has `sourceUri + contentHash`.** Enforced by `Twin.memory` typing.
- **Every code used in a coded field references a `code-system.*` node with a pinned version.** No unversioned codes.
- **Every `measure-report.*` node references its `measure`, `measure-library`, and `value-set` nodes with content-hashed versions** via `measure-evaluation-provenance`. Replay demands this.
- **`pack-source-subscription` is the only way a pack reads a source.** No pack code may call an adapter directly.
- **Deny-by-default at the policy-predicate layer.** A candidate action with no matching `allow` predicate is dropped before ranking.
- **Every FHIR resource change generates a `Provenance` node AND a `session-event`.** Provenance for FHIR consumers; session-event for the substrate's replay ledger.
- **Every inbound legacy artifact (v2, C-CDA, X12, NCPDP, NEMSIS, Direct, fax, paper) is a first-class ingest node AND is mapped to one or more FHIR resources by an `*-to-fhir-map` hyperedge.** The raw artifact is retained by DocumentReference + content-hash for audit and round-trip; the parsed FHIR resources drive behaviors and measures. No legacy artifact bypasses FHIR internally.
- **Every subscription fire, FHIRcast context change, MLLP delivery, and event-stream write is a hyperedge — not a side-channel log.** Enforced at the bridge layer: writing to a stream without registering the corresponding `subscription.event` / `mllp-ingest` / `fhircast.event` node is a bug.
- **Every mapping edge (`*-to-fhir-map`) carries the mapping-spec version.** Replay against a historical v2.5.1 message must produce the same FHIR output as the day it was received. Mapping is content-addressable.
- **A realm is "live" iff it has at least one bound channel from §2.9.** The admin UI displays the realm's liveness tier: `sim` → `twin-static` (Bulk Data only) → `twin-live` (Subscription + FHIRcast + MLLP).

---

## 9. Coverage check — every code entity + every FHIR resource + every USCDI class accounted for

### 9.1 Repo types

| From file | Concept | Node type in §2 |
|---|---|---|
| `twin/types.ts` | Twin, TwinIdentity, PolicyPredicate, MemoryEntry, VoiceChannel, Skill, Wallet, WalletLedgerEntry | ✓ all 8 |
| `realm/types.ts` | 18 EntityKind variants + AgentPresence, WorldEffect, PerceivedEvent, ClockTick, EntityRecord | ✓ all mapped |
| `behaviors/types.ts` | Behavior, Experience, SystemEpisode, HumanNudge | ✓ all 4 |
| `hypergraph/types.ts` | HyperNode, HyperEdge, HypergraphSchema | ✓ (substrate) |
| `knowledge/types.ts` | KnowledgeSourceSpec, KnowledgeArtifact, PackSourceSubscription, SourceScope, SyncOutcome, SourceChange, SourceConsumerFanout, PackKnowledgeBill, KnowledgeEvent | ✓ 5 nodes + 2 edges + 1 event kind |
| `identity/types.ts` | IdentityPrincipal, IdentityProviderConfig, RoleMapping | ✓ 1 node + edge |
| `measures/types.ts` | StoredMeasure, StoredLibrary, StoredValueSet, EvaluationResult, MeasureChange | ✓ 4 nodes + 1 edge |
| `packs/*/index.ts` (25 packs) | DomainPack manifest | ✓ each becomes a `pack` node |

### 9.2 FHIR R4 resource coverage

Nodes explicitly mapped to FHIR R4: **69 resources** across the 7 modules — Foundation (Endpoint, Subscription, SubscriptionTopic [R5-backport], SubscriptionStatus), Base/Administration (Patient, Practitioner, PractitionerRole, RelatedPerson, Organization, Location, HealthcareService, Device, Endpoint, Schedule [via SIU], Slot [via SIU]), Clinical (Condition, Observation, AllergyIntolerance, Procedure, FamilyMemberHistory, ClinicalImpression, AdverseEvent, BodyStructure, Immunization, ImmunizationRecommendation), Diagnostic (DiagnosticReport, Specimen, ImagingStudy, DocumentReference, Composition), Medications (Medication, MedicationRequest, MedicationDispense, MedicationAdministration, MedicationStatement, VisionPrescription), Care Provision (CarePlan, CareTeam, Goal, ServiceRequest, NutritionOrder, RiskAssessment, RequestGroup), Request & Response (Communication, CommunicationRequest, Task, Questionnaire, QuestionnaireResponse, MessageHeader), Financial (Account, ChargeItem, ChargeItemDefinition, Claim, ClaimResponse, Contract, Coverage, CoverageEligibilityRequest, CoverageEligibilityResponse, EnrollmentRequest, EnrollmentResponse, ExplanationOfBenefit, Invoice, PaymentNotice, PaymentReconciliation), Workflow (Appointment, EpisodeOfCare, Flag, Group, List [via NCPDP formulary]), Terminology (CodeSystem, ValueSet, ConceptMap), Clinical Reasoning (Measure, Library, MeasureReport, PlanDefinition, ActivityDefinition, Evidence, EvidenceVariable, Citation), Public Health & Research (ResearchStudy, ResearchSubject), Genomics (MolecularSequence), Foundation (Provenance, AuditEvent, ImplementationGuide, Person, Bundle, Consent [via CDA + v2 mapping]).

Not yet modeled (out of ~145): DeviceMetric, DeviceDefinition, Substance, ManufacturedItemDefinition, Ingredient, and other rarely-used FHIR resources. All are additive at any point without breaking §2.

### 9.3 US Core STU7 profile coverage

All 26+ US Core profiles referenced in §2.2 (Patient, Practitioner, PractitionerRole, RelatedPerson, Organization, Location, Encounter, Condition [×2], AllergyIntolerance, Procedure, Observation Vital Signs, Laboratory Result Observation, Smoking Status, Pediatric BMI/Weight/Head-OFC, SDOH Assessment, Pregnancy Status, SPCU, Advance Directive Observation, DiagnosticReport [×2], Specimen, DocumentReference, MedicationRequest, Medication, MedicationDispense, MedicationAdministration, MedicationStatement, Immunization, CarePlan, CareTeam, Goal, ServiceRequest, Coverage, DeviceRequest [via ServiceRequest], Implantable Device, Provenance, QuestionnaireResponse, Endpoint).

### 9.4 QICore STU6 profile coverage

30+ QICore profiles referenced (AdverseEvent, AllergyIntolerance, BodyStructure, CarePlan, CareTeam, Claim, ClaimResponse, Communication [×3], CommunicationRequest, Condition [×2], Coverage, Device, DeviceRequest [×3], DeviceUseStatement, DiagnosticReport [×2], Encounter, FamilyMemberHistory, Flag, Goal, ImagingStudy, Immunization, MedicationAdministration [×2], MedicationDispense [×2], MedicationNotRequested, MedicationRequest, MedicationStatement, NutritionOrder, Organization, Patient, Practitioner, Procedure, QuestionnaireResponse, ServiceRequest, Task [×3]).

### 9.5 USCDI v5 data-class coverage

All 22 USCDI v5 data classes represented across §2.2 nodes:
Allergies and Intolerances, Care Team Members, Clinical Notes, Clinical Tests, Diagnostic Imaging, Encounter Information, Facility Information, Goals and Preferences, Health Insurance Information, Health Status Assessments, Immunizations, Laboratory, Medical Devices, Medications, Observations (new v5), Orders (new v5), Patient Demographics/Information, Problems, Procedures, Provenance, Vital Signs, plus the v5 additions (Advance Directive Observation, Pronouns, Sex Parameter for Clinical Use, Name to Use, Interpreter Needed, Author/Author Role, Lot Number, Route of Administration, five new Order elements).

### 9.6 Code-system coverage

All code systems on the [HL7 THO external code systems](https://terminology.hl7.org/external_terminologies.html) list that appear in US healthcare are §2.3 nodes with canonical URIs pinned.

**No orphans.** Every exported type from every `types.ts` in the repo is a node, edge, attribute, or query. Every USCDI v5 data class has at least one FHIR resource in §2.2. Every US Core / QICore profile in scope has a node type.

---

## 10. TL;DR

The healthcare app is **149 node types + 60 hyperedge types**, every clinical/administrative/financial node **FHIR-native** (US Core STU7 + QICore STU6 lineage), and **every legacy standard in real US operations** (HL7 v2.x with the full ADT/ORM/ORU/SIU/MDM/DFT/BAR/VXU/RAS/PPR/RDE/MFN/QBP/ACK message universe, C-CDA R2.1 with all 14 template documents, X12 5010 across 270/271/276/277/278/834/835/837 P/I/D, NCPDP SCRIPT + Telecom D.0 + Formulary & Benefit, NEMSIS 3.5, Direct Project, fax, paper) is a first-class ingest node with a deterministic **`*-to-fhir-map`** hyperedge — the raw artifact is retained, the parsed FHIR resources drive behaviors.

HIE participation is modeled: **TEFCA/QHIN, Carequality, CommonWell, eHealth Exchange, DirectTrust, UDAP** each own a node type; **IHE ITI actors** (XDS.b Repository/Registry, XCA/XCPD/PDQ/PIX) are bound to the realm via `ihe-actor-binding`. The live-observability spine — **FHIR Subscription topic-based (R5 backport), FHIRcast, MLLP listeners/clients, WebSocket channels, event-stream projections, SMART on FHIR launches, UDAP trust registration, cursor/attention sessions** — is the §2.9 primitives + §3.11 edges that make the realm a **live observable system**, not a static snapshot.

Spanning **42 healthcare domains + interop + live-streaming** across **25 existing packs + ~14 pack gaps + `packs/interop`** for full US coverage, backed by **~110 authoritative knowledge sources** across drug/terminology/guideline/payer/quality/public-health/**interop-and-trust-networks**/customer-supplied.

The **realm-first admin journey** with **41 screens** (no duplicates, 8 of them under step 5b: MLLP, Documents, X12 & NCPDP, EMS, HIE/Networks, Streams, Trust/Launch, Cursor/Attention) is what the `hh-admin-ui` implements. The missing wiring is small (`nodes.ts` + `edges.ts` + `fhir/mapper` + `fhir/bridge` + `terminology/store` + `hypergraph/queries/healthcare` + 14 domain packs + `src/interop/{v2,cda,x12,ncpdp,nemsis,direct,hie,streams,smart}/` + `packs/interop/`), not new architecture — the substrate primitives already exist in the repo, and the interop bridge is what turns the substrate into a live US healthcare system rather than a demo.

