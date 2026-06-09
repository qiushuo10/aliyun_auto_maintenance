import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DatabaseBundle {
  appDb: Database.Database;
  appDbPath: string;
  catalogDbPath: string;
}

export function openDatabases(userDataPath: string): DatabaseBundle {
  const dataDir = join(userDataPath, 'data');
  mkdirSync(dataDir, { recursive: true });

  const appDbPath = join(dataDir, 'app.db');
  const catalogDbPath = join(dataDir, 'catalog.db');
  mkdirSync(dirname(appDbPath), { recursive: true });

  const appDb = new Database(appDbPath);
  appDb.pragma('journal_mode = WAL');
  appDb.pragma('foreign_keys = ON');
  migrateAppDb(appDb);

  return { appDb, appDbPath, catalogDbPath };
}

export function ensureCatalogDb(catalogDbPath: string): void {
  mkdirSync(dirname(catalogDbPath), { recursive: true });
  const catalogDb = new Database(catalogDbPath);
  try {
    catalogDb.pragma('journal_mode = WAL');
    catalogDb.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_products (
        product TEXT PRIMARY KEY,
        endpoint_mode TEXT NOT NULL,
        endpoint_tpl TEXT NOT NULL,
        endpoint_map TEXT,
        default_version TEXT,
        source TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_actions (
        product TEXT NOT NULL,
        action TEXT NOT NULL,
        version TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'POST',
        style TEXT NOT NULL DEFAULT 'RPC',
        required_json TEXT NOT NULL,
        danger TEXT NOT NULL,
        summary_cn TEXT,
        params_blob TEXT,
        source TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (product, action, version)
      );

      CREATE TABLE IF NOT EXISTS catalog_overlay (
        product TEXT NOT NULL,
        action TEXT NOT NULL,
        deprecated INTEGER NOT NULL DEFAULT 0,
        replaced_by TEXT,
        keywords TEXT,
        note TEXT,
        danger_source_url TEXT,
        maintainer TEXT,
        test_case_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (product, action)
      );

      CREATE TABLE IF NOT EXISTS catalog_aliases (
        alias TEXT PRIMARY KEY,
        product TEXT NOT NULL,
        kind TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
        doc_id UNINDEXED,
        product,
        action,
        summary_cn,
        keywords,
        tokenize='unicode61'
      );
    `);

    const insertMeta = catalogDb.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');
    insertMeta.run('schema_version', '1');
    insertMeta.run('spec_snapshot_date', '');
  } finally {
    catalogDb.close();
  }
}

function migrateAppDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ak_id_encrypted TEXT,
      ak_secret_encrypted TEXT,
      ak_id_masked TEXT,
      rdc_id TEXT,
      default_region TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      active_profile_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      title TEXT NOT NULL,
      trust_mode TEXT NOT NULL DEFAULT 'strict',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      run_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_steps (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      danger TEXT NOT NULL,
      summary TEXT NOT NULL,
      params_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      run_state_json TEXT NOT NULL,
      context_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS session_context_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_hash TEXT,
      resolved_endpoint TEXT,
      request_params_json TEXT,
      provenance_json TEXT,
      status TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      http_status INTEGER,
      request_id TEXT,
      ak_id_masked TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_fact_pointers (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      product TEXT NOT NULL,
      action TEXT NOT NULL,
      version TEXT NOT NULL,
      danger TEXT NOT NULL,
      required_json TEXT NOT NULL,
      replaced_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(session_id, run_id, product, action, version)
    );

    CREATE TABLE IF NOT EXISTS tool_invocations (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      task_id TEXT,
      tool_name TEXT NOT NULL,
      product TEXT,
      action TEXT,
      version TEXT,
      danger TEXT,
      resolved_endpoint TEXT,
      request_params_json TEXT,
      provenance_json TEXT,
      status TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      http_status INTEGER,
      request_id TEXT,
      ak_id_masked TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      profile_id TEXT,
      workspace_id TEXT,
      session_id TEXT,
      task_id TEXT,
      ref_table TEXT,
      ref_id TEXT,
      payload_json TEXT NOT NULL,
      hash_prev TEXT,
      hash_self TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_index (
      workspace_id TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      content_hash TEXT,
      PRIMARY KEY (workspace_id, path)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS workspace_fts USING fts5(
      workspace_id UNINDEXED,
      path UNINDEXED,
      title,
      content,
      tokenize='unicode61'
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      keywords TEXT,
      source_path TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
      doc_id UNINDEXED,
      title,
      description,
      keywords,
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
      INSERT INTO skills_fts(doc_id, title, description, keywords)
      VALUES (new.id, new.title, new.description, new.keywords);
    END;

    CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
      DELETE FROM skills_fts WHERE doc_id = old.id;
      INSERT INTO skills_fts(doc_id, title, description, keywords)
      VALUES (new.id, new.title, new.description, new.keywords);
    END;

    CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
      DELETE FROM skills_fts WHERE doc_id = old.id;
    END;

    CREATE TABLE IF NOT EXISTS session_skills (
      session_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      selected_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, skill_id)
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      trust_mode TEXT NOT NULL,
      danger TEXT NOT NULL,
      script_body TEXT NOT NULL,
      status TEXT NOT NULL,
      first_sign_status TEXT NOT NULL DEFAULT 'not_required',
      script_hash TEXT NOT NULL,
      approval_scope_json TEXT,
      approval_expires_at INTEGER,
      max_runtime_ms INTEGER NOT NULL DEFAULT 300000,
      max_retries INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      log_json TEXT NOT NULL,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_candidates (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      source_message_at INTEGER NOT NULL,
      fact_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      UNIQUE(workspace_id, profile_id, fact_hash)
    );

    CREATE TABLE IF NOT EXISTS llm_settings (
      id TEXT PRIMARY KEY CHECK (id = 'default'),
      provider TEXT,
      model TEXT,
      base_url TEXT,
      api_key_encrypted TEXT,
      api_key_masked TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_refresh_state (
      id TEXT PRIMARY KEY CHECK (id = 'default'),
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      product_count INTEGER NOT NULL DEFAULT 0,
      action_count INTEGER NOT NULL DEFAULT 0,
      refreshed_at INTEGER NOT NULL
    );
  `);

  ensureColumn(db, 'skills', 'source_path', 'TEXT');
  ensureColumn(db, 'profiles', 'ak_id_encrypted', 'TEXT');
  ensureColumn(db, 'profiles', 'ak_secret_encrypted', 'TEXT');
  ensureCatalogFactPointersRunScoped(db);
  refreshSessionActivityTimestamps(db);
  db.prepare(
    `UPDATE run_steps
     SET status = 'skipped',
         title = '历史占位：OpenAI Agents SDK runtime 未接入',
         updated_at = ?
     WHERE status = 'pending'
       AND title IN ('等待接入 OpenAI Agents SDK runtime', 'OpenAI Agents SDK runtime is not connected yet')`
  ).run(Date.now());
}

function refreshSessionActivityTimestamps(db: Database.Database): void {
  db.exec(`
    UPDATE sessions
    SET updated_at = max(
      updated_at,
      COALESCE((SELECT MAX(created_at) FROM messages WHERE messages.session_id = sessions.id), updated_at),
      COALESCE((SELECT MAX(updated_at) FROM run_steps WHERE run_steps.session_id = sessions.id), updated_at)
    )
  `);
}

function ensureCatalogFactPointersRunScoped(db: Database.Database): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'catalog_fact_pointers'")
    .get() as { sql: string } | undefined;
  if (!table?.sql.includes('UNIQUE(session_id, product, action, version)')) return;

  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS catalog_fact_pointers_new;
      CREATE TABLE catalog_fact_pointers_new (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        product TEXT NOT NULL,
        action TEXT NOT NULL,
        version TEXT NOT NULL,
        danger TEXT NOT NULL,
        required_json TEXT NOT NULL,
        replaced_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(session_id, run_id, product, action, version)
      );

      INSERT INTO catalog_fact_pointers_new
        (id, session_id, run_id, product, action, version, danger, required_json, replaced_by, created_at, updated_at)
      SELECT id, session_id, run_id, product, action, version, danger, required_json, replaced_by, created_at, updated_at
      FROM catalog_fact_pointers;

      DROP TABLE catalog_fact_pointers;
      ALTER TABLE catalog_fact_pointers_new RENAME TO catalog_fact_pointers;
    `);
  })();
}

function ensureColumn(db: Database.Database, tableName: string, columnName: string, columnType: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
}
