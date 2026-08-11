// Device-jurisdiction signal gateway. Waveforms + telemetry from FDA-cleared
// devices (dialysis machines, infusion pumps, vitals monitors) live in a
// medical-device jurisdiction that the harness does not enter. The gateway
// receives *summarized, encounter-anchored observations* — not raw waveforms
// — from those devices' own connectivity layers, and normalizes them to
// canonical vital.observed / device.observation events.
//
// This is a boundary contract, not an implementation of a device driver: it
// specifies the observation shape + required provenance the harness will
// accept, and rejects anything below it.

import type { CanonicalEvent } from './events.js';

export interface DeviceObservation {
  readonly deviceRef: string;
  readonly deviceFdaProductCode?: string;
  readonly encounterRef: string;
  readonly patientRef: string;
  readonly observedAt: string;
  readonly observations: readonly {
    readonly loincCode: string;
    readonly value: number;
    readonly unit: string;
    readonly aggregationWindow: 'instantaneous' | '1min' | '5min' | '15min' | '1hour';
  }[];
  readonly gatewayProvenance: {
    readonly gatewayId: string;
    readonly gatewayVersion: string;
    readonly signedAt: string;
  };
}

export interface DeviceGatewayOptions {
  scopeId: string;
  facilityId: string;
  ingestedAt: string;
}

export function deviceObservationToEvents(obs: DeviceObservation, opts: DeviceGatewayOptions): CanonicalEvent[] {
  return obs.observations.map<CanonicalEvent>((o) => ({
    id: `event:device:${obs.deviceRef}:${obs.encounterRef}:${o.loincCode}:${obs.observedAt}`,
    type: 'device.observation',
    occurredAt: obs.observedAt,
    scopeId: opts.scopeId,
    subjectId: obs.patientRef,
    facilityId: opts.facilityId,
    payload: {
      encounterRef: obs.encounterRef,
      loincCode: o.loincCode,
      value: o.value,
      unit: o.unit,
      aggregationWindow: o.aggregationWindow,
      deviceRef: obs.deviceRef,
      ...(obs.deviceFdaProductCode ? { deviceFdaProductCode: obs.deviceFdaProductCode } : {}),
    },
    provenance: {
      sourceId: `device-gateway:${obs.gatewayProvenance.gatewayId}@${obs.gatewayProvenance.gatewayVersion}`,
      observedAt: obs.observedAt,
      ingestedAt: opts.ingestedAt,
    },
    classification: 'phi',
  }));
}

/** Validate that an observation carries required provenance + aggregation. */
export function validateDeviceObservation(obs: DeviceObservation): { valid: boolean; violations: readonly string[] } {
  const violations: string[] = [];
  if (!obs.gatewayProvenance.gatewayId) violations.push('missing-gateway-id');
  if (!obs.gatewayProvenance.signedAt) violations.push('missing-signed-at');
  if (obs.observations.length === 0) violations.push('empty-observations');
  for (const o of obs.observations) {
    if (o.aggregationWindow === 'instantaneous' && !obs.deviceFdaProductCode) violations.push('raw-waveform-without-device-clearance');
  }
  return { valid: violations.length === 0, violations };
}
