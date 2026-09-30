'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function initDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'snapshots'), { recursive: true });

  const db = new Database(path.join(dataDir, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id            TEXT PRIMARY KEY,
      filename      TEXT NOT NULL,           -- 原始文件名
      stored_name   TEXT NOT NULL,           -- images/ 下的存储文件名
      mime          TEXT NOT NULL,
      width         INTEGER NOT NULL,
      height        INTEGER NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,  -- 草稿版本，每次修改 +1
      calib         TEXT,                    -- JSON: {p1:{x,y}, p2:{x,y}, distanceUm, scale}
      cells         TEXT NOT NULL DEFAULT '[]', -- JSON: [{id,name,outer,holes,areaUm2,perimeterUm}]
      published     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reports (
      id            TEXT PRIMARY KEY,
      image_id      TEXT NOT NULL,
      draft_version INTEGER NOT NULL,        -- 发布时携带的草稿版本
      title         TEXT NOT NULL,
      filename      TEXT NOT NULL,           -- 原始图片文件名（快照信息）
      snapshot_name TEXT NOT NULL,           -- snapshots/ 下的图片文件名
      width         INTEGER NOT NULL,
      height        INTEGER NOT NULL,
      calib         TEXT NOT NULL,
      cells         TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
    );

    -- 报告间比较记录：只保存两份不可变报告与手动指定的细胞配对，
    -- 比较数值始终从两份报告冻结的定标/测量值实时计算。
    CREATE TABLE IF NOT EXISTS comparisons (
      id                 TEXT PRIMARY KEY,
      baseline_report_id TEXT NOT NULL,
      retest_report_id   TEXT NOT NULL,
      title              TEXT NOT NULL,
      pairs              TEXT NOT NULL DEFAULT '[]', -- JSON: [{baseCellId, retestCellId}]
      version            INTEGER NOT NULL DEFAULT 1, -- 比较记录版本，每次修改 +1
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (baseline_report_id) REFERENCES reports(id) ON DELETE RESTRICT,
      FOREIGN KEY (retest_report_id) REFERENCES reports(id) ON DELETE RESTRICT
    );
  `);

  return db;
}

module.exports = { initDb };
