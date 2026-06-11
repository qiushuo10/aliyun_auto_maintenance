// Measures the progressive-disclosure payload sizes after the v2 catalog:
// layer 1 discover_api rows, layer 2 get_api_params output (replicating
// summarizeParamsMetadata), and the internal params_blob kept for the gateway.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureCatalogDb } from '../src/main/db.ts';
import { loadOfficialSdkCatalog } from '../src/main/catalogLoader.ts';

const dir = mkdtempSync(join(tmpdir(), 'catalog-measure-'));
const catalogDbPath = join(dir, 'catalog.db');
try {
  ensureCatalogDb(catalogDbPath);
  loadOfficialSdkCatalog(catalogDbPath);
  const db = new Database(catalogDbPath, { readonly: true });

  const summarize = (blobJson: string, requiredJson: string) => {
    const blob = JSON.parse(blobJson) as { requestClass?: string; params?: Array<Record<string, unknown>> };
    const required = JSON.parse(requiredJson) as string[];
    const params = Array.isArray(blob.params) ? blob.params : [];
    const pick = (p: Record<string, unknown>, req: boolean) => {
      const d: Record<string, unknown> = { name: p.name, type: p.type, required: req };
      for (const k of ['in', 'description', 'enum', 'example']) if (p[k] !== undefined && p[k] !== null) d[k] = p[k];
      return d;
    };
    return JSON.stringify({
      requestClass: blob.requestClass,
      required,
      requiredDetails: params.filter((p) => required.includes(String(p.name))).map((p) => pick(p, true)),
      optionalExamples: params.filter((p) => !required.includes(String(p.name))).slice(0, 24).map((p) => pick(p, false))
    });
  };

  const samples: Array<[string, string]> = [
    ['ecs', 'CreateInstance'], ['ecs', 'RunInstances'], ['ecs', 'DescribeInstances'],
    ['rds', 'CreateDBInstance'], ['vpc', 'CreateVpc'], ['oss', 'ListObjects'], ['oss', 'PutBucket']
  ];
  console.log('action                          get_api_params  params_blob  (chars, tokens~chars/4)');
  for (const [product, action] of samples) {
    const row = db.prepare('SELECT params_blob AS blob, required_json AS req FROM catalog_actions WHERE product=? AND action=?').get(product, action) as { blob: string; req: string } | undefined;
    if (!row) { console.log(`${product}/${action} MISSING`); continue; }
    const out = summarize(row.blob, row.req);
    console.log(`${(product + '/' + action).padEnd(32)}${String(out.length).padStart(6)} (~${Math.round(out.length / 4)}t)  ${String(row.blob.length).padStart(7)} (~${Math.round(row.blob.length / 4)}t)`);
  }

  const all = db.prepare('SELECT product, action, params_blob AS blob, required_json AS req FROM catalog_actions').all() as Array<{ product: string; action: string; blob: string; req: string }>;
  let worst = { key: '', len: 0 };
  let total = 0;
  const buckets = [0, 0, 0, 0]; // <2k, 2-6k, 6-12k, >12k chars
  for (const row of all) {
    const len = summarize(row.blob, row.req).length;
    total += len;
    if (len > worst.len) worst = { key: `${row.product}/${row.action}`, len };
    buckets[len < 2000 ? 0 : len < 6000 ? 1 : len < 12000 ? 2 : 3]++;
  }
  console.log(`\nall ${all.length} actions: avg ${Math.round(total / all.length)} chars (~${Math.round(total / all.length / 4)}t)`);
  console.log(`distribution: <2k ${buckets[0]}, 2-6k ${buckets[1]}, 6-12k ${buckets[2]}, >12k ${buckets[3]}`);
  console.log(`worst: ${worst.key} ${worst.len} chars (~${Math.round(worst.len / 4)}t)`);

  const disc = db.prepare("SELECT product, action, version, danger, summary_cn, required_json FROM catalog_actions ORDER BY LENGTH(summary_cn) DESC LIMIT 5").all();
  const discLen = JSON.stringify(disc).length / 5;
  console.log(`\ndiscover_api: ~${Math.round(discLen)} chars/row (~${Math.round(discLen / 4)}t), default limit 5 -> ~${Math.round(discLen * 5 / 4)}t`);
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
