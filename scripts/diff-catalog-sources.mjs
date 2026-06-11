#!/usr/bin/env node

/*
Shadow-compares the catalog-meta snapshots in the working tree against the
committed versions (git HEAD). Use it before adopting regenerated snapshots:

  node scripts/diff-catalog-sources.mjs            # summary per product
  node scripts/diff-catalog-sources.mjs --verbose  # list every required diff
  node scripts/diff-catalog-sources.mjs ecs oss    # restrict to products

Reported per product:
  - actions added / removed
  - actions whose required-parameter set changed (old -> new)
  - v2 coverage: how many actions now carry parameters / method / path
*/

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const productFilter = new Set(args.filter((arg) => !arg.startsWith('--')));

const CATALOG_META_DIR = join(process.cwd(), 'catalog-meta');
const files = readdirSync(CATALOG_META_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort();

let totalRequiredChanges = 0;
let totalAdded = 0;
let totalRemoved = 0;

for (const file of files) {
  const product = file.replace(/\.json$/, '');
  if (productFilter.size && !productFilter.has(product)) continue;

  const next = readJson(join(CATALOG_META_DIR, file));
  const prev = readGitJson(`catalog-meta/${file}`);
  if (!next?.actions) {
    console.log(`?? ${product}: working-tree snapshot unreadable`);
    continue;
  }
  if (!prev?.actions) {
    console.log(`++ ${product}: new product (${Object.keys(next.actions).length} actions, no committed baseline)`);
    continue;
  }

  const prevActions = new Set(Object.keys(prev.actions));
  const nextActions = new Set(Object.keys(next.actions));
  const added = [...nextActions].filter((action) => !prevActions.has(action));
  const removed = [...prevActions].filter((action) => !nextActions.has(action));

  const requiredChanges = [];
  for (const action of nextActions) {
    if (!prevActions.has(action)) continue;
    const oldRequired = normalizeRequired(prev.actions[action]?.required);
    const newRequired = normalizeRequired(next.actions[action]?.required);
    if (oldRequired.join('|') !== newRequired.join('|')) {
      requiredChanges.push({ action, oldRequired, newRequired });
    }
  }

  const withParameters = Object.values(next.actions).filter((entry) => Array.isArray(entry?.parameters) && entry.parameters.length).length;
  const withMethod = Object.values(next.actions).filter((entry) => typeof entry?.method === 'string').length;
  const withPath = Object.values(next.actions).filter((entry) => typeof entry?.path === 'string').length;

  totalRequiredChanges += requiredChanges.length;
  totalAdded += added.length;
  totalRemoved += removed.length;

  const flag = requiredChanges.length || added.length || removed.length ? '!!' : 'ok';
  console.log(
    `${flag} ${product}: ${nextActions.size} actions ` +
      `(+${added.length}/-${removed.length}, required-diff ${requiredChanges.length}) ` +
      `v2-coverage params ${withParameters}/${nextActions.size}, method ${withMethod}, path ${withPath}`
  );

  if (verbose) {
    for (const action of added) console.log(`   + ${action}`);
    for (const action of removed) console.log(`   - ${action}`);
    for (const change of requiredChanges) {
      console.log(`   ~ ${change.action}: [${change.oldRequired.join(', ')}] -> [${change.newRequired.join(', ')}]`);
    }
  } else {
    for (const change of requiredChanges.slice(0, 5)) {
      console.log(`   ~ ${change.action}: [${change.oldRequired.join(', ')}] -> [${change.newRequired.join(', ')}]`);
    }
    if (requiredChanges.length > 5) console.log(`   ~ ... ${requiredChanges.length - 5} more (use --verbose)`);
  }
}

console.log('');
console.log(`TOTAL: required-diff ${totalRequiredChanges}, actions +${totalAdded}/-${totalRemoved}`);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readGitJson(repoPath) {
  try {
    const raw = execFileSync('git', ['show', `HEAD:${repoPath}`], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeRequired(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string').sort();
}
