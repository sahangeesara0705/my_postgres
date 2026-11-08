'use strict';
/* global api */

// Global application state
const S = {
  conn: null, // { key, name, version, versionNum, user, superuser, database, host, port, color }
  tabs: [],
  activeTab: null,
  showSystem: false,
};

/* ---------- SQL quoting ---------- */
const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const ql = (s) => (s === null || s === undefined ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'");
const qn = (schema, name) => (schema ? qi(schema) + '.' + qi(name) : qi(name));

/* ---------- formatting ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtBytes(n) {
  n = Number(n);
  if (!isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + ' ' + u[i];
}
function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '';
  const x = Number(n);
  return isFinite(x) ? x.toLocaleString() : String(n);
}
function fmtMs(ms) {
  return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s';
}
const isTrue = (v) => v === true || v === 't' || v === 'true';

/* ---------- DOM builder ---------- */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  appendKids(el, children);
  return el;
}
function appendKids(el, kids) {
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendKids(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
function appendTo(el, ...kids) {
  appendKids(el, kids);
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/* ---------- database access ---------- */
class DbError extends Error {
  constructor(e) {
    super(e.message);
    Object.assign(this, e);
  }
  full() {
    let s = this.message;
    if (this.detail) s += '\nDETAIL: ' + this.detail;
    if (this.hint) s += '\nHINT: ' + this.hint;
    if (this.where) s += '\nWHERE: ' + this.where;
    return s;
  }
}

// Run SQL and get raw results: { results: [{fields, rows, rowCount, command}], duration }
async function runSql(database, sql, params, opts = {}) {
  const r = await api.query({ key: S.conn.key, database, sql, params: params || [], ...opts });
  if (r.error) throw new DbError(r.error);
  return r;
}
// Run SQL and get the last result as an array of objects
async function rows(database, sql, params) {
  const r = await runSql(database, sql, params);
  const res = r.results[r.results.length - 1];
  return res.rows.map((row) => {
    const o = {};
    res.fields.forEach((f, i) => (o[f.name] = row[i]));
    return o;
  });
}
async function one(database, sql, params) {
  return (await rows(database, sql, params))[0] || null;
}
async function exec(database, sql, params) {
  return runSql(database, sql, params);
}

function errText(e) {
  return e instanceof DbError ? e.full() : e && e.message ? e.message : String(e);
}

/* ---------- misc ---------- */
let uidCounter = 0;
const uid = (p = 'id') => p + '_' + Date.now().toString(36) + '_' + (++uidCounter).toString(36);

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function store(k, v) {
  try {
    if (v === undefined) return JSON.parse(localStorage.getItem('mp.' + k));
    localStorage.setItem('mp.' + k, JSON.stringify(v));
  } catch {
    return null;
  }
}

// Minimal RFC4180 CSV parser
function parseCsv(text, delim = ',', maxRows = Infinity) {
  const out = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQ = false;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      inQ = true;
      i++;
      continue;
    }
    if (c === delim) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      row.push(field);
      field = '';
      out.push(row);
      row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (out.length >= maxRows) return out;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

// Split a SQL script into statements (respects quotes, dollar quotes and comments)
function splitSql(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql.slice(i, i + 2);
    if (d === '--') {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? n : e;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (d === '/*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const e = sql.indexOf(tag, i + tag.length);
        const end = e < 0 ? n : e + tag.length;
        cur += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  // drop comment-only chunks
  return out.filter((s) => s.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim());
}

const PG_TYPES = [
  'integer', 'bigint', 'smallint', 'serial', 'bigserial', 'numeric', 'numeric(10,2)', 'real', 'double precision',
  'text', 'varchar(255)', 'char(1)', 'boolean', 'date', 'time', 'timestamp', 'timestamptz', 'interval',
  'uuid', 'json', 'jsonb', 'bytea', 'inet', 'cidr', 'macaddr', 'money', 'xml', 'tsvector',
  'integer[]', 'text[]', 'point', 'int4range', 'tstzrange',
];
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700, 790]);

// Statements that cannot run inside a (implicit) transaction block
const NON_TX_RE = /^(VACUUM|ALTER\s+SYSTEM|CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+DATABASE\s+\S+\s+SET\s+TABLESPACE|REINDEX\s+(\([^)]*\)\s*)?(DATABASE|SYSTEM)|REINDEX\b.*\bCONCURRENTLY|CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY|DROP\s+INDEX\s+CONCURRENTLY|CREATE\s+TABLESPACE|DROP\s+TABLESPACE)/i;
const stripLeadingComments = (s) => s.replace(/^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*\s*/, '');

/**
 * Execute a script. Normally sent as one multi-statement query (atomic), but when it contains
 * statements that can't run in a transaction block, statements are sent one by one.
 * Returns the raw IPC response ({results, duration} or {error, duration}).
 */
async function execScript(database, sql, opts = {}) {
  const stmts = splitSql(sql);
  if (stmts.length > 1 && stmts.some((s) => NON_TX_RE.test(stripLeadingComments(s)))) {
    const results = [];
    let duration = 0;
    for (const s of stmts) {
      const r = await api.query({ key: S.conn.key, database, sql: s, ...opts });
      duration += r.duration || 0;
      if (r.error) return { error: r.error, duration, results, failedSql: s };
      results.push(...r.results);
    }
    return { results, duration };
  }
  return api.query({ key: S.conn.key, database, sql, ...opts });
}
