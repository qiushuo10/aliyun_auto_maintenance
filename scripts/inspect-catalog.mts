// One-off inspection: build catalog.db into a temp dir and spot-check the
// rows that the v2 snapshot pipeline is supposed to fix.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureCatalogDb } from '../src/main/db.ts';
import { loadOfficialSdkCatalog } from '../src/main/catalogLoader.ts';

const dir = mkdtempSync(join(tmpdir(), 'catalog-inspect-'));
const catalogDbPath = join(dir, 'catalog.db');
try {
  ensureCatalogDb(catalogDbPath);
  const result = loadOfficialSdkCatalog(catalogDbPath);
  console.log('loaded:', JSON.stringify(result));

  const db = new Database(catalogDbPath, { readonly: true });
  const endpoint = db.prepare("SELECT endpoint_tpl FROM catalog_products WHERE product='oss'").get();
  console.log('oss endpoint_tpl:', JSON.stringify(endpoint));

  for (const action of ['ListObjects', 'GetBucketAcl', 'ListCname']) {
    const row = db.prepare("SELECT method, required_json, summary_cn, params_blob FROM catalog_actions WHERE product='oss' AND action=?").get(action) as Record<string, string> | undefined;
    if (!row) { console.log(action, 'MISSING'); continue; }
    const blob = JSON.parse(row.params_blob);
    console.log(`${action}: method=${row.method} required=${row.required_json} summary="${row.summary_cn.slice(0, 60)}" raw=${JSON.stringify(blob.raw ?? null)} params=${(blob.params ?? []).length} firstParam=${JSON.stringify((blob.params ?? [])[0] ?? null)}`);
  }

  const ftsHits = db.prepare("SELECT COUNT(*) AS n FROM catalog_fts WHERE catalog_fts MATCH '公共访问' AND product='oss'").get() as { n: number };
  console.log('FTS 公共访问 oss hits:', ftsHits.n);

  const ecs = db.prepare("SELECT params_blob FROM catalog_actions WHERE product='ecs' AND action='CreateInstance'").get() as { params_blob: string };
  const ecsBlob = JSON.parse(ecs.params_blob);
  const httpTokens = (ecsBlob.params ?? []).find((p: { name: string }) => p.name === 'HttpTokens');
  const chargeType = (ecsBlob.params ?? []).find((p: { name: string }) => p.name === 'InstanceChargeType');
  console.log('ecs CreateInstance source:', ecsBlob.source, 'HttpTokens:', JSON.stringify(httpTokens), 'InstanceChargeType.enum:', JSON.stringify(chargeType?.enum));

  const dryRun = db.prepare("SELECT required_json FROM catalog_actions WHERE product='ecs' AND action='DescribeImages'").get() as { required_json: string };
  console.log('ecs DescribeImages required:', dryRun.required_json);
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
