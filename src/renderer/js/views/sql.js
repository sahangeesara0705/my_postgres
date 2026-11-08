'use strict';

const hintCache = {};
async function loadHintTables(database) {
  if (hintCache[database]) return hintCache[database];
  const out = {};
  try {
    const list = await rows(
      database,
      `select n.nspname as s, c.relname as t, array_agg(a.attname order by a.attnum) as cols
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where c.relkind in ('r','v','m','p','f') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
        group by 1, 2 limit 3000`
    );
    for (const r of list) {
      const cols = String(r.cols).replace(/^\{|\}$/g, '').split(',').map((c) => c.replace(/^"|"$/g, ''));
      if (r.s === 'public') out[r.t] = cols;
      out[r.s + '.' + r.t] = cols;
    }
  } catch {}
  hintCache[database] = out;
  return out;
}

function addHistory(sql, db, ok, ms) {
  const list = store('history') || [];
  list.unshift({ sql, db, ok, ms, ts: Date.now() });
  store('history', list.slice(0, 300));
}

function openSqlTab(database, initialSql = '', title) {
  database = database || S.conn.database;
  const id = uid('sql');
  const session = id;
  let currentDb = database;
  let filePath = null;

  const pane = h('div', { class: 'tabpane' });
  const dbSelect = h('select', { title: 'Database' });
  const maxRowsSel = h('select', { title: 'Maximum rows to display' },
    ['100', '1000', '5000', '20000'].map((n) => h('option', { value: n, selected: n === '1000' }, n + ' rows')));
  const runBtn = h('button', { class: 'btn sm primary', title: 'Execute (Ctrl+Enter). Runs the selection if any.' }, '▶ Execute');
  const runCurBtn = h('button', { class: 'btn sm', title: 'Execute the statement under the cursor (Ctrl+Shift+Enter)' }, 'Run current');
  const explainBtn = h('button', { class: 'btn sm', title: 'EXPLAIN' }, 'Explain');
  const analyzeBtn = h('button', { class: 'btn sm', title: 'EXPLAIN ANALYZE (executes the query!)' }, 'Explain analyze');
  const cancelBtn = h('button', { class: 'btn sm danger', disabled: true }, '■ Cancel');
  const commitBtn = h('button', { class: 'btn sm', title: 'COMMIT the open transaction in this editor session' }, 'Commit');
  const rollbackBtn = h('button', { class: 'btn sm', title: 'ROLLBACK the open transaction in this editor session' }, 'Rollback');
  const openBtn = h('button', { class: 'btn sm ghost', title: 'Open .sql file' }, 'Open');
  const saveBtn = h('button', { class: 'btn sm ghost', title: 'Save to .sql file (Ctrl+S)' }, 'Save');
  const histBtn = h('button', { class: 'btn sm ghost' }, 'History');
  const info = h('span', { class: 'muted', style: { fontSize: '12px' } });

  const toolbar = h('div', { class: 'toolbar' },
    dbSelect, runBtn, runCurBtn, explainBtn, analyzeBtn, cancelBtn,
    h('span', { class: 'sep' }), commitBtn, rollbackBtn,
    h('span', { class: 'sep' }), maxRowsSel, h('span', { class: 'spacer' }), openBtn, saveBtn, histBtn);

  const edHolder = h('div', { class: 'sql-editor' });
  const hsplit = h('div', { class: 'sql-hsplit' });
  const resTabs = h('div', { class: 'res-tabs' });
  const resBody = h('div', { class: 'res-body' }, h('div', { class: 'empty-state' }, 'Press Ctrl+Enter to execute. Ctrl+Space for autocomplete.'));
  const results = h('div', { class: 'sql-results' }, resTabs, resBody);
  appendTo(pane, toolbar, h('div', { class: 'sql-split' }, edHolder, hsplit, results));

  const cm = makeEditor(edHolder, {
    value: initialSql,
    extraKeys: {
      'Ctrl-Enter': () => run(),
      'Shift-Ctrl-Enter': () => runCurrent(),
      'Ctrl-S': () => save(),
    },
  });

  // splitter
  hsplit.addEventListener('mousedown', (e) => {
    e.preventDefault();
    hsplit.classList.add('drag');
    const startY = e.clientY;
    const startH = edHolder.offsetHeight;
    const move = (ev) => {
      edHolder.style.height = Math.max(80, startH + ev.clientY - startY) + 'px';
      cm.refresh();
    };
    const up = () => {
      hsplit.classList.remove('drag');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  (async () => {
    try {
      const dbs = await rows(S.conn.database, 'select datname from pg_database where datallowconn order by datname');
      for (const d of dbs) dbSelect.appendChild(h('option', { value: d.datname, selected: d.datname === currentDb }, d.datname));
    } catch {
      dbSelect.appendChild(h('option', { value: currentDb }, currentDb));
    }
    cm.setOption('hintOptions', { completeSingle: false, tables: await loadHintTables(currentDb) });
  })();
  dbSelect.addEventListener('change', async () => {
    currentDb = dbSelect.value;
    tab.setTitle(title || 'SQL: ' + currentDb);
    cm.setOption('hintOptions', { completeSingle: false, tables: await loadHintTables(currentDb) });
  });
  cm.on('inputRead', (c, ch) => {
    if (/[\w.]/.test(ch.text[0] || '') && ch.origin === '+input') {
      const tok = c.getTokenAt(c.getCursor());
      if (tok.string.length >= 2 || ch.text[0] === '.') c.showHint({ completeSingle: false });
    }
  });

  let running = false;
  function setRunning(v) {
    running = v;
    [runBtn, runCurBtn, explainBtn, analyzeBtn, commitBtn, rollbackBtn].forEach((b) => (b.disabled = v));
    cancelBtn.disabled = !v;
    info.textContent = v ? 'Running…' : info.textContent;
  }

  function statementAtCursor() {
    const text = cm.getValue();
    const pos = cm.indexFromPos(cm.getCursor());
    // find statement boundaries using splitSql on prefix
    const stmts = splitSql(text);
    let acc = 0;
    for (const s of stmts) {
      const idx = text.indexOf(s, acc);
      const end = idx + s.length;
      if (pos <= end + 1) return s;
      acc = end;
    }
    return stmts[stmts.length - 1] || '';
  }

  async function execute(sql, label) {
    if (!sql.trim() || running) return;
    setRunning(true);
    setStatus('Executing query…');
    const maxRows = Number(maxRowsSel.value);
    const r = await execScript(currentDb, sql, { session, maxRows });
    setRunning(false);
    addHistory(sql, currentDb, !r.error, r.duration);
    if (r.error) {
      info.textContent = `Error after ${fmtMs(r.duration)}`;
      setStatus('Query failed');
      showError(r.error, r.failedSql || sql);
      return;
    }
    info.textContent = `${r.results.length} statement(s) · ${fmtMs(r.duration)}`;
    setStatus(`Query executed in ${fmtMs(r.duration)}`);
    showResults(r.results, label);
    if (r.results.some((x) => /^(CREATE|DROP|ALTER)/.test(x.command || ''))) {
      delete hintCache[currentDb];
      refreshTree();
    }
  }

  function showError(err, sql) {
    clear(resTabs);
    let msg = 'ERROR: ' + err.message;
    if (err.code) msg += '\nSQLSTATE: ' + err.code;
    if (err.detail) msg += '\nDETAIL: ' + err.detail;
    if (err.hint) msg += '\nHINT: ' + err.hint;
    if (err.where) msg += '\nWHERE: ' + err.where;
    if (err.position) {
      const p = Number(err.position) - 1;
      const before = sql.slice(0, p);
      const line = before.split('\n').length;
      msg += `\nPOSITION: line ${line}`;
      // move cursor to error
      const sel = cm.somethingSelected() ? cm.indexFromPos(cm.getCursor('from')) : 0;
      if (cm.getValue().includes(sql)) {
        const base = cm.getValue().indexOf(sql, sel ? sel : 0);
        if (base >= 0) cm.setCursor(cm.posFromIndex(base + p));
      }
    }
    clear(resBody).appendChild(h('div', { class: 'res-msg err' }, msg));
  }

  function showResults(list, label) {
    clear(resTabs);
    const show = (i) => {
      $$('.res-tab', resTabs).forEach((t, j) => t.classList.toggle('active', i === j));
      const res = list[i];
      clear(resBody);
      if (res.fields && res.fields.length) {
        const g = dataGrid({ fields: res.fields, rows: res.rows });
        resBody.appendChild(g.el);
        resBody.appendChild(
          h('div', { class: 'grid-foot' },
            `${fmtNum(res.totalRows)} row(s)` + (res.truncated ? ` — showing first ${fmtNum(res.rows.length)}` : ''),
            h('span', { class: 'spacer' }),
            btn('Export CSV', () => exportResult(res, 'csv')),
            btn('Export JSON', () => exportResult(res, 'json'))
          )
        );
      } else {
        resBody.appendChild(h('div', { class: 'res-msg' }, `${res.command || 'OK'}${res.rowCount !== null && res.rowCount !== undefined ? ' ' + res.rowCount : ''}\n\nQuery returned successfully.`));
      }
    };
    list.forEach((res, i) => {
      const name = res.fields && res.fields.length ? `${label || 'Result'} ${i + 1} (${fmtNum(res.totalRows)})` : `${res.command || 'OK'} ${res.rowCount ?? ''}`;
      resTabs.appendChild(h('div', { class: 'res-tab', onclick: () => show(i) }, name));
    });
    // show last result-set (or last result)
    let idx = list.length - 1;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].fields && list[i].fields.length) { idx = i; break; }
    show(idx);
  }

  async function exportResult(res, fmt) {
    const p = await api.saveDialog({ defaultPath: `result.${fmt}`, filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }] });
    if (!p) return;
    let content;
    if (fmt === 'csv') {
      const cell = (v) => (v === null ? '' : /[",\n\r]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
      content = [res.fields.map((f) => cell(f.name)).join(','), ...res.rows.map((r) => r.map(cell).join(','))].join('\n') + '\n';
    } else {
      content = JSON.stringify(res.rows.map((r) => Object.fromEntries(res.fields.map((f, i) => [f.name, r[i]]))), null, 2);
    }
    await api.writeFile({ path: p, content });
    toast(`Saved ${res.rows.length} rows to ${p}`, 'ok');
  }

  const selectedOrAll = () => (cm.somethingSelected() ? cm.getSelection() : cm.getValue());
  const run = () => execute(selectedOrAll());
  const runCurrent = () => execute(statementAtCursor());
  async function save() {
    const p = filePath || (await api.saveDialog({ defaultPath: 'query.sql', filters: [{ name: 'SQL', extensions: ['sql'] }] }));
    if (!p) return;
    await api.writeFile({ path: p, content: cm.getValue() });
    filePath = p;
    tab.setTitle(p.split('/').pop());
    toast('Saved ' + p, 'ok');
  }

  runBtn.onclick = run;
  runCurBtn.onclick = runCurrent;
  explainBtn.onclick = () => execute('EXPLAIN (FORMAT TEXT, VERBOSE) ' + (cm.somethingSelected() ? cm.getSelection() : statementAtCursor()), 'Plan');
  analyzeBtn.onclick = async () => {
    const s = cm.somethingSelected() ? cm.getSelection() : statementAtCursor();
    if (!/^\s*select/i.test(s) && !(await confirmDlg('EXPLAIN ANALYZE actually executes the statement. Continue?', { danger: true }))) return;
    execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ' + s, 'Plan');
  };
  cancelBtn.onclick = async () => {
    await api.cancel({ key: S.conn.key, session });
    toast('Cancel request sent', 'warn');
  };
  commitBtn.onclick = () => execute('COMMIT');
  rollbackBtn.onclick = () => execute('ROLLBACK');
  saveBtn.onclick = save;
  openBtn.onclick = async () => {
    const p = await api.openDialog({ filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }, { name: 'All files', extensions: ['*'] }] });
    if (!p) return;
    cm.setValue(await api.readFile(p));
    filePath = p;
    tab.setTitle(p.split('/').pop());
  };
  histBtn.onclick = () => {
    const list = store('history') || [];
    const box = h('div', { class: 'history-list' });
    const filter = h('input', { placeholder: 'Search history…' });
    let m;
    const paint = () => {
      clear(box);
      const f = filter.value.toLowerCase();
      const items = list.filter((x) => !f || x.sql.toLowerCase().includes(f)).slice(0, 200);
      if (!items.length) box.appendChild(h('div', { class: 'muted', style: { padding: '12px' } }, 'No history yet'));
      for (const it of items) {
        box.appendChild(
          h('div', {
            class: 'history-item',
            onclick: () => {
              cm.setValue(it.sql);
              m.close();
            },
          },
          h('div', { class: 'meta' }, new Date(it.ts).toLocaleString(), ' · ', it.db, ' · ', h('span', { class: it.ok ? 'ok' : 'err' }, it.ok ? 'ok' : 'error'), it.ms !== undefined ? ' · ' + fmtMs(it.ms) : ''),
          h('pre', { class: 'mono' }, it.sql))
        );
      }
    };
    filter.addEventListener('input', paint);
    paint();
    m = modal({
      title: 'Query history',
      size: 'wide',
      body: [filter, box],
      buttons: [{ label: 'Clear history', kind: 'danger', onClick: () => store('history', []) }, { label: 'Close' }],
    });
  };

  const tab = addTab({
    id,
    title: title || 'SQL: ' + currentDb,
    icon: '⌨',
    pane,
    onActivate: () => setTimeout(() => cm.refresh(), 0),
    onClose: () => api.closeSession({ key: S.conn.key, session }),
  });
  setTimeout(() => {
    cm.refresh();
    cm.focus();
    cm.setCursor(cm.lineCount(), 0);
  }, 30);
  return { cm, setFile: (p) => (filePath = p) };
}
