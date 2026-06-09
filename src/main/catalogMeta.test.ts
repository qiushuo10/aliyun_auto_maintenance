import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureCatalogDb } from './db';
import { loadOfficialSdkCatalog } from './catalogLoader';

describe('OSS catalog metadata', () => {
  it('contains PublicAccessBlock actions used by snapshot-only catalog injection', () => {
    const meta = JSON.parse(readFileSync(join(process.cwd(), 'catalog-meta/oss.json'), 'utf8')) as {
      actions: Record<string, { summary?: string }>;
    };

    expect(Object.keys(meta.actions)).toEqual(
      expect.arrayContaining([
        'GetPublicAccessBlock',
        'PutPublicAccessBlock',
        'DeletePublicAccessBlock',
        'GetBucketPublicAccessBlock',
        'PutBucketPublicAccessBlock',
        'DeleteBucketPublicAccessBlock'
      ])
    );
  });

  const sqliteIt = canOpenBetterSqlite() ? it : it.skip;

  sqliteIt('loads OSS snapshot-only and ossutil-only actions into catalog.db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aliy-agent-catalog-'));
    const catalogDbPath = join(dir, 'catalog.db');
    try {
      ensureCatalogDb(catalogDbPath);
      loadOfficialSdkCatalog(catalogDbPath);

      const db = new Database(catalogDbPath, { readonly: true, fileMustExist: true });
      try {
        const actions = db
          .prepare(
            `SELECT action FROM catalog_actions
             WHERE product = 'oss'
               AND action IN ('DoMetaQuery', 'CreateAccessPoint', 'ListCloudBoxes', 'DeleteMultipleObjects')
             ORDER BY action`
          )
          .all() as Array<{ action: string }>;

        expect(actions.map((row) => row.action)).toEqual([
          'CreateAccessPoint',
          'DeleteMultipleObjects',
          'DoMetaQuery',
          'ListCloudBoxes'
        ]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  sqliteIt('loads CAS certificate deployment keywords into catalog.db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aliy-agent-catalog-'));
    const catalogDbPath = join(dir, 'catalog.db');
    try {
      ensureCatalogDb(catalogDbPath);
      loadOfficialSdkCatalog(catalogDbPath);

      const db = new Database(catalogDbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db
          .prepare(
            `SELECT action, summary_cn AS summaryCn
             FROM catalog_actions
             WHERE product = 'cas'
               AND action IN ('CreateDeploymentJob', 'ListCloudResources', 'ListContact')
             ORDER BY action`
          )
          .all() as Array<{ action: string; summaryCn: string }>;

        expect(rows).toEqual([
          expect.objectContaining({ action: 'CreateDeploymentJob', summaryCn: expect.stringContaining('ResourceIds ContactIds') }),
          expect.objectContaining({ action: 'ListCloudResources', summaryCn: expect.stringContaining('OSS bucket') }),
          expect.objectContaining({ action: 'ListContact', summaryCn: expect.stringContaining('ContactIds') })
        ]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function canOpenBetterSqlite(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}
