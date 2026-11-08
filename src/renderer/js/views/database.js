'use strict';

// A database to run statements from that is not `target` (for DROP / RENAME DATABASE)
function adminDb(target) {
  if (S.conn.database !== target) return S.conn.database;
  return target === 'postgres' ? 'template1' : 'postgres';
}

function openDatabaseTab(db, initialSub) {
  const id = `db:${db}`;
  if (activateTab(id, initialSub)) return;
  const pane = h('div', { class: 'tabpane' });
  pane.appendChild(
    h('div', { class: 'view-head' },
      h('div', { class: 'crumbs' }, h('span', null, db), h('span', { class: 'kind' }, 'database')),
      h('span', { class: 'spacer' }),
      btn('+ New table', () => createTableDialog(db, 'public'), 'primary'),
      btn('SQL', () => openSqlTab(db)))
  );
  const body = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
  pane.appendChild(body);
  const tabs = subTabs(body, [
    { id: 'tables', label: 'Tables', render: (p, t) => renderDbTables(p, db, t) },
    { id: 'schemas', label: 'Schemas', render: (p, t) => renderSchemas(p, db, t) },
    { id: 'routines', label: 'Functions', render: (p) => renderRoutines(p, db) },
    { id: 'extensions', label: 'Extensions', render: (p, t) => renderExtensions(p, db, t) },
    { id: 'maint', label: 'Maintenance', render: (p) => renderDbMaintenance(p, db) },
    { id: 'backup', label: 'Backup / Restore', render: (p) => renderBackup(p, db) },
    { id: 'ops', label: 'Operations', render: (p) => renderDbOps(p, db) },
  ], initialSub);
  addTab({ id, title: db, icon: '🛢', pane, onActivate: (sub) => sub && tabs.show(sub) });
}

function renderDbTables(pane, db, tabs) {
  fillPane(pane, async () => {
    const list = await rows(db, `
      select n.nspname as schema, c.relname as name, c.relkind as kind,
             greatest(c.reltuples, 0)::bigint as est, pg_total_relation_size(c.oid) as size,
             obj_description(c.oid, 'pg_class') as comment, pg_get_userbyid(c.relowner) as owner,
             s.n_dead_tup as dead, s.last_autovacuum as lav, s.last_vacuum as lv
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        left join pg_stat_all_tables s on s.relid = c.oid
       where c.relkind in ('r','p','v','m','f') and not c.relispartition
         and (${S.showSystem ? 'true' : "n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'"})
       order by n.nspname, c.relname`);
    const schemas = [...new Set(list.map((r) => r.schema))];
    const schemaSel = h('select', null, h('option', { value: '' }, 'All schemas'), schemas.map((s) => h('option', { selected: s === 'public' && schemas.length > 1 ? false : false }, s)));
    const search = h('input', { placeholder: 'Search tables…' });
    const holder = h('div');
    let table;
    const paint = () => {
      const f = search.value.toLowerCase();
      const data = list.filter((r) => (!schemaSel.value || r.schema === schemaSel.value) && (!f || r.name.toLowerCase().includes(f)));
      const totalSize = data.reduce((a, r) => a + Number(r.size || 0), 0);
      const wrap = listTable(
        [
          { label: 'Schema', key: 'schema', class: 'muted' },
          { label: 'Name', render: (r) => h('a', { onclick: () => openTableTab(db, r.schema, r.name, r.kind) }, r.name) },
          { label: 'Type', render: (r) => KIND_LABEL[r.kind] },
          { label: 'Rows (est.)', render: (r) => (r.kind === 'v' ? '' : fmtNum(r.est)), class: 'right' },
          { label: 'Size', render: (r) => fmtBytes(r.size), class: 'right nowrap' },
          { label: 'Dead tuples', render: (r) => (r.dead ? fmtNum(r.dead) : ''), class: 'right' },
          { label: 'Comment', key: 'comment', class: 'muted' },
        ],
        data,
        {
          checkable: true,
          empty: 'No tables. Click “+ New table” to create one.',
          actions: (r) => [
            btn('Browse', () => openTableTab(db, r.schema, r.name, r.kind, 'browse')),
            btn('Structure', () => openTableTab(db, r.schema, r.name, r.kind, 'structure')),
            r.kind === 'r' || r.kind === 'p'
              ? btn('Empty', () => runSqlDialog(db, `TRUNCATE TABLE ${qn(r.schema, r.name)};`, { title: 'Empty table', danger: true, okLabel: 'Truncate' }).then((ok) => ok && tabs.refresh()), 'danger')
              : null,
            btn('Drop', () => dropRelation(db, r).then((ok) => ok && tabs.refresh()), 'danger'),
          ],
        }
      );
      table = wrap.querySelector('table');
      appendTo(clear(holder), wrap, h('div', { class: 'help mt' }, `${data.length} object(s) · ${fmtBytes(totalSize)}`));
    };
    search.addEventListener('input', paint);
    schemaSel.addEventListener('change', paint);
    paint();

    const bulk = async (what) => {
      const sel = table.getChecked();
      if (!sel.length) return toast('Select one or more tables using the checkboxes', 'warn');
      const names = sel.map((r) => qn(r.schema, r.name));
      const tablesOnly = sel.filter((r) => r.kind === 'r' || r.kind === 'p' || r.kind === 'm').map((r) => qn(r.schema, r.name));
      let sql;
      if (what === 'drop') sql = sel.map((r) => `DROP ${{ v: 'VIEW', m: 'MATERIALIZED VIEW', f: 'FOREIGN TABLE' }[r.kind] || 'TABLE'} ${qn(r.schema, r.name)};`).join('\n');
      else if (what === 'truncate') sql = `TRUNCATE TABLE ${tablesOnly.join(', ')};`;
      else if (what === 'vacuum') sql = `VACUUM (ANALYZE) ${tablesOnly.join(', ')};`;
      else if (what === 'analyze') sql = `ANALYZE ${tablesOnly.join(', ')};`;
      else if (what === 'reindex') sql = tablesOnly.map((t) => `REINDEX TABLE ${t};`).join('\n');
      else if (what === 'export') return exportTables(db, sel);
      void names;
      const ok = await runSqlDialog(db, sql, { title: what.toUpperCase(), danger: what === 'drop' || what === 'truncate' });
      if (ok) {
        tabs.refresh();
        if (what === 'drop') refreshTree();
      }
    };
    return h('div', null,
      h('div', { class: 'flex', style: { marginBottom: '10px' } },
        schemaSel, search, h('span', { class: 'spacer' }),
        h('span', { class: 'help' }, 'With selected:'),
        btn('Export', () => bulk('export')),
        btn('Analyze', () => bulk('analyze')),
        btn('Vacuum', () => bulk('vacuum')),
        btn('Reindex', () => bulk('reindex')),
        btn('Empty', () => bulk('truncate'), 'danger'),
        btn('Drop', () => bulk('drop'), 'danger')),
      holder);
  });
}

async function exportTables(db, sel) {
  const p = await api.saveDialog({ defaultPath: `${db}_tables.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] });
  if (!p) return;
  let out = `-- My Postgres export of database ${db}\n-- ${new Date().toISOString()}\n\n`;
  const tmp = p + '.part';
  try {
    for (const r of sel) {
      const ctx = { db, schema: r.schema, name: r.name, kind: r.kind, rel: qn(r.schema, r.name) };
      ctx.meta = await tableMeta(db, r.schema, r.name);
      out += `-- ${r.schema}.${r.name}\n` + (await buildDdl(ctx)) + '\n';
      if (r.kind === 'r' || r.kind === 'p') {
        const res = await api.exportData({ key: S.conn.key, database: db, sql: `SELECT * FROM ${ctx.rel}`, format: 'sql', filePath: tmp, tableName: ctx.rel });
        if (!res.ok) throw new DbError(res.error);
        out += (await api.readFile(tmp)) + '\n';
      }
    }
    await api.writeFile({ path: p, content: out });
    toast(`Exported ${sel.length} object(s) to ${p}`, 'ok');
  } catch (e) {
    errorDlg(e, 'Export failed');
  }
}

async function dropRelation(db, r) {
  const t = { v: 'VIEW', m: 'MATERIALIZED VIEW', f: 'FOREIGN TABLE' }[r.kind] || 'TABLE';
  const ok = await runSqlDialog(db, `DROP ${t} ${qn(r.schema, r.name)};`, { title: `Drop ${t.toLowerCase()}`, danger: true, okLabel: 'Drop' });
  if (ok) {
    closeTab(`tbl:${db}:${r.schema}:${r.name}`);
    refreshTree();
  }
  return ok;
}

function createTableDialog(db, schema) {
  const name = h('input', { placeholder: 'table_name' });
  const schemaSel = h('select');
  rows(db, `select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' order by 1`).then((l) => {
    for (const s of l) schemaSel.appendChild(h('option', { selected: s.nspname === schema }, s.nspname));
  });
  const comment = h('input', { placeholder: 'optional' });
  const tbody = h('tbody');
  const dl = typeDatalist();
  const addRow = (c = {}) => {
    const tr = h('tr', null,
      h('td', null, h('input', { class: 'c-name', value: c.name || '' })),
      h('td', null, h('input', { class: 'c-type', value: c.type || 'text', list: dl })),
      h('td', null, h('input', { class: 'c-def', value: c.def || '', placeholder: 'default' })),
      h('td', { class: 'c' }, h('input', { type: 'checkbox', class: 'c-nn', checked: !!c.nn })),
      h('td', { class: 'c' }, h('input', { type: 'checkbox', class: 'c-pk', checked: !!c.pk })),
      h('td', { class: 'c' }, h('input', { type: 'checkbox', class: 'c-uq' })),
      h('td', null, h('button', { class: 'btn xs danger', onclick: () => tr.remove() }, '✕')));
    tbody.appendChild(tr);
  };
  addRow({ name: 'id', type: 'bigint GENERATED BY DEFAULT AS IDENTITY', pk: true, nn: true });
  addRow({ name: 'name', type: 'text' });
  addRow({ name: 'created_at', type: 'timestamptz', def: 'now()', nn: true });
  const table = h('table', { class: 'cols-editor' },
    h('thead', null, h('tr', null, ['Name', 'Type', 'Default', 'Not null', 'PK', 'Unique', ''].map((x) => h('th', null, x)))), tbody);
  modal({
    title: `Create table in ${db}`,
    size: 'xwide',
    body: [
      h('div', { class: 'grid3' }, h('label', null, 'Schema', schemaSel), h('label', null, 'Table name', name), h('label', null, 'Comment', comment)),
      h('h3', { style: { margin: '6px 0 0' } }, 'Columns'),
      table,
      h('div', null, btn('+ Add column', () => addRow())),
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Preview SQL',
        kind: 'primary',
        onClick: async (close) => {
          const n = name.value.trim();
          if (!n) return toast('Table name required', 'warn'), false;
          const cols = $$('tr', tbody).map((tr) => ({
            name: $('.c-name', tr).value.trim(),
            type: $('.c-type', tr).value.trim(),
            def: $('.c-def', tr).value.trim(),
            nn: $('.c-nn', tr).checked,
            pk: $('.c-pk', tr).checked,
            uq: $('.c-uq', tr).checked,
          })).filter((c) => c.name);
          if (!cols.length) return toast('Add at least one column', 'warn'), false;
          const rel = qn(schemaSel.value || schema, n);
          const lines = cols.map((c) => `  ${qi(c.name)} ${c.type}${c.def ? ' DEFAULT ' + c.def : ''}${c.nn && !c.pk ? ' NOT NULL' : ''}${c.uq ? ' UNIQUE' : ''}`);
          const pks = cols.filter((c) => c.pk);
          if (pks.length) lines.push(`  PRIMARY KEY (${pks.map((c) => qi(c.name)).join(', ')})`);
          let sql = `CREATE TABLE ${rel} (\n${lines.join(',\n')}\n);`;
          if (comment.value.trim()) sql += `\nCOMMENT ON TABLE ${rel} IS ${ql(comment.value.trim())};`;
          close();
          if (await runSqlDialog(db, sql, { title: 'Create table' })) {
            refreshTree();
            openTableTab(db, schemaSel.value || schema, n, 'r', 'structure');
          }
        },
      },
    ],
  });
}

function renderSchemas(pane, db, tabs) {
  fillPane(pane, async () => {
    const list = await rows(db, `
      select n.nspname as name, pg_get_userbyid(n.nspowner) as owner, obj_description(n.oid, 'pg_namespace') as comment,
             (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p')) as tables,
             (select coalesce(sum(pg_total_relation_size(c.oid)), 0) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p','m')) as size
        from pg_namespace n
       where ${S.showSystem ? 'true' : "n.nspname not like 'pg_%' and n.nspname <> 'information_schema'"}
       order by 1`);
    const create = async () => {
      const n = await promptDlg('Schema name', { title: 'Create schema' });
      if (n && (await runSqlDialog(db, `CREATE SCHEMA ${qi(n)};`, { title: 'Create schema' }))) {
        tabs.refresh();
        refreshTree();
      }
    };
    return h('div', null,
      sectionHead('Schemas', btn('+ Create schema', create, 'primary')),
      listTable(
        [
          { label: 'Name', render: (r) => h('b', null, r.name) },
          { key: 'owner', label: 'Owner' },
          { label: 'Tables', render: (r) => fmtNum(r.tables), class: 'right' },
          { label: 'Size', render: (r) => fmtBytes(r.size), class: 'right' },
          { key: 'comment', label: 'Comment', class: 'muted' },
        ],
        list,
        {
          actions: (r) => [
            btn('New table', () => createTableDialog(db, r.name)),
            btn('Rename', async () => {
              const n = await promptDlg('New name', { title: 'Rename schema', value: r.name });
              if (n && n !== r.name && (await runSqlDialog(db, `ALTER SCHEMA ${qi(r.name)} RENAME TO ${qi(n)};`))) {
                tabs.refresh();
                refreshTree();
              }
            }),
            btn('Drop', async () => {
              if (await runSqlDialog(db, `DROP SCHEMA ${qi(r.name)} CASCADE;`, { title: 'Drop schema (and everything in it)', danger: true, okLabel: 'Drop' })) {
                tabs.refresh();
                refreshTree();
              }
            }, 'danger'),
          ],
        }
      ));
  });
}

function renderRoutines(pane, db) {
  fillPane(pane, async () => {
    const list = await rows(db, `
      select p.oid::text as oid, n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
             pg_get_function_result(p.oid) as result, l.lanname as lang,
             case p.prokind when 'f' then 'function' when 'p' then 'procedure' when 'a' then 'aggregate' when 'w' then 'window' end as kind
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
       where ${S.showSystem ? 'true' : "n.nspname not in ('pg_catalog','information_schema')"}
         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       order by 2, 3 limit 2000`);
    const newFn = () =>
      openSqlTab(db, `CREATE OR REPLACE FUNCTION public.my_function(a integer, b integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN a + b;\nEND;\n$$;\n`);
    return h('div', null,
      sectionHead('Functions & procedures', btn('+ New function', newFn, 'primary')),
      listTable(
        [
          { key: 'schema', label: 'Schema', class: 'muted' },
          { label: 'Name', render: (r) => h('a', { onclick: () => openFunctionSql(db, r.oid) }, r.name) },
          { label: 'Arguments', render: (r) => h('span', { class: 'mono' }, r.args) },
          { label: 'Returns', render: (r) => h('span', { class: 'mono' }, r.result || '') },
          { key: 'kind', label: 'Kind' },
          { key: 'lang', label: 'Language' },
        ],
        list,
        {
          empty: 'No user-defined functions',
          actions: (r) => [
            btn('Edit', () => openFunctionSql(db, r.oid)),
            btn('Drop', () => runSqlDialog(db, `DROP ${r.kind === 'procedure' ? 'PROCEDURE' : r.kind === 'aggregate' ? 'AGGREGATE' : 'FUNCTION'} ${qn(r.schema, r.name)}(${r.args});`, { title: 'Drop', danger: true, okLabel: 'Drop' }).then((ok) => ok && (refreshTree(), renderRoutines(pane, db))), 'danger'),
          ],
        }
      ));
  });
}

async function openFunctionSql(db, oid) {
  try {
    const r = await one(db, `select case when p.prokind = 'a' then '-- aggregate: ' || p.oid::regprocedure::text else pg_get_functiondef(p.oid) end as def, p.proname as name from pg_proc p where p.oid = $1::oid`, [oid]);
    openSqlTab(db, r.def.trim() + ';\n', 'ƒ ' + r.name);
  } catch (e) {
    errorDlg(e);
  }
}

function renderExtensions(pane, db, tabs) {
  fillPane(pane, async () => {
    const list = await rows(db, `
      select a.name, a.default_version, a.installed_version, a.comment, e.extnamespace::regnamespace::text as schema
        from pg_available_extensions a left join pg_extension e on e.extname = a.name
       order by (a.installed_version is null), a.name`);
    const installed = list.filter((x) => x.installed_version);
    const avail = list.filter((x) => !x.installed_version);
    const search = h('input', { placeholder: 'Search available extensions…' });
    const availHolder = h('div');
    const paintAvail = () => {
      const f = search.value.toLowerCase();
      clear(availHolder).appendChild(
        listTable(
          [{ label: 'Name', render: (r) => h('b', null, r.name) }, { key: 'default_version', label: 'Version' }, { key: 'comment', label: 'Description', class: 'muted' }],
          avail.filter((r) => !f || r.name.includes(f) || (r.comment || '').toLowerCase().includes(f)),
          { actions: (r) => btn('Install', () => runSqlDialog(db, `CREATE EXTENSION IF NOT EXISTS ${qi(r.name)};`, { title: 'Install extension' }).then((ok) => ok && tabs.refresh()), 'primary') }
        )
      );
    };
    search.addEventListener('input', paintAvail);
    paintAvail();
    return h('div', null,
      sectionHead('Installed extensions'),
      listTable(
        [{ label: 'Name', render: (r) => h('b', null, r.name) }, { key: 'installed_version', label: 'Version' }, { key: 'schema', label: 'Schema' }, { key: 'comment', label: 'Description', class: 'muted' }],
        installed,
        {
          actions: (r) => [
            r.installed_version !== r.default_version ? btn('Update', () => runSqlDialog(db, `ALTER EXTENSION ${qi(r.name)} UPDATE;`).then((ok) => ok && tabs.refresh())) : null,
            r.name !== 'plpgsql' ? btn('Uninstall', () => runSqlDialog(db, `DROP EXTENSION ${qi(r.name)};`, { danger: true, okLabel: 'Uninstall' }).then((ok) => ok && tabs.refresh()), 'danger') : null,
          ],
        }
      ),
      sectionHead('Available extensions', search),
      availHolder);
  });
}

function renderDbMaintenance(pane, db) {
  fillPane(pane, async () => {
    const st = await one(db, `
      select pg_database_size(current_database()) as size, numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
             tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, conflicts, deadlocks, temp_bytes, stats_reset
        from pg_stat_database where datname = current_database()`);
    const hit = Number(st.blks_hit) + Number(st.blks_read) ? ((Number(st.blks_hit) / (Number(st.blks_hit) + Number(st.blks_read))) * 100).toFixed(2) + '%' : '—';
    const bloat = await rows(db, `
      select schemaname as schema, relname as name, n_live_tup as live, n_dead_tup as dead,
             round(100.0 * n_dead_tup / greatest(n_live_tup + n_dead_tup, 1), 1) as pct,
             greatest(last_vacuum, last_autovacuum) as last_vacuum, greatest(last_analyze, last_autoanalyze) as last_analyze
        from pg_stat_user_tables order by n_dead_tup desc limit 15`);
    const full = h('input', { type: 'checkbox' });
    const analyze = h('input', { type: 'checkbox', checked: true });
    const freeze = h('input', { type: 'checkbox' });
    const verbose = h('input', { type: 'checkbox' });
    const vacuum = () => {
      const o = [full.checked && 'FULL', freeze.checked && 'FREEZE', analyze.checked && 'ANALYZE', verbose.checked && 'VERBOSE'].filter(Boolean);
      runSqlDialog(db, `VACUUM${o.length ? ' (' + o.join(', ') + ')' : ''};`, { title: 'Vacuum database' });
    };
    return h('div', null,
      h('div', { class: 'cards' },
        statCard('Database size', fmtBytes(st.size)),
        statCard('Connections', fmtNum(st.numbackends)),
        statCard('Cache hit ratio', hit),
        statCard('Commits / Rollbacks', `${fmtNum(st.xact_commit)} / ${fmtNum(st.xact_rollback)}`, true),
        statCard('Rows ins / upd / del', `${fmtNum(st.tup_inserted)} / ${fmtNum(st.tup_updated)} / ${fmtNum(st.tup_deleted)}`, true),
        statCard('Deadlocks', fmtNum(st.deadlocks)),
        statCard('Temp bytes', fmtBytes(st.temp_bytes))),
      h('div', { class: 'card' },
        h('h3', null, 'Vacuum'),
        h('div', { class: 'flex' },
          h('label', { class: 'check' }, full, 'FULL (rewrites tables, exclusive lock)'),
          h('label', { class: 'check' }, analyze, 'ANALYZE'),
          h('label', { class: 'check' }, freeze, 'FREEZE'),
          h('label', { class: 'check' }, verbose, 'VERBOSE')),
        h('div', { class: 'btn-group mt' },
          btn('Run VACUUM on database', vacuum, 'primary'),
          btn('ANALYZE database', () => runSqlDialog(db, 'ANALYZE;', { title: 'Analyze' })),
          btn('REINDEX database', () => runSqlDialog(db, `REINDEX DATABASE ${qi(db)};`, { title: 'Reindex database' })),
          btn('Reset statistics', () => runSqlDialog(db, 'SELECT pg_stat_reset();', { title: 'Reset statistics' })))),
      sectionHead('Tables with most dead tuples'),
      listTable(
        [
          { label: 'Table', render: (r) => `${r.schema}.${r.name}` },
          { label: 'Live', render: (r) => fmtNum(r.live), class: 'right' },
          { label: 'Dead', render: (r) => fmtNum(r.dead), class: 'right' },
          { label: 'Dead %', render: (r) => r.pct + '%', class: 'right' },
          { key: 'last_vacuum', label: 'Last vacuum' },
          { key: 'last_analyze', label: 'Last analyze' },
        ],
        bloat,
        { actions: (r) => btn('Vacuum', () => runSqlDialog(db, `VACUUM (ANALYZE) ${qn(r.schema, r.name)};`)) }
      ));
  });
}

function renderBackup(pane, db) {
  fillPane(pane, async () => {
    const tools = await api.toolsInfo();
    const log = h('div', { class: 'log-box' });
    const appendLog = (t) => {
      log.textContent += t;
      log.scrollTop = log.scrollHeight;
    };
    let job = null;
    const off = api.onToolLog((d) => d.jobId === job && appendLog(d.text));
    void off;

    // Backup options
    const format = h('select', null,
      h('option', { value: 'p' }, 'Plain SQL (.sql)'),
      h('option', { value: 'c' }, 'Custom archive (.dump) — for pg_restore'),
      h('option', { value: 't' }, 'Tar archive (.tar)'));
    const scope = h('select', null, h('option', { value: '' }, 'Schema and data'), h('option', { value: '-s' }, 'Schema only'), h('option', { value: '-a' }, 'Data only'));
    const inserts = h('input', { type: 'checkbox' });
    const clean = h('input', { type: 'checkbox' });
    const create = h('input', { type: 'checkbox' });
    const noOwner = h('input', { type: 'checkbox' });
    const schemaOnly = h('input', { placeholder: 'e.g. public (optional)' });

    const runTool = async (tool, args, label) => {
      job = uid('job');
      log.textContent = `$ ${tool} ${args.join(' ')}\n`;
      setStatus(label + '…');
      const r = await api.runTool({ key: S.conn.key, tool, database: db, args, jobId: job });
      job = null;
      if (r.ok) {
        appendLog('\n✔ Completed successfully\n');
        toast(label + ' completed', 'ok');
      } else {
        appendLog('\n✘ ' + r.error.message + '\n');
        toast(label + ' failed', 'err');
      }
      setStatus('Ready');
      return r.ok;
    };

    const backup = async () => {
      const ext = { p: 'sql', c: 'dump', t: 'tar' }[format.value];
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const p = await api.saveDialog({ defaultPath: `${db}_${stamp}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (!p) return;
      const args = ['-F', format.value, '-f', p, '-v'];
      if (scope.value) args.push(scope.value);
      if (inserts.checked) args.push('--inserts');
      if (clean.checked) args.push('--clean', '--if-exists');
      if (create.checked) args.push('--create');
      if (noOwner.checked) args.push('--no-owner', '--no-privileges');
      if (schemaOnly.value.trim()) args.push('-n', schemaOnly.value.trim());
      if (await runTool('pg_dump', args, 'Backup')) api.showItem(p);
    };

    const rClean = h('input', { type: 'checkbox' });
    const rNoOwner = h('input', { type: 'checkbox', checked: true });
    const rStop = h('input', { type: 'checkbox', checked: true });
    const restore = async () => {
      const p = await api.openDialog({ filters: [{ name: 'Backups', extensions: ['sql', 'dump', 'backup', 'tar'] }, { name: 'All files', extensions: ['*'] }] });
      if (!p) return;
      if (!(await confirmDlg(`Restore "${p}" into database "${db}"?\n\nExisting objects may be modified.`, { title: 'Restore', okLabel: 'Restore', danger: true }))) return;
      if (/\.sql$/i.test(p)) {
        if (tools.psql) {
          const args = ['-f', p];
          if (rStop.checked) args.push('-v', 'ON_ERROR_STOP=1');
          await runTool('psql', args, 'Restore');
        } else {
          // built-in fallback: run the script directly
          log.textContent = 'psql not found — running the script with the built-in executor…\n';
          try {
            const text = await api.readFile(p);
            if (/^COPY .* FROM stdin;/m.test(text)) throw new Error('This dump uses COPY … FROM stdin which requires psql. Install postgresql-client, or create the dump with “Use INSERT statements”.');
            const r = await exec(db, text);
            appendLog(`✔ Executed ${r.results.length} statement(s) in ${fmtMs(r.duration)}\n`);
            toast('Restore completed', 'ok');
          } catch (e) {
            appendLog('✘ ' + errText(e) + '\n');
          }
        }
      } else {
        const args = ['-v'];
        if (rClean.checked) args.push('--clean', '--if-exists');
        if (rNoOwner.checked) args.push('--no-owner', '--no-privileges');
        if (rStop.checked) args.push('--exit-on-error');
        args.push(p);
        await runTool('pg_restore', args, 'Restore');
      }
      refreshTree();
    };

    const toolLine = (t) => (tools[t] ? h('div', null, h('span', { class: 'ok' }, '✔ '), h('code', null, tools[t].version || tools[t].path)) : h('div', null, h('span', { class: 'err' }, '✘ '), `${t} not found`));
    return h('div', { style: { maxWidth: '1000px' } },
      h('div', { class: 'card' },
        h('h3', null, 'PostgreSQL client tools'),
        toolLine('pg_dump'), toolLine('pg_restore'), toolLine('psql'),
        !tools.pg_dump ? h('p', { class: 'help' }, 'Install them with: ', h('code', null, 'sudo apt install postgresql-client')) : null,
        h('p', { class: 'help' }, 'Tip: pg_dump must be the same or a newer major version than the server.')),
      h('div', { class: 'card' },
        h('h3', null, `Backup “${db}”`),
        h('div', { class: 'grid2' },
          h('label', null, 'Format', format),
          h('label', null, 'Content', scope),
          h('label', null, 'Only schema', schemaOnly),
          h('div'),
          h('label', { class: 'check' }, inserts, 'Use INSERT statements instead of COPY'),
          h('label', { class: 'check' }, clean, 'Add DROP statements (--clean)'),
          h('label', { class: 'check' }, create, 'Include CREATE DATABASE'),
          h('label', { class: 'check' }, noOwner, 'Skip ownership & privileges')),
        h('div', { class: 'flex mt' }, h('button', { class: 'btn primary', onclick: backup, disabled: !tools.pg_dump }, 'Create backup…'))),
      h('div', { class: 'card' },
        h('h3', null, `Restore into “${db}”`),
        h('div', { class: 'flex' },
          h('label', { class: 'check' }, rClean, 'Drop objects before recreating (archives)'),
          h('label', { class: 'check' }, rNoOwner, 'Skip ownership & privileges (archives)'),
          h('label', { class: 'check' }, rStop, 'Stop on first error')),
        h('div', { class: 'flex mt' },
          h('button', { class: 'btn primary', onclick: restore }, 'Restore from file…'),
          btn('Cancel running job', () => job && api.killTool(job), 'danger')),
        h('p', { class: 'help' }, '.sql files are executed with psql; .dump/.tar archives with pg_restore.')),
      h('h3', null, 'Output'),
      log);
  });
}

function renderDbOps(pane, db) {
  fillPane(pane, async () => {
    const info = await one(S.conn.database, `
      select d.datname, pg_get_userbyid(d.datdba) as owner, pg_encoding_to_char(d.encoding) as encoding,
             d.datcollate as collate, d.datctype as ctype, d.datconnlimit as connlimit, shobj_description(d.oid, 'pg_database') as comment,
             pg_database_size(d.oid) as size
        from pg_database d where d.datname = $1`, [db]);
    const roles = await rows(S.conn.database, 'select rolname from pg_roles order by 1');
    const newName = h('input', { value: db });
    const owner = h('select', null, roles.map((r) => h('option', { selected: r.rolname === info.owner }, r.rolname)));
    const comment = h('input', { value: info.comment || '' });
    const force = h('input', { type: 'checkbox', checked: true });
    const admin = adminDb(db);

    const rename = async () => {
      const n = newName.value.trim();
      if (!n || n === db) return;
      await api.releaseDatabase({ key: S.conn.key, database: db });
      if (await runSqlDialog(admin, `ALTER DATABASE ${qi(db)} RENAME TO ${qi(n)};`, { title: 'Rename database' })) {
        closeDbTabs(db);
        refreshTree();
        openDatabaseTab(n);
      }
    };
    const drop = async () => {
      await api.releaseDatabase({ key: S.conn.key, database: db });
      const withForce = force.checked && S.conn.versionNum >= 130000;
      if (await runSqlDialog(admin, `DROP DATABASE ${qi(db)}${withForce ? ' WITH (FORCE)' : ''};`, { title: 'Drop database', danger: true, okLabel: 'Drop database' })) {
        closeDbTabs(db);
        refreshTree();
      }
    };
    return h('div', { style: { maxWidth: '900px' } },
      h('div', { class: 'card' },
        h('h3', null, 'Information'),
        h('div', { class: 'kv' },
          h('div', null, 'Owner'), h('div', null, info.owner),
          h('div', null, 'Encoding'), h('div', null, info.encoding),
          h('div', null, 'Collation / Ctype'), h('div', null, `${info.collate} / ${info.ctype}`),
          h('div', null, 'Connection limit'), h('div', null, info.connlimit === '-1' ? 'unlimited' : info.connlimit),
          h('div', null, 'Size'), h('div', null, fmtBytes(info.size)))),
      h('div', { class: 'card' },
        h('h3', null, 'Rename database'),
        h('div', { class: 'flex' }, newName, btn('Rename', rename)),
        h('p', { class: 'help' }, 'Nobody may be connected to the database while it is renamed.')),
      h('div', { class: 'card' },
        h('h3', null, 'Owner'),
        h('div', { class: 'flex' }, owner, btn('Change owner', () => runSqlDialog(admin, `ALTER DATABASE ${qi(db)} OWNER TO ${qi(owner.value)};`)))),
      h('div', { class: 'card' },
        h('h3', null, 'Comment'),
        h('div', { class: 'flex' }, comment, btn('Save', () => runSqlDialog(admin, `COMMENT ON DATABASE ${qi(db)} IS ${comment.value.trim() ? ql(comment.value.trim()) : 'NULL'};`)))),
      h('div', { class: 'card', style: { borderColor: 'var(--danger)' } },
        h('h3', { class: 'err' }, 'Drop database'),
        S.conn.versionNum >= 130000 ? h('label', { class: 'check' }, force, 'Terminate existing connections (WITH FORCE)') : null,
        h('div', { class: 'flex mt' }, btn('Drop this database', drop, 'danger'))));
  });
}

function closeDbTabs(db) {
  for (const t of [...S.tabs]) {
    if (t.id === `db:${db}` || t.id.startsWith(`tbl:${db}:`)) closeTab(t.id);
  }
}
