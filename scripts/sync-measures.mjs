#!/usr/bin/env node
import { syncMeasures } from '../dist/src/measures/source-registry.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const root = args.get('store') ?? '/home/user/workspace/.harness/measures';
const filter = args.get('filter'); // e.g. 'CMS165'
const token = process.env.GITHUB_TOKEN;

const results = await syncMeasures({
  layout: { root },
  ...(token ? { token } : {}),
  ...(filter ? { filter } : {}),
});
console.log(JSON.stringify(results, null, 2));
