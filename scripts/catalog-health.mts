// Catalog health check: builds catalog.db from the current snapshots + SDKs
// into a temp dir, then audits coverage and data quality per dimension.
// Run: node --experimental-strip-types scripts/catalog-health.mts
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureCatalogDb } from '../src/main/db.ts';
import { loadOfficialSdkCatalog } from '../src/main/catalogLoader.ts';

const dir = mkdtempSync(join(tmpdir(), 'catalog-health-'));
const catalogDbPath = join(dir, 'catalog.db');
try {
  ensureCatalogDb(catalogDbPath);
  const loaded = loadOfficialSdkCatalog(catalogDbPath);
  const db = new Database(catalogDbPath, { readonly: true });

  console.log('=== 总量 ===');
  console.log(`products ${loaded.productCount}, actions ${loaded.actionCount}`);
  const fts = (db.prepare('SELECT COUNT(*) AS n FROM catalog_fts').get() as { n: number }).n;
  const aliases = (db.prepare('SELECT COUNT(*) AS n FROM catalog_aliases').get() as { n: number }).n;
  const overlay = (db.prepare('SELECT COUNT(*) AS n FROM catalog_overlay').get() as { n: number }).n;
  console.log(`fts rows ${fts} (${fts === loaded.actionCount ? 'ok' : 'MISMATCH'}), aliases ${aliases}, overlay ${overlay}`);

  console.log('\n=== 快照新鲜度 ===');
  const metaDir = join(process.cwd(), 'catalog-meta');
  const ages = new Map<string, number>();
  for (const file of readdirSync(metaDir).filter((f) => f.endsWith('.json'))) {
    try {
      const snap = JSON.parse(readFileSync(join(metaDir, file), 'utf8')) as { snapshotVersion?: number; fetchedAt?: string };
      const days = snap.fetchedAt ? Math.round((Date.now() - Date.parse(snap.fetchedAt)) / 86_400_000) : -1;
      ages.set(`${file} v${snap.snapshotVersion ?? '?'}`, days);
    } catch { ages.set(file, -1); }
  }
  const v1 = [...ages.keys()].filter((k) => !k.endsWith('v2'));
  const maxAge = Math.max(...ages.values());
  console.log(`snapshots ${ages.size}, non-v2 ${v1.length}${v1.length ? ` (${v1.join(', ')})` : ''}, oldest ${maxAge} days`);

  console.log('\n=== params_blob 来源分布 ===');
  const rows = db.prepare('SELECT product, action, danger, required_json AS req, summary_cn AS summary, params_blob AS blob FROM catalog_actions').all() as Array<{ product: string; action: string; danger: string; req: string; summary: string; blob: string }>;
  const bySource = new Map<string, number>();
  let emptyParams = 0, withDescription = 0, withEnum = 0, withRaw = 0, ossWithRaw = 0, ossTotal = 0;
  let placeholderSummary = 0, emptyRequired = 0;
  const dangerDist = new Map<string, number>();
  for (const row of rows) {
    dangerDist.set(row.danger, (dangerDist.get(row.danger) ?? 0) + 1);
    if (JSON.parse(row.req).length === 0) emptyRequired++;
    if (row.summary === `${row.product} ${row.action}` || row.summary.toLowerCase() === row.action.toLowerCase()) placeholderSummary++;
    let blob: { source?: string; params?: Array<Record<string, unknown>>; raw?: unknown };
    try { blob = JSON.parse(row.blob); } catch { blob = {}; }
    const source = blob.source ?? 'sdk-dts';
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
    const params = Array.isArray(blob.params) ? blob.params : [];
    if (!params.length) emptyParams++;
    if (params.some((p) => typeof p.description === 'string')) withDescription++;
    if (params.some((p) => Array.isArray(p.enum))) withEnum++;
    if (blob.raw) withRaw++;
    if (row.product === 'oss') { ossTotal++; if (blob.raw) ossWithRaw++; }
  }
  for (const [source, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${source}: ${n} (${(n * 100 / rows.length).toFixed(1)}%)`);
  }

  console.log('\n=== 参数语义覆盖 ===');
  console.log(`有参数明细 ${rows.length - emptyParams}/${rows.length} (${((rows.length - emptyParams) * 100 / rows.length).toFixed(1)}%)`);
  console.log(`带 description ${withDescription} (${(withDescription * 100 / rows.length).toFixed(1)}%), 带 enum ${withEnum} (${(withEnum * 100 / rows.length).toFixed(1)}%)`);
  console.log(`OSS raw spec ${ossWithRaw}/${ossTotal}`);

  console.log('\n=== 质量信号 ===');
  console.log(`占位 summary(无语义) ${placeholderSummary} (${(placeholderSummary * 100 / rows.length).toFixed(1)}%)`);
  console.log(`required 为空 ${emptyRequired} (${(emptyRequired * 100 / rows.length).toFixed(1)}%) — 含确实无必填参数的 action,仅供趋势观察`);
  console.log(`danger: ${[...dangerDist.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const deprecated = (db.prepare('SELECT COUNT(*) AS n FROM catalog_overlay WHERE deprecated=1').get() as { n: number }).n;
  console.log(`deprecated ${deprecated}`);

  console.log('\n=== 各产品明细(action 数 / 占位 summary / 无参数明细) ===');
  const perProduct = new Map<string, { total: number; placeholder: number; noParams: number }>();
  for (const row of rows) {
    const entry = perProduct.get(row.product) ?? { total: 0, placeholder: 0, noParams: 0 };
    entry.total++;
    if (row.summary === `${row.product} ${row.action}` || row.summary.toLowerCase() === row.action.toLowerCase()) entry.placeholder++;
    let blob: { params?: unknown[] };
    try { blob = JSON.parse(row.blob); } catch { blob = {}; }
    if (!Array.isArray(blob.params) || !blob.params.length) entry.noParams++;
    perProduct.set(row.product, entry);
  }
  for (const [product, entry] of [...perProduct.entries()].sort()) {
    const flags = [];
    if (entry.placeholder / entry.total > 0.1) flags.push('SUMMARY!');
    if (entry.noParams / entry.total > 0.2) flags.push('PARAMS!');
    console.log(`${product.padEnd(18)} ${String(entry.total).padStart(4)}  placeholder ${String(entry.placeholder).padStart(3)}  noParams ${String(entry.noParams).padStart(3)}  ${flags.join(' ')}`);
  }
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
