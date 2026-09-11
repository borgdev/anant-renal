export function clientValidate(yamlText) {
  let doc;
  try { doc = window.jsyaml ? jsyaml.load(yamlText) : parseSimpleYaml(yamlText); }
  catch (e) { return { ok: false, errors: ['YAML parse: ' + e.message] }; }
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['Document is not a YAML object'] };
  const errs = [];
  const req = (path, val, cond, msg) => { if (!cond) errs.push(`${path}: ${msg}`); };
  req('id', doc.id, typeof doc.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(doc.id), 'must be kebab-case string');
  req('version', doc.version, /^\d+\.\d+\.\d+$/.test(doc.version || ''), 'must be semver X.Y.Z');
  req('packId', doc.packId, typeof doc.packId === 'string', 'required string');
  req('displayName', doc.displayName, typeof doc.displayName === 'string' && doc.displayName.length > 0, 'required non-empty string');
  req('scope', doc.scope, ['org','region','facility','patient'].includes(doc.scope), 'must be one of org|region|facility|patient');
  req('trigger.kind', doc.trigger?.kind, ['event','cron','webhook','manual'].includes(doc.trigger?.kind), 'must be event|cron|webhook|manual');
  if (doc.trigger?.kind === 'event') req('trigger.eventType', doc.trigger?.eventType, !!doc.trigger?.eventType, 'required for event triggers');
  if (doc.trigger?.kind === 'cron') req('trigger.expression', doc.trigger?.expression, !!doc.trigger?.expression, 'required for cron triggers');
  req('plan', doc.plan, doc.plan && typeof doc.plan === 'object', 'required');
  if (doc.plan) req('plan.type', doc.plan.type, ['sequence','parallel','conditional','loop','step'].includes(doc.plan.type), 'invalid plan type');
  req('governance.phiHandling', doc.governance?.phiHandling, ['none','read','read-write'].includes(doc.governance?.phiHandling), 'required: none|read|read-write');
  req('governance.purposeOfUse', doc.governance?.purposeOfUse, Array.isArray(doc.governance?.purposeOfUse) && doc.governance.purposeOfUse.length > 0, 'required non-empty array');
  req('governance.clearanceRequired', doc.governance?.clearanceRequired, ['public','internal','confidential','phi','restricted-phi'].includes(doc.governance?.clearanceRequired), 'required clearance level');
  return { ok: errs.length === 0, errors: errs, spec: errs.length === 0 ? doc : undefined };
}

export function parseSimpleYaml(t) { throw new Error('YAML parser unavailable'); }
