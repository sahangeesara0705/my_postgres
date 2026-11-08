'use strict';

const expanded = new Set(store('expanded') || []);
let activeNodeEl = null;

function treeNode(spec, depth = 0) {
  const wrap = h('div', { class: 'twrap' });
  const tw = h('span', { class: 'tw' }, spec.leaf ? '' : '▸');
  const cnt = h('span', { class: 'cnt' }, spec.count !== undefined ? String(spec.count) : '');
  const row = h('div', { class: 'tnode' + (spec.leaf ? ' leaf' : ''), style: { paddingLeft: 6 + depth * 14 + 'px' }, title: spec.title || spec.label },
    tw, h('span', { class: 'ic ' + (spec.iconClass || '') }, spec.icon || ''), h('span', { class: 'lb' }, spec.label), cnt);
  row.dataset.label = spec.label.toLowerCase();
  const kids = h('div', { class: 'tchildren collapsed' });
  appendTo(wrap, row, kids);
  let loaded = false;
  let open = false;

  async function expand() {
    if (spec.leaf) return;
    open = true;
    tw.textContent = '▾';
    kids.classList.remove('collapsed');
    if (spec.key) {
      expanded.add(spec.key);
      store('expanded', [...expanded]);
    }
    if (!loaded) await reload();
  }
  function collapse() {
    open = false;
    tw.textContent = '▸';
    kids.classList.add('collapsed');
    if (spec.key) {
      expanded.delete(spec.key);
      store('expanded', [...expanded]);
    }
  }
  async function reload() {
    loaded = true;
    row.classList.add('loading');
    tw.textContent = '◌';
    try {
      const children = await spec.load();
      clear(kids);
      if (!children.length) kids.appendChild(h('div', { class: 'tnode muted', style: { paddingLeft: 6 + (depth + 1) * 14 + 20 + 'px', cursor: 'default' } }, '(empty)'));
      for (const c of children) kids.appendChild(treeNode(c, depth + 1));
      applyTreeFilter();
    } catch (e) {
      clear(kids).appendChild(h('div', { class: 'tnode err', style: { paddingLeft: 6 + (depth + 1) * 14 + 'px' }, title: errText(e) }, '⚠ ' + e.message));
    } finally {
      row.classList.remove('loading');
      tw.textContent = open ? '▾' : '▸';
    }
  }
  wrap._reload = reload;

  row.addEventListener('click', (e) => {
    if (activeNodeEl) activeNodeEl.classList.remove('active');
    row.classList.add('active');
    activeNodeEl = row;
    if (e.target === tw || !spec.onClick) {
      if (!spec.leaf) open ? collapse() : expand();
      return;
    }
    spec.onClick();
    if (!spec.leaf && !open) expand();
  });
  row.addEventListener('dblclick', () => {
    if (spec.leaf && spec.onDblClick) spec.onDblClick();
  });
  if (spec.menu) row.addEventListener('contextmenu', (e) => contextMenu(e, spec.menu({ reload: () => (open ? reload() : null) })));
  if (spec.key && expanded.has(spec.key)) setTimeout(expand, 0);
  return wrap;
}

function dbNode(name) {
  return {
    key: 'db:' + name,
    label: name,
    icon: '🛢',
    iconClass: 'ic-db',
    onClick: () => openDatabaseTab(name),
    load: () => loadSchemas(name),
    menu: ({ reload }) => [
      { label: 'Open database', action: () => openDatabaseTab(name) },
      { label: 'New SQL editor', action: () => openSqlTab(name) },
      { label: 'Create table…', action: () => createTableDialog(name, 'public') },
      { label: 'Create schema…', action: () => openDatabaseTab(name, 'schemas') },
      '-',
      { label: 'Backup / Restore', action: () => openDatabaseTab(name, 'backup') },
      { label: 'Maintenance', action: () => openDatabaseTab(name, 'maint') },
      { label: 'Refresh', action: reload },
      '-',
      { label: 'Drop database…', danger: true, action: () => openDatabaseTab(name, 'ops') },
    ],
  };
}

async function loadSchemas(db) {
  const list = await rows(db, `
    select n.nspname as name,
           (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p','v','m','f') and not c.relispartition) as cnt
      from pg_namespace n
     where ${S.showSystem ? "n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'" : "n.nspname not like 'pg_%' and n.nspname <> 'information_schema'"}
     order by n.nspname = 'public' desc, n.nspname`);
  return list.map((s) => ({
    key: `sc:${db}:${s.name}`,
    label: s.name,
    icon: '◈',
    iconClass: 'ic-schema',
    count: s.cnt,
    load: () => loadSchemaObjects(db, s.name),
    menu: ({ reload }) => [
      { label: 'Create table…', action: () => createTableDialog(db, s.name) },
      { label: 'Create view…', action: () => openSqlTab(db, `CREATE VIEW ${qn(s.name, 'new_view')} AS\nSELECT 1 AS col;\n`) },
      { label: 'New SQL editor', action: () => openSqlTab(db, `SET search_path TO ${qi(s.name)}, public;\n\n`) },
      { label: 'Refresh', action: reload },
      '-',
      {
        label: 'Drop schema…',
        danger: true,
        action: () => runSqlDialog(db, `DROP SCHEMA ${qi(s.name)} CASCADE;`, { danger: true, okLabel: 'Drop', title: 'Drop schema' }).then((ok) => ok && refreshTree()),
      },
    ],
  }));
}

async function loadSchemaObjects(db, schema) {
  const [rels, funcs] = await Promise.all([
    rows(db, `
      select c.relname as name, c.relkind as kind
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relkind in ('r','p','v','m','f','S') and not c.relispartition
       order by c.relname`, [schema]),
    rows(db, `
      select p.oid::text as oid, p.proname as name, pg_get_function_identity_arguments(p.oid) as args, p.prokind as kind
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = $1
         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       order by p.proname limit 1000`, [schema]),
  ]);
  const by = (k) => rels.filter((r) => k.includes(r.kind));
  const relLeaf = (r) => ({
    label: r.name,
    leaf: true,
    icon: r.kind === 'v' ? '◉' : r.kind === 'm' ? '◎' : '▦',
    iconClass: r.kind === 'v' ? 'ic-view' : r.kind === 'm' ? 'ic-mview' : 'ic-table',
    onClick: () => openTableTab(db, schema, r.name, r.kind, 'browse'),
    menu: () => [
      { label: 'Browse', action: () => openTableTab(db, schema, r.name, r.kind, 'browse') },
      { label: 'Structure', action: () => openTableTab(db, schema, r.name, r.kind, 'structure') },
      r.kind === 'r' || r.kind === 'p' ? { label: 'Insert row', action: () => openTableTab(db, schema, r.name, r.kind, 'insert') } : null,
      { label: 'SELECT in SQL editor', action: () => openSqlTab(db, `SELECT *\nFROM ${qn(schema, r.name)}\nLIMIT 100;`) },
      { label: 'Export…', action: () => openTableTab(db, schema, r.name, r.kind, 'export') },
      r.kind === 'r' || r.kind === 'p' ? { label: 'Import CSV…', action: () => openTableTab(db, schema, r.name, r.kind, 'import') } : null,
      { label: 'Show DDL', action: () => openTableTab(db, schema, r.name, r.kind, 'ddl') },
      '-',
      { label: 'Operations…', action: () => openTableTab(db, schema, r.name, r.kind, 'operations') },
      r.kind === 'r' || r.kind === 'p'
        ? { label: 'Empty (truncate)…', danger: true, action: () => runSqlDialog(db, `TRUNCATE TABLE ${qn(schema, r.name)};`, { danger: true, okLabel: 'Truncate', title: 'Empty table' }) }
        : null,
      { label: 'Drop…', danger: true, action: () => dropRelation(db, { schema, name: r.name, kind: r.kind }) },
    ],
  });
  const folder = (label, key, items, icon, cls) => ({
    key: `f:${db}:${schema}:${key}`,
    label,
    icon,
    iconClass: cls,
    count: items.length,
    load: async () => items,
  });
  const out = [];
  const tables = by('rpf').map(relLeaf);
  out.push(folder('Tables', 'tables', tables, '▤', 'ic-folder'));
  const views = by('v').map(relLeaf);
  if (views.length || S.showSystem) out.push(folder('Views', 'views', views, '▤', 'ic-folder'));
  const mviews = by('m').map(relLeaf);
  if (mviews.length) out.push(folder('Materialized views', 'mviews', mviews, '▤', 'ic-folder'));
  const fn = funcs.map((f) => ({
    label: `${f.name}(${f.args})`,
    leaf: true,
    icon: 'ƒ',
    iconClass: 'ic-func',
    onClick: () => openFunctionSql(db, f.oid),
    menu: () => [
      { label: 'Edit definition', action: () => openFunctionSql(db, f.oid) },
      {
        label: 'Drop…',
        danger: true,
        action: () =>
          runSqlDialog(db, `DROP ${f.kind === 'p' ? 'PROCEDURE' : f.kind === 'a' ? 'AGGREGATE' : 'FUNCTION'} ${qn(schema, f.name)}(${f.args});`, { danger: true, okLabel: 'Drop', title: 'Drop' }).then((ok) => ok && refreshTree()),
      },
    ],
  }));
  if (fn.length) out.push(folder('Functions', 'funcs', fn, '▤', 'ic-folder'));
  const seqs = by('S').map((s) => ({
    label: s.name,
    leaf: true,
    icon: '#',
    iconClass: 'ic-seq',
    onClick: () => openSqlTab(db, `SELECT * FROM ${qn(schema, s.name)};\n\n-- ALTER SEQUENCE ${qn(schema, s.name)} RESTART WITH 1;\n`),
    menu: () => [
      { label: 'Show', action: () => openSqlTab(db, `SELECT * FROM ${qn(schema, s.name)};`) },
      {
        label: 'Reset…',
        action: async () => {
          const v = await promptDlg('Restart with value', { title: 'Reset sequence', value: '1' });
          if (v) runSqlDialog(db, `ALTER SEQUENCE ${qn(schema, s.name)} RESTART WITH ${Number(v) || 1};`);
        },
      },
      { label: 'Drop…', danger: true, action: () => runSqlDialog(db, `DROP SEQUENCE ${qn(schema, s.name)};`, { danger: true, okLabel: 'Drop' }).then((ok) => ok && refreshTree()) },
    ],
  }));
  if (seqs.length) out.push(folder('Sequences', 'seqs', seqs, '▤', 'ic-folder'));
  return out;
}

async function refreshTree() {
  const tree = $('#tree');
  const scroll = tree.scrollTop;
  try {
    const dbs = await rows(S.conn.database, `select datname from pg_database where datallowconn ${S.showSystem ? '' : 'and not datistemplate'} order by datname`);
    clear(tree);
    tree.appendChild(
      treeNode({
        key: 'server',
        label: S.conn.name,
        icon: '🖥',
        count: dbs.length,
        onClick: () => openServerTab(),
        load: async () => dbs.map((d) => dbNode(d.datname)),
        menu: () => [
          { label: 'Server overview', action: () => openServerTab('overview') },
          { label: 'Create database…', action: () => createDatabaseDialog() },
          { label: 'Activity', action: () => openServerTab('activity') },
          { label: 'Users & roles', action: () => openServerTab('roles') },
          { label: 'Refresh', action: refreshTree },
        ],
      })
    );
    if (!expanded.has('server')) {
      expanded.add('server');
      tree.firstChild.querySelector('.tnode').click();
    }
    setTimeout(() => (tree.scrollTop = scroll), 300);
  } catch (e) {
    clear(tree).appendChild(h('div', { class: 'err-box', style: { margin: '8px' } }, errText(e)));
  }
}

function applyTreeFilter() {
  const f = $('#tree-filter').value.trim().toLowerCase();
  $$('#tree .tnode.leaf').forEach((n) => n.parentElement.classList.toggle('hidden', !!f && !n.dataset.label.includes(f)));
}
