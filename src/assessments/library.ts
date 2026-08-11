// Assessment instrument library.
//
// Each assessment defines items (with LOINC codes where possible), scoring,
// interpretation bands, and follow-up rules. Assessments are consumed by
// agents (e.g. depression-screening agent runs PHQ-9, if score >= 10 then
// trigger clinician follow-up sub-agent).

export interface AssessmentItem {
  readonly id: string;
  readonly loinc?: string;
  readonly prompt: string;
  readonly answerType: 'ordinal' | 'boolean' | 'numeric' | 'text';
  readonly scale?: readonly { readonly label: string; readonly score: number }[];
  readonly minValue?: number;
  readonly maxValue?: number;
}
export interface AssessmentBand {
  readonly label: string;
  readonly minScore: number;
  readonly maxScore: number;
  readonly interpretation: string;
  readonly triggersAgentId?: string;
}
export interface AssessmentSpec {
  readonly id: string;
  readonly loinc?: string;
  readonly title: string;
  readonly domain: 'mental-health' | 'cognition' | 'function' | 'nutrition' | 'fall-risk' | 'skin-integrity' | 'substance-use' | 'kidney-quality-of-life' | 'pain' | 'social-drivers' | 'delirium' | 'frailty';
  readonly items: readonly AssessmentItem[];
  readonly scoringMethod: 'sum' | 'weighted' | 'formula';
  readonly formula?: string; // JS expression over item ids
  readonly bands: readonly AssessmentBand[];
  readonly reference: { readonly citation: string; readonly url: string };
}

const phq9Scale = [
  { label: 'Not at all', score: 0 },
  { label: 'Several days', score: 1 },
  { label: 'More than half the days', score: 2 },
  { label: 'Nearly every day', score: 3 },
];
function def(s: AssessmentSpec): AssessmentSpec { return Object.freeze(s); }


export const PHQ9: AssessmentSpec = def({
  id: 'assessment:phq-9', loinc: '44249-1', title: 'PHQ-9 Depression', domain: 'mental-health', scoringMethod: 'sum',
  items: [
    { id: 'q1', loinc: '44250-9', prompt: 'Little interest or pleasure in doing things', answerType: 'ordinal' as const, scale: phq9Scale },
    { id: 'q2', loinc: '44255-8', prompt: 'Feeling down, depressed, or hopeless', answerType: 'ordinal' as const, scale: phq9Scale },
    { id: 'q3', loinc: '44259-0', prompt: 'Trouble falling/staying asleep, sleeping too much', answerType: 'ordinal' as const, scale: phq9Scale },
    { id: 'q4', loinc: '44254-1', prompt: 'Feeling tired or having little energy', answerType: 'ordinal' as const, scale: phq9Scale },
    { id: 'q5', loinc: '44251-7', prompt: 'Poor appetite or overeating', answerType: 'ordinal' as const, scale: phq9Scale },
    { id: 'q6', loinc: '44258-2', prompt: 'Feeling bad about yourself — or that you are a failure', answerType: 'ordinal' as const, scale: phq9Scale },
    { id: 'q7', loinc: '44252-5', prompt: 'Trouble concentrating on things', answerType: 'ordinal' as const, scale: phq9Scale },
    { id: 'q8', loinc: '44253-3', prompt: 'Moving or speaking so slowly, or the opposite — restless', answerType: 'ordinal' as const, scale: phq9Scale },
    { id: 'q9', loinc: '44260-8', prompt: 'Thoughts that you would be better off dead or of hurting yourself', answerType: 'ordinal' as const, scale: phq9Scale },
  ],
  bands: [
    { label: 'None-minimal', minScore: 0, maxScore: 4, interpretation: 'No or minimal depression' },
    { label: 'Mild', minScore: 5, maxScore: 9, interpretation: 'Mild depression; watchful waiting; repeat PHQ-9 at follow-up' },
    { label: 'Moderate', minScore: 10, maxScore: 14, interpretation: 'Moderate; treatment plan warranted (therapy and/or pharmacotherapy)', triggersAgentId: 'depression-follow-up' },
    { label: 'Moderately severe', minScore: 15, maxScore: 19, interpretation: 'Moderately severe; active treatment with pharmacotherapy and/or psychotherapy', triggersAgentId: 'depression-follow-up' },
    { label: 'Severe', minScore: 20, maxScore: 27, interpretation: 'Severe; immediate initiation of pharmacotherapy and consider expedited referral', triggersAgentId: 'depression-severe-escalation' },
  ],
  reference: { citation: 'Kroenke K, Spitzer RL, Williams JB. J Gen Intern Med 2001;16(9):606–613.', url: 'https://www.phqscreeners.com' },
});

const gad7Scale = phq9Scale;
export const GAD7: AssessmentSpec = def({
  id: 'assessment:gad-7', loinc: '69737-5', title: 'GAD-7 Anxiety', domain: 'mental-health', scoringMethod: 'sum',
  items: [
    { id: 'q1', prompt: 'Feeling nervous, anxious, or on edge', answerType: 'ordinal' as const, scale: gad7Scale },
    { id: 'q2', prompt: 'Not being able to stop or control worrying', answerType: 'ordinal' as const, scale: gad7Scale },
    { id: 'q3', prompt: 'Worrying too much about different things', answerType: 'ordinal' as const, scale: gad7Scale },
    { id: 'q4', prompt: 'Trouble relaxing', answerType: 'ordinal' as const, scale: gad7Scale },
    { id: 'q5', prompt: 'Being so restless that it is hard to sit still', answerType: 'ordinal' as const, scale: gad7Scale },
    { id: 'q6', prompt: 'Becoming easily annoyed or irritable', answerType: 'ordinal' as const, scale: gad7Scale },
    { id: 'q7', prompt: 'Feeling afraid, as if something awful might happen', answerType: 'ordinal' as const, scale: gad7Scale },
  ],
  bands: [
    { label: 'Minimal', minScore: 0, maxScore: 4, interpretation: 'Minimal anxiety' },
    { label: 'Mild', minScore: 5, maxScore: 9, interpretation: 'Mild anxiety' },
    { label: 'Moderate', minScore: 10, maxScore: 14, interpretation: 'Moderate anxiety; consider active treatment', triggersAgentId: 'anxiety-follow-up' },
    { label: 'Severe', minScore: 15, maxScore: 21, interpretation: 'Severe anxiety; active treatment warranted', triggersAgentId: 'anxiety-follow-up' },
  ],
  reference: { citation: 'Spitzer RL, Kroenke K, Williams JB. Arch Intern Med 2006;166:1092–1097.', url: 'https://www.phqscreeners.com' },
});

export const AUDIT_C: AssessmentSpec = def({
  id: 'assessment:audit-c', loinc: '72172-0', title: 'AUDIT-C Alcohol Use', domain: 'substance-use', scoringMethod: 'sum',
  items: [
    { id: 'q1', prompt: 'How often did you have a drink containing alcohol in the past year?', answerType: 'ordinal' as const, scale: [{label:'Never',score:0},{label:'Monthly or less',score:1},{label:'2-4 times/month',score:2},{label:'2-3 times/week',score:3},{label:'4+ times/week',score:4}] },
    { id: 'q2', prompt: 'How many drinks on a typical day when drinking?', answerType: 'ordinal' as const, scale: [{label:'1-2',score:0},{label:'3-4',score:1},{label:'5-6',score:2},{label:'7-9',score:3},{label:'10+',score:4}] },
    { id: 'q3', prompt: 'How often did you have 6+ drinks on one occasion in the past year?', answerType: 'ordinal' as const, scale: [{label:'Never',score:0},{label:'Less than monthly',score:1},{label:'Monthly',score:2},{label:'Weekly',score:3},{label:'Daily or almost daily',score:4}] },
  ],
  bands: [
    { label: 'Low-risk', minScore: 0, maxScore: 2, interpretation: 'Low risk (males) / low risk (females if <3)' },
    { label: 'At-risk', minScore: 3, maxScore: 12, interpretation: 'At risk; brief intervention indicated', triggersAgentId: 'sbirt-brief-intervention' },
  ],
  reference: { citation: 'Bush K, et al. Arch Intern Med 1998;158:1789–1795.', url: 'https://www.hepatitis.va.gov/alcohol/treatment/audit-c.asp' },
});

export const MOCA_SUMMARY: AssessmentSpec = def({
  id: 'assessment:moca', loinc: '72109-2', title: 'MoCA (Montreal Cognitive Assessment) summary', domain: 'cognition', scoringMethod: 'sum',
  items: [{ id: 'total', prompt: 'MoCA total score (0-30)', answerType: 'numeric' as const, minValue: 0, maxValue: 30 }],
  bands: [
    { label: 'Normal', minScore: 26, maxScore: 30, interpretation: 'Normal cognition' },
    { label: 'MCI', minScore: 18, maxScore: 25, interpretation: 'Possible mild cognitive impairment', triggersAgentId: 'cognitive-workup' },
    { label: 'Dementia range', minScore: 0, maxScore: 17, interpretation: 'Dementia range; specialist referral', triggersAgentId: 'dementia-workup' },
  ],
  reference: { citation: 'Nasreddine ZS, et al. J Am Geriatr Soc 2005;53:695–699.', url: 'https://mocatest.org' },
});

export const BRADEN: AssessmentSpec = def({
  id: 'assessment:braden', loinc: '38208-5', title: 'Braden Scale for Pressure Injury Risk', domain: 'skin-integrity', scoringMethod: 'sum',
  items: [
    { id: 'sensory', prompt: 'Sensory perception', answerType: 'ordinal' as const, scale: [{label:'Completely limited',score:1},{label:'Very limited',score:2},{label:'Slightly limited',score:3},{label:'No impairment',score:4}] },
    { id: 'moisture', prompt: 'Moisture', answerType: 'ordinal' as const, scale: [{label:'Constantly moist',score:1},{label:'Very moist',score:2},{label:'Occasionally moist',score:3},{label:'Rarely moist',score:4}] },
    { id: 'activity', prompt: 'Activity', answerType: 'ordinal' as const, scale: [{label:'Bedfast',score:1},{label:'Chairfast',score:2},{label:'Walks occasionally',score:3},{label:'Walks frequently',score:4}] },
    { id: 'mobility', prompt: 'Mobility', answerType: 'ordinal' as const, scale: [{label:'Completely immobile',score:1},{label:'Very limited',score:2},{label:'Slightly limited',score:3},{label:'No limitations',score:4}] },
    { id: 'nutrition', prompt: 'Nutrition', answerType: 'ordinal' as const, scale: [{label:'Very poor',score:1},{label:'Probably inadequate',score:2},{label:'Adequate',score:3},{label:'Excellent',score:4}] },
    { id: 'friction', prompt: 'Friction and shear', answerType: 'ordinal' as const, scale: [{label:'Problem',score:1},{label:'Potential problem',score:2},{label:'No apparent problem',score:3}] },
  ],
  bands: [
    { label: 'No risk', minScore: 19, maxScore: 23, interpretation: 'No pressure injury risk' },
    { label: 'Mild', minScore: 15, maxScore: 18, interpretation: 'Mild risk; standard prevention' },
    { label: 'Moderate', minScore: 13, maxScore: 14, interpretation: 'Moderate risk; turning schedule + pressure surface', triggersAgentId: 'pressure-injury-prevention' },
    { label: 'High', minScore: 10, maxScore: 12, interpretation: 'High risk; wound consult', triggersAgentId: 'pressure-injury-prevention' },
    { label: 'Very high', minScore: 6, maxScore: 9, interpretation: 'Very high risk; wound consult + specialty surface', triggersAgentId: 'pressure-injury-prevention' },
  ],
  reference: { citation: 'Bergstrom N, et al. Res Nurs Health 1998;21:361–369.', url: 'https://www.bradenscale.com' },
});

export const MORSE: AssessmentSpec = def({
  id: 'assessment:morse', loinc: '54556-4', title: 'Morse Fall Scale', domain: 'fall-risk', scoringMethod: 'sum',
  items: [
    { id: 'history', prompt: 'History of falling within 3 months', answerType: 'ordinal' as const, scale: [{label:'No',score:0},{label:'Yes',score:25}] },
    { id: 'secondary-dx', prompt: 'Secondary diagnosis', answerType: 'ordinal' as const, scale: [{label:'No',score:0},{label:'Yes',score:15}] },
    { id: 'ambulatory-aid', prompt: 'Ambulatory aid', answerType: 'ordinal' as const, scale: [{label:'None/bedrest/nurse assist',score:0},{label:'Crutches/cane/walker',score:15},{label:'Furniture',score:30}] },
    { id: 'iv', prompt: 'IV / Heparin lock', answerType: 'ordinal' as const, scale: [{label:'No',score:0},{label:'Yes',score:20}] },
    { id: 'gait', prompt: 'Gait', answerType: 'ordinal' as const, scale: [{label:'Normal/bedrest/wheelchair',score:0},{label:'Weak',score:10},{label:'Impaired',score:20}] },
    { id: 'mental-status', prompt: 'Mental status', answerType: 'ordinal' as const, scale: [{label:'Oriented to own ability',score:0},{label:'Overestimates/forgets limits',score:15}] },
  ],
  bands: [
    { label: 'No/low risk', minScore: 0, maxScore: 24, interpretation: 'No or low fall risk' },
    { label: 'Moderate', minScore: 25, maxScore: 44, interpretation: 'Moderate fall risk; implement standard fall prevention' },
    { label: 'High', minScore: 45, maxScore: 200, interpretation: 'High fall risk; implement high-risk fall prevention protocol', triggersAgentId: 'fall-prevention-bundle' },
  ],
  reference: { citation: 'Morse JM, et al. Can J Aging 1989;8:366–377.', url: 'https://www.ahrq.gov' },
});

export const KDQOL_36_SUMMARY: AssessmentSpec = def({
  id: 'assessment:kdqol-36', loinc: '96566-2', title: 'KDQOL-36 (Kidney Disease Quality of Life)', domain: 'kidney-quality-of-life', scoringMethod: 'weighted',
  items: [
    { id: 'phys-composite', prompt: 'Physical Composite Summary (SF-12)', answerType: 'numeric' as const, minValue: 0, maxValue: 100 },
    { id: 'mental-composite', prompt: 'Mental Composite Summary (SF-12)', answerType: 'numeric' as const, minValue: 0, maxValue: 100 },
    { id: 'burden', prompt: 'Burden of Kidney Disease', answerType: 'numeric' as const, minValue: 0, maxValue: 100 },
    { id: 'symptoms', prompt: 'Symptoms and Problems', answerType: 'numeric' as const, minValue: 0, maxValue: 100 },
    { id: 'effects', prompt: 'Effects of Kidney Disease', answerType: 'numeric' as const, minValue: 0, maxValue: 100 },
  ],
  bands: [
    { label: 'Report', minScore: 0, maxScore: 100, interpretation: 'Reported as-is; benchmarked to CROWNWeb national medians' },
  ],
  reference: { citation: 'Hays RD, et al. RAND KDQOL-36 Manual', url: 'https://www.rand.org/health-care/surveys_tools/kdqol.html' },
});

export const MNA_SF: AssessmentSpec = def({
  id: 'assessment:mna-sf', loinc: '80392-9', title: 'Mini Nutritional Assessment - Short Form', domain: 'nutrition', scoringMethod: 'sum',
  items: [{ id: 'total', prompt: 'MNA-SF total (0-14)', answerType: 'numeric' as const, minValue: 0, maxValue: 14 }],
  bands: [
    { label: 'Normal', minScore: 12, maxScore: 14, interpretation: 'Normal nutritional status' },
    { label: 'At-risk', minScore: 8, maxScore: 11, interpretation: 'At risk of malnutrition', triggersAgentId: 'nutrition-consult' },
    { label: 'Malnourished', minScore: 0, maxScore: 7, interpretation: 'Malnourished', triggersAgentId: 'nutrition-consult' },
  ],
  reference: { citation: 'Rubenstein LZ, et al. J Gerontol A 2001;56A:M366–M372.', url: 'https://www.mna-elderly.com' },
});

export const CAM_DELIRIUM: AssessmentSpec = def({
  id: 'assessment:cam', title: 'Confusion Assessment Method (CAM)', domain: 'delirium', scoringMethod: 'formula', formula: 'acute && inattention && (disorganized || alteredLoc) ? 1 : 0',
  items: [
    { id: 'acute', prompt: 'Acute onset or fluctuating course', answerType: 'boolean' as const },
    { id: 'inattention', prompt: 'Inattention', answerType: 'boolean' as const },
    { id: 'disorganized', prompt: 'Disorganized thinking', answerType: 'boolean' as const },
    { id: 'alteredLoc', prompt: 'Altered level of consciousness', answerType: 'boolean' as const },
  ],
  bands: [
    { label: 'Negative', minScore: 0, maxScore: 0, interpretation: 'CAM negative' },
    { label: 'Positive', minScore: 1, maxScore: 1, interpretation: 'CAM positive; delirium likely', triggersAgentId: 'delirium-workup' },
  ],
  reference: { citation: 'Inouye SK, et al. Ann Intern Med 1990;113:941–948.', url: 'https://www.hospitalelderlifeprogram.org' },
});

export const FRAIL_SCALE: AssessmentSpec = def({
  id: 'assessment:frail', title: 'FRAIL Scale', domain: 'frailty', scoringMethod: 'sum',
  items: [
    { id: 'fatigue', prompt: 'Fatigue', answerType: 'boolean' as const },
    { id: 'resistance', prompt: 'Difficulty climbing 1 flight of stairs', answerType: 'boolean' as const },
    { id: 'ambulation', prompt: 'Difficulty walking 1 block', answerType: 'boolean' as const },
    { id: 'illness', prompt: '>5 chronic illnesses', answerType: 'boolean' as const },
    { id: 'loss', prompt: 'Weight loss > 5% in past year', answerType: 'boolean' as const },
  ],
  bands: [
    { label: 'Robust', minScore: 0, maxScore: 0, interpretation: 'Robust' },
    { label: 'Prefrail', minScore: 1, maxScore: 2, interpretation: 'Pre-frail' },
    { label: 'Frail', minScore: 3, maxScore: 5, interpretation: 'Frail', triggersAgentId: 'frailty-care-plan' },
  ],
  reference: { citation: 'Morley JE, et al. J Nutr Health Aging 2012;16:601–608.', url: 'https://www.aging.wisc.edu' },
});

export const SDOH_5_DOMAIN: AssessmentSpec = def({
  id: 'assessment:sdoh-5-domain', title: 'CMS SDOH 5-Domain Screen', domain: 'social-drivers', scoringMethod: 'sum',
  items: [
    { id: 'food', prompt: 'Food insecurity (Hunger Vital Sign)', answerType: 'boolean' as const },
    { id: 'housing', prompt: 'Housing instability / homelessness', answerType: 'boolean' as const },
    { id: 'transportation', prompt: 'Lack of transportation to medical care', answerType: 'boolean' as const },
    { id: 'utilities', prompt: 'Utility difficulties in last 12 months', answerType: 'boolean' as const },
    { id: 'safety', prompt: 'Interpersonal safety concern', answerType: 'boolean' as const },
  ],
  bands: [
    { label: 'Negative', minScore: 0, maxScore: 0, interpretation: 'No SDOH needs identified' },
    { label: 'Positive', minScore: 1, maxScore: 5, interpretation: 'SDOH need identified in 1+ domain', triggersAgentId: 'sdoh-community-resource-referral' },
  ],
  reference: { citation: 'CMS Accountable Health Communities Screening Tool', url: 'https://www.cms.gov/priorities/innovation/files/worksheets/ahcm-screeningtool.pdf' },
});

export const ADL_KATZ: AssessmentSpec = def({
  id: 'assessment:katz-adl', loinc: '77584-8', title: 'Katz Index of Independence in ADLs', domain: 'function', scoringMethod: 'sum',
  items: ['bathing','dressing','toileting','transferring','continence','feeding'].map((k) => ({ id: k, prompt: k, answerType: 'ordinal' as const, scale: [{label:'Dependent',score:0},{label:'Independent',score:1}] })),
  bands: [
    { label: 'Full', minScore: 6, maxScore: 6, interpretation: 'Full function' },
    { label: 'Moderate impairment', minScore: 3, maxScore: 5, interpretation: 'Moderate impairment', triggersAgentId: 'home-safety-eval' },
    { label: 'Severe impairment', minScore: 0, maxScore: 2, interpretation: 'Severe impairment', triggersAgentId: 'home-safety-eval' },
  ],
  reference: { citation: 'Katz S, et al. JAMA 1963;185:914–919.', url: 'https://consultgeri.org' },
});

export const IADL_LAWTON: AssessmentSpec = def({
  id: 'assessment:lawton-iadl', loinc: '57249-9', title: 'Lawton Instrumental ADL', domain: 'function', scoringMethod: 'sum',
  items: ['telephone','shopping','food-prep','housekeeping','laundry','transport','meds','finances'].map((k) => ({ id: k, prompt: k, answerType: 'ordinal' as const, scale: [{label:'Dependent',score:0},{label:'Independent',score:1}] })),
  bands: [
    { label: 'Full', minScore: 7, maxScore: 8, interpretation: 'Full IADL independence' },
    { label: 'Moderate', minScore: 4, maxScore: 6, interpretation: 'Moderate impairment', triggersAgentId: 'home-safety-eval' },
    { label: 'Severe', minScore: 0, maxScore: 3, interpretation: 'Severe impairment', triggersAgentId: 'home-safety-eval' },
  ],
  reference: { citation: 'Lawton MP, Brody EM. Gerontologist 1969;9:179–186.', url: 'https://consultgeri.org' },
});

export const ALL_ASSESSMENTS: readonly AssessmentSpec[] = Object.freeze([
  PHQ9, GAD7, AUDIT_C, MOCA_SUMMARY, BRADEN, MORSE, KDQOL_36_SUMMARY, MNA_SF, CAM_DELIRIUM, FRAIL_SCALE, SDOH_5_DOMAIN, ADL_KATZ, IADL_LAWTON,
]);

export class AssessmentRegistry {
  private readonly map = new Map<string, AssessmentSpec>();
  constructor(seeds: readonly AssessmentSpec[] = ALL_ASSESSMENTS) {
    for (const a of seeds) this.map.set(a.id, a);
  }
  register(a: AssessmentSpec): void { this.map.set(a.id, a); }
  get(id: string): AssessmentSpec | undefined { return this.map.get(id); }
  list(): readonly AssessmentSpec[] { return [...this.map.values()]; }
  listByDomain(domain: AssessmentSpec['domain']): readonly AssessmentSpec[] { return this.list().filter((a) => a.domain === domain); }

  score(id: string, answers: Record<string, unknown>): { total: number; band: AssessmentBand } {
    const spec = this.get(id);
    if (!spec) throw new Error(`Unknown assessment ${id}`);
    let total = 0;
    if (spec.scoringMethod === 'sum') {
      for (const item of spec.items) {
        const raw = answers[item.id];
        if (item.answerType === 'boolean') total += raw ? 1 : 0;
        else if (item.answerType === 'numeric') total += typeof raw === 'number' ? raw : 0;
        else if (item.answerType === 'ordinal') total += typeof raw === 'number' ? raw : 0;
      }
    } else if (spec.scoringMethod === 'weighted') {
      let sum = 0, count = 0;
      for (const item of spec.items) {
        const raw = answers[item.id];
        if (typeof raw === 'number') { sum += raw; count++; }
      }
      total = count > 0 ? sum / count : 0;
    } else if (spec.scoringMethod === 'formula' && spec.formula) {
      const argNames = spec.items.map((i) => i.id);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(...argNames, `return (${spec.formula});`);
      const argValues = spec.items.map((i) => answers[i.id]);
      const r = fn(...argValues);
      total = r ? 1 : 0;
    }
    const band = spec.bands.find((b) => total >= b.minScore && total <= b.maxScore) ?? spec.bands[spec.bands.length - 1]!;
    return { total, band };
  }
}
