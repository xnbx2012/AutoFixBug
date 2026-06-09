const { config } = require('../config');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function init() {
  const dbPath = config.paths.db;
  if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables();
  return db;
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS configs (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      url            TEXT    NOT NULL UNIQUE,
      owner          TEXT    NOT NULL,
      name           TEXT    NOT NULL,
      default_branch TEXT    DEFAULT 'main',
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS monitors (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id               INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      mode                  TEXT    NOT NULL CHECK(mode IN ('webhook','poll','app_poll')),
      auth_type             TEXT    DEFAULT 'user' CHECK(auth_type IN ('user','app')),
      enabled               INTEGER DEFAULT 0,
      webhook_secret        TEXT,
      webhook_url           TEXT,
      github_webhook_id     INTEGER,
      poll_interval         INTEGER DEFAULT 60,
      poll_cursor           TEXT,
      allowed_trigger_users TEXT,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id    INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      issue_number  INTEGER NOT NULL,
      issue_title   TEXT,
      issue_url     TEXT,
      branch_name   TEXT,
      pr_number     INTEGER,
      pr_url        TEXT,
      status        TEXT    DEFAULT 'pending'
        CHECK(status IN (
          'pending','cloning','branching','analyzing',
          'fixing','testing','pr_created','awaiting_review',
          'merging','merged','failed','commenting'
        )),
      error_message TEXT,
      log_path      TEXT,
      issue_comment_id INTEGER,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_monitor ON jobs(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_monitors_repo ON monitors(repo_id);
  `);

  // 兼容老库：若 jobs 表缺列，动态补上
  const jobCols = db.prepare("PRAGMA table_info(jobs)").all().map(c => c.name);
  if (!jobCols.includes('issue_comment_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN issue_comment_id INTEGER');
  }
  if (!jobCols.includes('duration_ms')) {
    db.exec('ALTER TABLE jobs ADD COLUMN duration_ms INTEGER');
  }
  if (!jobCols.includes('input_tokens')) {
    db.exec('ALTER TABLE jobs ADD COLUMN input_tokens INTEGER');
  }
  if (!jobCols.includes('output_tokens')) {
    db.exec('ALTER TABLE jobs ADD COLUMN output_tokens INTEGER');
  }
  if (!jobCols.includes('cache_read_input_tokens')) {
    db.exec('ALTER TABLE jobs ADD COLUMN cache_read_input_tokens INTEGER');
  }
  if (!jobCols.includes('session_path')) {
    db.exec('ALTER TABLE jobs ADD COLUMN session_path TEXT');
  }

  // 兼容老库：重建 monitors 表以更新 CHECK 约束（加入 app_poll）
  // SQLite 不支持 ALTER TABLE 修改 CHECK 约束，需要通过重建表实现
  const monitorTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='monitors'").get();
  if (monitorTableInfo && !monitorTableInfo.sql.includes('app_poll')) {
    db.exec('DROP TABLE IF EXISTS monitors_new');
    // 先修复可能存在的 NULL auth_type
    db.exec("UPDATE monitors SET auth_type = 'user' WHERE auth_type IS NULL");
    db.exec(`
      CREATE TABLE monitors_new (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id               INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        mode                  TEXT    NOT NULL CHECK(mode IN ('webhook','poll','app_poll')),
        auth_type             TEXT    DEFAULT 'user' CHECK(auth_type IN ('user','app')),
        enabled               INTEGER DEFAULT 0,
        webhook_secret        TEXT,
        webhook_url           TEXT,
        github_webhook_id     INTEGER,
        poll_interval         INTEGER DEFAULT 60,
        poll_cursor           TEXT,
        model_name            TEXT,
        api_key               TEXT,
        api_base_url          TEXT,
        allowed_trigger_users TEXT,
        created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO monitors_new(id, repo_id, mode, auth_type, enabled, webhook_secret,
        webhook_url, github_webhook_id, poll_interval, poll_cursor, created_at,
        model_name, api_key, api_base_url, allowed_trigger_users)
        SELECT id, repo_id, mode, COALESCE(auth_type, 'user'), enabled, webhook_secret,
          webhook_url, github_webhook_id, poll_interval, poll_cursor, created_at,
          model_name, api_key, api_base_url, allowed_trigger_users FROM monitors;
      DROP TABLE monitors;
      ALTER TABLE monitors_new RENAME TO monitors;
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_monitors_repo ON monitors(repo_id)');
  }

  // 兼容老库：若 monitors 表缺 auth_type 列，动态补上
  const monitorCols = db.prepare("PRAGMA table_info(monitors)").all().map(c => c.name);
  if (!monitorCols.includes('auth_type')) {
    db.exec("ALTER TABLE monitors ADD COLUMN auth_type TEXT DEFAULT 'user'");
  }
  if (!monitorCols.includes('model_name')) {
    db.exec("ALTER TABLE monitors ADD COLUMN model_name TEXT");
  }
  if (!monitorCols.includes('api_key')) {
    db.exec("ALTER TABLE monitors ADD COLUMN api_key TEXT");
  }
  if (!monitorCols.includes('api_base_url')) {
    db.exec("ALTER TABLE monitors ADD COLUMN api_base_url TEXT");
  }
  if (!monitorCols.includes('allowed_trigger_users')) {
    db.exec("ALTER TABLE monitors ADD COLUMN allowed_trigger_users TEXT");
  }
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call init() first.');
  return db;
}

module.exports = { init, getDb };
