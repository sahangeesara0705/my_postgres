'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const pg = require('pg');
const Cursor = require('pg-cursor');

// Return every value as raw text so the UI can display and edit it losslessly.
const RAW_TYPES = { getTypeParser: () => (v) => v };

let mainWindow = null;

/* ------------------------------------------------------------------ */
/* Saved connections                                                   */
/* ------------------------------------------------------------------ */
const storeFile = () => path.join(app.getPath('userData'), 'connections.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch {
    return [];
  }
}
function writeStore(list) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(list, null, 2), { mode: 0o600 });
}
function encryptPassword(pw) {
  if (!pw) return null;
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: true, data: safeStorage.encryptString(pw).toString('base64') };
  }
  return { enc: false, data: Buffer.from(pw, 'utf8').toString('base64') };
}
function decryptPassword(stored) {
  if (!stored) return '';
  try {
    if (stored.enc) return safeStorage.decryptString(Buffer.from(stored.data, 'base64'));
    return Buffer.from(stored.data, 'base64').toString('utf8');
  } catch {
    return '';
  }
}
function publicConn(c) {
  const { password, ...rest } = c;
  return { ...rest, hasPassword: !!password };
}

/* ------------------------------------------------------------------ */
/* Live connections                                                    */
/* ------------------------------------------------------------------ */
// key -> { cfg, pools: Map<db, Pool>, sessions: Map<sessionId, {client, db}> }
const live = new Map();

function resolveConfig(cfg) {
  const out = { ...cfg };
  if (cfg.id && !cfg.password) {
    const saved = readStore().find((c) => c.id === cfg.id);
    if (saved) out.password = decryptPassword(saved.password);
  }
  return out;
}

function pgOptions(cfg, database) {
  const o = {
    host: cfg.host || 'localhost',
    port: Number(cfg.port) || 5432,
    user: cfg.user || undefined,
    password: cfg.password || undefined,
    database: database || cfg.database || 'postgres',
    application_name: 'My Postgres',
    connectionTimeoutMillis: 15000,
    types: RAW_TYPES,
  };
  if (cfg.ssl) o.ssl = { rejectUnauthorized: !!cfg.sslVerify };
  return o;
}

function getPool(key, database) {
  const c = live.get(key);
  if (!c) throw new Error('Not connected');
  const db = database || c.cfg.database || 'postgres';
  let pool = c.pools.get(db);
  if (!pool) {
    pool = new pg.Pool({ ...pgOptions(c.cfg, db), max: 5, idleTimeoutMillis: 60000 });
    pool.on('error', () => {});
    c.pools.set(db, pool);
  }
  return pool;
}

async function getSession(key, database, sessionId) {
  const c = live.get(key);
  if (!c) throw new Error('Not connected');
  let s = c.sessions.get(sessionId);
  if (s && s.db !== database) {
    s.client.end().catch(() => {});
    c.sessions.delete(sessionId);
    s = null;
  }
  if (!s) {
    const client = new pg.Client(pgOptions(c.cfg, database));
    client.on('error', () => c.sessions.delete(sessionId));
    await client.connect();
    s = { client, db: database };
    c.sessions.set(sessionId, s);
  }
  return s.client;
}

function serializeError(e) {
  return {
    message: e.message || String(e),
    code: e.code,
    detail: e.detail,
    hint: e.hint,
    position: e.position,
    where: e.where,
  };
}

function shapeResult(r, maxRows) {
  const rows = r.rows || [];
  const truncated = maxRows && rows.length > maxRows;
  return {
    command: r.command,
    rowCount: r.rowCount,
    fields: (r.fields || []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID, tableID: f.tableID, columnID: f.columnID })),
    rows: truncated ? rows.slice(0, maxRows) : rows,
    totalRows: rows.length,
    truncated: !!truncated,
  };
}

ipcMain.handle('conn:list', () => readStore().map(publicConn));

ipcMain.handle('conn:save', (_e, conn) => {
  const list = readStore();
  const idx = conn.id ? list.findIndex((c) => c.id === conn.id) : -1;
  const prev = idx >= 0 ? list[idx] : null;
  const record = {
    id: conn.id || crypto.randomUUID(),
    name: conn.name || `${conn.user || 'postgres'}@${conn.host || 'localhost'}`,
    host: conn.host || 'localhost',
    port: Number(conn.port) || 5432,
    user: conn.user || '',
    database: conn.database || 'postgres',
    ssl: !!conn.ssl,
    sslVerify: !!conn.sslVerify,
    color: conn.color || '#336791',
    savePassword: !!conn.savePassword,
    password: null,
  };
  if (conn.savePassword) {
    if (conn.password) record.password = encryptPassword(conn.password);
    else if (prev) record.password = prev.password;
  }
  if (idx >= 0) list[idx] = record;
  else list.push(record);
  writeStore(list);
  return publicConn(record);
});

ipcMain.handle('conn:delete', (_e, id) => {
  writeStore(readStore().filter((c) => c.id !== id));
  return true;
});

ipcMain.handle('pg:test', async (_e, cfg) => {
  const full = resolveConfig(cfg);
  const client = new pg.Client(pgOptions(full, full.database));
  try {
    await client.connect();
    const r = await client.query('select version() as v');
    return { ok: true, version: r.rows[0].v };
  } catch (e) {
    return { ok: false, error: serializeError(e) };
  } finally {
    client.end().catch(() => {});
  }
});

ipcMain.handle('pg:connect', async (_e, cfg) => {
  const full = resolveConfig(cfg);
  const key = crypto.randomUUID();
  live.set(key, { cfg: full, pools: new Map(), sessions: new Map() });
  try {
    const r = await getPool(key, full.database).query(
      "select version() as version, current_setting('server_version_num') as num, current_user as user, " +
        "(select rolsuper from pg_roles where rolname = current_user) as superuser"
    );
    const row = r.rows[0];
    return {
      ok: true,
      key,
      version: row.version,
      versionNum: Number(row.num),
      user: row.user,
      superuser: row.superuser === 't' || row.superuser === true,
      database: full.database || 'postgres',
      name: full.name || `${full.user}@${full.host}`,
      host: full.host,
      port: full.port,
    };
  } catch (e) {
    await closeLive(key);
    return { ok: false, error: serializeError(e) };
  }
});

async function closeLive(key) {
  const c = live.get(key);
  if (!c) return;
  live.delete(key);
  for (const s of c.sessions.values()) await s.client.end().catch(() => {});
  for (const p of c.pools.values()) await p.end().catch(() => {});
}

ipcMain.handle('pg:disconnect', async (_e, key) => {
  await closeLive(key);
  return true;
});

// Close every pool/session bound to a database (needed before DROP/RENAME DATABASE).
ipcMain.handle('pg:releaseDatabase', async (_e, { key, database }) => {
  const c = live.get(key);
  if (!c) return true;
  const p = c.pools.get(database);
  if (p) {
    c.pools.delete(database);
    await p.end().catch(() => {});
  }
  for (const [id, s] of c.sessions) {
    if (s.db === database) {
      c.sessions.delete(id);
      await s.client.end().catch(() => {});
    }
  }
  return true;
});

ipcMain.handle('pg:query', async (_e, opts) => {
  const { key, database, sql, params, session, maxRows } = opts;
  const started = Date.now();
  try {
    const runner = session ? await getSession(key, database, session) : getPool(key, database);
    const q = { text: sql, rowMode: 'array' };
    if (params && params.length) q.values = params;
    const r = await runner.query(q);
    const list = Array.isArray(r) ? r : [r];
    return { results: list.map((x) => shapeResult(x, maxRows)), duration: Date.now() - started };
  } catch (e) {
    return { error: serializeError(e), duration: Date.now() - started };
  }
});

ipcMain.handle('pg:sessionInfo', async (_e, { key, session }) => {
  const c = live.get(key);
  const s = c && c.sessions.get(session);
  return s ? { pid: s.client.processID, db: s.db } : null;
});

ipcMain.handle('pg:cancel', async (_e, { key, session }) => {
  const c = live.get(key);
  const s = c && c.sessions.get(session);
  if (!s) return false;
  try {
    await getPool(key, s.db).query('select pg_cancel_backend($1)', [s.client.processID]);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('pg:closeSession', async (_e, { key, session }) => {
  const c = live.get(key);
  const s = c && c.sessions.get(session);
  if (s) {
    c.sessions.delete(session);
    await s.client.end().catch(() => {});
  }
  return true;
});

/* ------------------------------------------------------------------ */
/* Export (streamed through a cursor)                                  */
/* ------------------------------------------------------------------ */
function csvCell(v, delim) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function qIdent(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

ipcMain.handle('pg:export', async (_e, opts) => {
  const { key, database, sql, format, filePath, tableName, header = true, delimiter = ',', batchInsert = 100 } = opts;
  let client;
  const out = fs.createWriteStream(filePath, { encoding: 'utf8' });
  const write = (s) => new Promise((res) => (out.write(s) ? res() : out.once('drain', res)));
  let count = 0;
  try {
    client = await getPool(key, database).connect();
    const cursor = client.query(new Cursor(sql, [], { rowMode: 'array', types: RAW_TYPES }));
    let fields = null;
    let first = true;
    let pending = [];
    const flushInsert = async () => {
      if (!pending.length) return;
      const cols = fields.map((f) => qIdent(f.name)).join(', ');
      await write(`INSERT INTO ${tableName} (${cols}) VALUES\n` + pending.map((r) => '  (' + r.map(sqlLit).join(', ') + ')').join(',\n') + ';\n');
      pending = [];
    };
    if (format === 'json') await write('[\n');
    for (;;) {
      const { rows, result } = await new Promise((res, rej) =>
        cursor.read(1000, (err, rows, result) => (err ? rej(err) : res({ rows, result })))
      );
      if (!fields) {
        fields = (result && result.fields) || [];
        if (format === 'csv' && header) await write(fields.map((f) => csvCell(f.name, delimiter)).join(delimiter) + '\n');
        if (format === 'sql') await write(`-- Exported by My Postgres on ${new Date().toISOString()}\n`);
      }
      if (!rows.length) break;
      for (const r of rows) {
        count++;
        if (format === 'csv') await write(r.map((v) => csvCell(v, delimiter)).join(delimiter) + '\n');
        else if (format === 'json') {
          const obj = {};
          fields.forEach((f, i) => (obj[f.name] = r[i]));
          await write((first ? '  ' : ',\n  ') + JSON.stringify(obj));
          first = false;
        } else if (format === 'sql') {
          pending.push(r);
          if (pending.length >= batchInsert) await flushInsert();
        }
      }
    }
    if (format === 'sql') await flushInsert();
    if (format === 'json') await write('\n]\n');
    await new Promise((res) => cursor.close(res));
    return { ok: true, count };
  } catch (e) {
    return { ok: false, error: serializeError(e), count };
  } finally {
    if (client) client.release();
    await new Promise((res) => out.end(res));
  }
});

/* ------------------------------------------------------------------ */
/* Files & dialogs                                                     */
/* ------------------------------------------------------------------ */
ipcMain.handle('dlg:save', async (_e, opts) => {
  const r = await dialog.showSaveDialog(mainWindow, opts || {});
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dlg:open', async (_e, opts) => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], ...(opts || {}) });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('file:read', async (_e, p) => {
  const st = fs.statSync(p);
  if (st.size > 512 * 1024 * 1024) throw new Error('File is larger than 512 MB');
  return fs.readFileSync(p, 'utf8');
});
ipcMain.handle('file:write', async (_e, { path: p, content }) => {
  fs.writeFileSync(p, content, 'utf8');
  return true;
});
ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

/* ------------------------------------------------------------------ */
/* External tools: pg_dump / pg_restore / psql                         */
/* ------------------------------------------------------------------ */
function findTool(name) {
  const candidates = [];
  try {
    const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (p) candidates.push(p);
  } catch {}
  try {
    for (const v of fs.readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a))) {
      candidates.push(`/usr/lib/postgresql/${v}/bin/${name}`);
    }
  } catch {}
  return candidates.find((p) => fs.existsSync(p)) || null;
}

ipcMain.handle('tools:info', () => {
  const info = {};
  for (const t of ['pg_dump', 'pg_restore', 'psql']) {
    const p = findTool(t);
    let version = null;
    if (p) {
      try {
        version = execFileSync(p, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {}
    }
    info[t] = p ? { path: p, version } : null;
  }
  return info;
});

function toolEnv(cfg) {
  const env = { ...process.env, PGPASSWORD: cfg.password || '', PGAPPNAME: 'My Postgres' };
  if (cfg.ssl) env.PGSSLMODE = cfg.sslVerify ? 'verify-full' : 'require';
  return env;
}
function connArgs(cfg, database) {
  return ['-h', cfg.host || 'localhost', '-p', String(cfg.port || 5432), '-U', cfg.user || 'postgres', '-d', database];
}

const runningJobs = new Map();
ipcMain.handle('tools:run', async (e, { key, tool, database, args, jobId }) => {
  const c = live.get(key);
  if (!c) return { ok: false, error: { message: 'Not connected' } };
  const bin = findTool(tool);
  if (!bin) return { ok: false, error: { message: `${tool} was not found. Install it with: sudo apt install postgresql-client` } };
  const fullArgs = [...connArgs(c.cfg, database), ...args];
  return new Promise((resolve) => {
    const child = spawn(bin, fullArgs, { env: toolEnv(c.cfg) });
    runningJobs.set(jobId, child);
    let stderr = '';
    const send = (text) => {
      if (!e.sender.isDestroyed()) e.sender.send('tools:log', { jobId, text });
    };
    child.stdout.on('data', (d) => send(d.toString()));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      send(d.toString());
    });
    child.on('error', (err) => {
      runningJobs.delete(jobId);
      resolve({ ok: false, error: { message: err.message } });
    });
    child.on('close', (code) => {
      runningJobs.delete(jobId);
      resolve(code === 0 ? { ok: true, stderr } : { ok: false, error: { message: `${tool} exited with code ${code}`, detail: stderr.slice(-4000) } });
    });
  });
});
ipcMain.handle('tools:kill', (_e, jobId) => {
  const ch = runningJobs.get(jobId);
  if (ch) ch.kill('SIGTERM');
  return !!ch;
});

ipcMain.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome }));

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */
function buildMenu() {
  const send = (ch) => () => mainWindow && mainWindow.webContents.send('menu', ch);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New SQL Editor', accelerator: 'CmdOrCtrl+T', click: send('new-sql') },
        { label: 'Open SQL File…', accelerator: 'CmdOrCtrl+O', click: send('open-sql') },
        { type: 'separator' },
        { label: 'Disconnect', click: send('disconnect') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Refresh Navigator', accelerator: 'F5', click: send('refresh') },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+L', click: send('toggle-theme') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'PostgreSQL Documentation', click: () => shell.openExternal('https://www.postgresql.org/docs/current/') },
        { label: 'About My Postgres', click: send('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'My Postgres',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#1e2227',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (ev) => ev.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  for (const k of [...live.keys()]) await closeLive(k);
  app.quit();
});
