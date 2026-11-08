'use strict';

const KIND_LABEL = { r: 'table', p: 'partitioned table', v: 'view', m: 'materialized view', f: 'foreign table' };

async function tableMeta(db, schema, name) {
  const rel = qn(schema, name);
  const [cols, info, pk, cons] = await Promise.all([
    rows(
      db,
      `select a.attnum::int as num, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
              t.typname as typname, t.typcategory as cat, a.attnotnull as notnull,
              pg_get_expr(d.adbin, d.adrelid) as def, col_description(a.attrelid, a.attnum) as comment,
              a.attidentity as identity, a.attgenerated as generated,
              (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = a.atttypid)::text as enums
         from pg_attribute a
         join pg_type t on t.oid = a.atttypid
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
      [rel]
    ),
    one(
      db,
      `select c.oid::int as oid, c.relkind as kind, c.reltuples::bigint as est, obj_description(c.oid, 'pg_class') as comment,
              pg_get_userbyid(c.relowner) as owner, pg_total_relation_size(c.oid) as total, pg_relation_size(c.oid) as data,
              pg_indexes_size(c.oid) as idx, c.relispartition as ispart, c.relpersistence as persistence
         from pg_class c where c.oid = $1::regclass`,
      [rel]
    ),
    rows(
      db,
      `select a.attname as name from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = $1::regclass and i.indisprimary
        order by array_position(i.indkey::int2[], a.attnum)`,
      [rel]
    ),
    rows(
      db,
      `select conname as name, contype as type, pg_get_constraintdef(oid, true) as def,
              (select array_agg(a.attname) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey))::text as cols
         from pg_constraint c where conrelid = $1::regclass order by contype, conname`,
      [rel]
    ),
  ]);
  for (const c of cols) c.enums = c.enums ? JSON.parse(c.enums) : null;
  const colFlags = {};
  for (const c of cons) {
    const names = c.cols ? c.cols.replace(/^\{|\}$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')) : [];
    for (const n of names) (colFlags[n] = colFlags[n] || new Set()).add(c.type);
  }
  return { rel, cols, info, pk: pk.map((p) => p.name), cons, colFlags };
}

function openTableTab(db, schema, name, kind = 'r', initialSub) {
  const id = `tbl:${db}:${schema}:${name}`;
  if (activateTab(id, initialSub)) return;
  const pane = h('div', { class: 'tabpane' });
  const ctx = { db, schema, name, kind, rel: qn(schema, name), meta: null };

  const head = h('div', { class: 'view-head' },
    h('div', { class: 'crumbs' },
      h('a', { onclick: () => openDatabaseTab(db) }, db), h('span', { class: 'sep' }, '›'),
      h('span', null, schema), h('span', { class: 'sep' }, '›'),
      h('span', null, name), h('span', { class: 'kind' }, KIND_LABEL[kind] || kind)),
    h('span', { class: 'spacer' }),
    btn('SQL', () => openSqlTab(db, `SELECT *\nFROM ${ctx.rel}\nLIMIT 100;`)),
    btn('Refresh', () => reload())
  );
  pane.appendChild(head);
  const body = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
  pane.appendChild(body);

  let tabs;
  async function reload(sub) {
    clear(body).appendChild(loadingPane());
    try {
      ctx.meta = await tableMeta(db, schema, name);
      ctx.kind = ctx.meta.info.kind;
    } catch (e) {
      clear(body).appendChild(h('div', { class: 'subpane' }, h('div', { class: 'err-box' }, errText(e))));
      return;
    }
    clear(body);
    const isTable = ctx.kind === 'r' || ctx.kind === 'p';
    const list = [
      { id: 'browse', label: 'Browse', flush: true, render: (p) => renderBrowse(p, ctx) },
      { id: 'structure', label: 'Structure', render: (p) => renderStructure(p, ctx, reload) },
      isTable ? { id: 'insert', label: 'Insert', render: (p) => renderInsertPane(p, ctx) } : null,
      { id: 'export', label: 'Export', render: (p) => renderExport(p, ctx) },
      isTable ? { id: 'import', label: 'Import', render: (p) => renderImport(p, ctx) } : null,
      { id: 'operations', label: 'Operations', render: (p) => renderTableOps(p, ctx, reload) },
      { id: 'ddl', label: 'DDL', render: (p) => renderDdl(p, ctx) },
    ].filter(Boolean);
    tabs = subTabs(body, list, sub || (tabs && tabs.current) || initialSub);
    ctx.tabs = tabs;
  }
  ctx.reload = reload;

  addTab({
    id,
    title: name,
    icon: kind === 'v' ? '👁' : '▦',
    pane,
    onActivate: (sub) => sub && tabs && tabs.show(sub),
  });
  reload(initialSub);
}

/* ------------------------------------------------------------------ */
/* Browse                                                              */
/* ------------------------------------------------------------------ */
function renderBrowse(pane, ctx) {
  const { db, meta } = ctx;
  const editable = ctx.kind === 'r' || ctx.kind === 'p';
  const usePk = meta.pk.length > 0;
  const st = { page: 0, limit: Number(store('pageSize')) || 50, sort: null, where: '', total: null };

  const whereIn = h('input', { class: 'filter', placeholder: 'WHERE …   e.g.  id > 10 AND name ILIKE \'%abc%\'' });
  const colSel = h('select', null, h('option', { value: '' }, 'Quick filter…'), meta.cols.map((c) => h('option', { value: c.name }, c.name)));
  const opSel = h('select', null, ['=', '<>', '>', '<', '>=', '<=', 'ILIKE', 'LIKE', 'IS NULL', 'IS NOT NULL', 'IN'].map((o) => h('option', null, o)));
  const valIn = h('input', { placeholder: 'value', style: { width: '140px' } });
  const limitSel = h('select', null, [25, 50, 100, 250, 500, 1000].map((n) => h('option', { value: n, selected: n === st.limit }, n + ' / page')));
  const pageIn = h('input', { value: '1' });
  const pageInfo = h('span', { class: 'muted' });
  const foot = h('div', { class: 'grid-foot' });
  const gridHolder = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
  let grid = null;
  let cur = null; // current result {fields, rows}

  const toolbar = h('div', { class: 'toolbar' },
    editable ? btn('+ Insert row', () => rowForm(ctx, null, null, load), 'primary') : null,
    editable ? btn('Delete selected', () => deleteRows(grid ? grid.getSelected() : []), 'danger') : null,
    btn('⟳', () => load(), '', 'Refresh'),
    h('span', { class: 'sep' }),
    whereIn,
    btn('Apply', () => { st.where = whereIn.value.trim(); st.page = 0; load(); }),
    btn('Clear', () => { whereIn.value = ''; st.where = ''; st.page = 0; load(); }, 'ghost'),
    h('span', { class: 'sep' }),
    colSel, opSel, valIn, btn('Add', () => addQuick())
  );
  const pager = h('div', { class: 'pager' },
    btn('«', () => go(0)), btn('‹', () => go(st.page - 1)),
    'Page', pageIn, pageInfo,
    btn('›', () => go(st.page + 1)), btn('»', () => go(Infinity)),
    limitSel);
  appendTo(pane, toolbar, gridHolder, foot);

  whereIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { st.where = whereIn.value.trim(); st.page = 0; load(); } });
  pageIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(Number(pageIn.value) - 1); });
  limitSel.addEventListener('change', () => { st.limit = Number(limitSel.value); store('pageSize', st.limit); st.page = 0; load(); });

  function addQuick() {
    const c = colSel.value;
    if (!c) return;
    const op = opSel.value;
    let cond;
    if (op === 'IS NULL' || op === 'IS NOT NULL') cond = `${qi(c)} ${op}`;
    else if (op === 'IN') cond = `${qi(c)} IN (${valIn.value.split(',').map((v) => ql(v.trim())).join(', ')})`;
    else if (op === 'ILIKE' || op === 'LIKE') cond = `${qi(c)}::text ${op} ${ql(valIn.value.includes('%') ? valIn.value : '%' + valIn.value + '%')}`;
    else cond = `${qi(c)} ${op} ${ql(valIn.value)}`;
    whereIn.value = whereIn.value.trim() ? `${whereIn.value.trim()} AND ${cond}` : cond;
    st.where = whereIn.value;
    st.page = 0;
    load();
  }
  function go(p) {
    const pages = st.total === null ? Infinity : Math.max(1, Math.ceil(st.total / st.limit));
    st.page = Math.max(0, Math.min(p, pages - 1));
    if (!isFinite(st.page)) st.page = 0;
    load();
  }

  const idSelect = usePk || !editable ? '' : 't.tableoid::text as "__mp_tableoid", t.ctid::text as "__mp_ctid", ';
  const hiddenCount = idSelect ? 2 : 0;

  async function load() {
    const where = st.where ? `WHERE ${st.where}` : '';
    const order = st.sort ? `ORDER BY ${qi(st.sort.col)} ${st.sort.dir} NULLS LAST` : usePk ? `ORDER BY ${meta.pk.map(qi).join(', ')}` : '';
    const sql = `SELECT ${idSelect}t.* FROM ${ctx.rel} t ${where} ${order} LIMIT ${st.limit} OFFSET ${st.page * st.limit}`;
    clear(gridHolder).appendChild(loadingPane());
    try {
      const t0 = Date.now();
      const est = Number(meta.info.est);
      const countP = !st.where && est > 1000000
        ? Promise.resolve({ c: est, approx: true })
        : one(db, `SELECT count(*) as c FROM ${ctx.rel} t ${where}`).then((r) => ({ c: Number(r.c) }));
      const [r, cnt] = await Promise.all([runSql(db, sql), countP]);
      st.total = cnt.c;
      const res = r.results[0];
      cur = res;
      const types = {};
      for (const c of meta.cols) types[c.name] = c.type + (meta.pk.includes(c.name) ? ' · PK' : '');
      const hidden = new Set([...Array(hiddenCount).keys()]);
      grid = dataGrid({
        fields: res.fields,
        rows: res.rows,
        types,
        hidden,
        startIndex: st.page * st.limit,
        sort: st.sort,
        editable,
        selectable: editable,
        onSort: (col) => {
          if (!st.sort || st.sort.col !== col) st.sort = { col, dir: 'ASC' };
          else if (st.sort.dir === 'ASC') st.sort.dir = 'DESC';
          else st.sort = null;
          load();
        },
        onFilter: (col, v) => {
          const cond = v === null ? `${qi(col)} IS NULL` : `${qi(col)} = ${ql(v)}`;
          whereIn.value = whereIn.value.trim() ? `${whereIn.value.trim()} AND ${cond}` : cond;
          st.where = whereIn.value;
          st.page = 0;
          load();
        },
        onCellEdit: (ri, ci, val) => updateCell(ri, ci, val),
        onRowEdit: (ri) => rowForm(ctx, rowObj(ri), whereFor(ri), load),
        onRowDelete: (ri) => deleteRows([ri]),
      });
      clear(gridHolder).appendChild(grid.el);
      const pages = Math.max(1, Math.ceil(st.total / st.limit));
      pageIn.value = st.page + 1;
      pageInfo.textContent = `of ${fmtNum(pages)}`;
      appendTo(clear(foot), 
        h('span', null, `${cnt.approx ? '~' : ''}${fmtNum(st.total)} rows total · showing ${fmtNum(res.rows.length)} · ${fmtMs(Date.now() - t0)}`),
        !usePk && editable ? h('span', { class: 'warn', title: 'Rows are identified by their physical location (ctid). Add a primary key for reliable editing.' }, '⚠ no primary key') : null,
        h('span', { class: 'spacer' }),
        pager
      );
    } catch (e) {
      clear(gridHolder).appendChild(h('div', { class: 'res-msg err' }, errText(e)));
    }
  }

  function rowObj(ri) {
    const o = {};
    cur.fields.forEach((f, i) => { if (i >= hiddenCount) o[f.name] = cur.rows[ri][i]; });
    return o;
  }
  // returns {sql, params}
  function whereFor(ri, startParam = 1) {
    const row = cur.rows[ri];
    if (usePk) {
      const params = [];
      const parts = meta.pk.map((c) => {
        const idx = cur.fields.findIndex((f, i) => i >= hiddenCount && f.name === c);
        params.push(row[idx]);
        return `${qi(c)} = $${startParam + params.length - 1}`;
      });
      return { sql: parts.join(' AND '), params, literal: meta.pk.map((c) => `${qi(c)} = ${ql(row[cur.fields.findIndex((f, i) => i >= hiddenCount && f.name === c)])}`).join(' AND ') };
    }
    return {
      sql: `tableoid = $${startParam}::oid AND ctid = $${startParam + 1}::tid`,
      params: [row[0], row[1]],
      literal: `tableoid = ${ql(row[0])}::oid AND ctid = ${ql(row[1])}::tid`,
      ctid: true,
      onNewCtid: (ctid) => (row[1] = ctid),
    };
  }

  async function updateCell(ri, ci, val) {
    const col = cur.fields[ci].name;
    const w = whereFor(ri, 2);
    try {
      const r = await runSql(db, `UPDATE ${ctx.rel} SET ${qi(col)} = $1 WHERE ${w.sql} RETURNING ctid::text`, [val, ...w.params]);
      const res = r.results[0];
      if (!res.rowCount) {
        toast('No row was updated — it may have been changed or deleted by someone else. Refresh the data.', 'warn');
        return false;
      }
      if (w.ctid) w.onNewCtid(res.rows[0][0]);
      setStatus(`Updated ${col}`);
      return true;
    } catch (e) {
      errorDlg(e, 'Update failed');
      return false;
    }
  }

  async function deleteRows(idxs) {
    if (!idxs.length) return toast('Select one or more rows first (use the checkboxes).', 'warn');
    const conds = idxs.map((ri) => '(' + whereFor(ri).literal + ')');
    const sql = `DELETE FROM ${ctx.rel}\nWHERE ${conds.join('\n   OR ')};`;
    if (await runSqlDialog(db, sql, { title: `Delete ${idxs.length} row(s)`, okLabel: 'Delete', danger: true, success: `Deleted ${idxs.length} row(s)` })) load();
  }

  load();
}

/* ------------------------------------------------------------------ */
/* Row form (insert / edit)                                            */
/* ------------------------------------------------------------------ */
function buildRowForm(ctx, values) {
  const { meta } = ctx;
  const isInsert = !values;
  const grid = h('div', { class: 'row-form' },
    h('div', { class: 'h' }, 'Column'), h('div', { class: 'h', style: { textAlign: 'center' } }, 'NULL'),
    h('div', { class: 'h', style: { textAlign: 'center' } }, isInsert ? 'Default' : ''), h('div', { class: 'h' }, 'Value'));
  const inputs = [];
  for (const c of meta.cols) {
    const orig = values ? values[c.name] : undefined;
    const generated = c.generated === 's';
    let input;
    if (c.typname === 'bool') {
      input = h('select', null, h('option', { value: 't' }, 'true'), h('option', { value: 'f' }, 'false'));
      input.value = orig === 'f' ? 'f' : 't';
    } else if (c.enums) {
      input = h('select', null, c.enums.map((e) => h('option', { value: e }, e)));
      if (orig !== undefined && orig !== null) input.value = orig;
    } else {
      input = h('textarea', { rows: 1, placeholder: c.def && isInsert ? `default: ${c.def}` : '' });
      input.value = orig === null || orig === undefined ? '' : orig;
      if (input.value.length > 80 || input.value.includes('\n') || c.cat === 'U') input.style.height = '70px';
    }
    const nullCk = h('input', { type: 'checkbox', disabled: c.notnull, checked: !isInsert && orig === null });
    const hasDefault = !!c.def || !!c.identity || generated;
    const defCk = isInsert ? h('input', { type: 'checkbox', checked: hasDefault, disabled: generated }) : null;
    const sync = () => {
      input.disabled = nullCk.checked || (defCk && defCk.checked) || generated;
    };
    nullCk.addEventListener('change', () => { if (nullCk.checked && defCk) defCk.checked = false; sync(); });
    if (defCk) defCk.addEventListener('change', () => { if (defCk.checked) nullCk.checked = false; sync(); });
    input.addEventListener('focus', () => {
      if (defCk && defCk.checked && !generated) { defCk.checked = false; sync(); }
    });
    sync();
    const flags = meta.colFlags[c.name] || new Set();
    appendTo(grid, 
      h('div', { class: 'cn', title: c.comment || '' }, c.name,
        meta.pk.includes(c.name) ? h('span', { class: 'badge pk', style: { marginLeft: '6px' } }, 'PK') : null,
        flags.has('f') ? h('span', { class: 'badge fk', style: { marginLeft: '4px' } }, 'FK') : null,
        h('small', null, c.type + (generated ? ' (generated)' : ''))),
      h('div', { class: 'cb' }, nullCk),
      h('div', { class: 'cb' }, defCk || ''),
      input
    );
    // Allow clicking disabled input to enable
    inputs.push({ c, input, nullCk, defCk, orig, generated });
  }
  return { el: grid, inputs };
}

function collectRow(inputs, isInsert) {
  const cols = [];
  const vals = [];
  for (const it of inputs) {
    if (it.generated) continue;
    if (isInsert && it.defCk && it.defCk.checked) continue;
    let v = it.nullCk.checked ? null : it.input.value;
    // An empty field on a non-text column means "no value" rather than an empty string
    if (v === '' && it.c.cat !== 'S' && !isTrue(it.c.notnull) && (isInsert || it.orig === null)) v = null;
    if (!isInsert && v === it.orig) continue;
    cols.push(it.c.name);
    vals.push(v);
  }
  return { cols, vals };
}

function rowForm(ctx, values, where, onDone) {
  const isInsert = !values;
  const { el, inputs } = buildRowForm(ctx, values);
  const errBox = h('div', { class: 'err-box hidden' });
  const again = isInsert ? h('label', { class: 'check' }, h('input', { type: 'checkbox' }), 'Insert another row after this') : null;
  let changed = false;
  modal({
    title: isInsert ? `Insert into ${ctx.name}` : `Edit row in ${ctx.name}`,
    size: 'wide',
    body: [el, errBox],
    footLeft: again,
    buttons: [
      { label: 'Cancel' },
      {
        label: isInsert ? 'Insert' : 'Save changes',
        kind: 'primary',
        onClick: async () => {
          errBox.classList.add('hidden');
          const { cols, vals } = collectRow(inputs, isInsert);
          try {
            if (isInsert) {
              const sql = cols.length
                ? `INSERT INTO ${ctx.rel} (${cols.map(qi).join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`
                : `INSERT INTO ${ctx.rel} DEFAULT VALUES`;
              await runSql(ctx.db, sql, vals);
              toast('Row inserted', 'ok');
              changed = true;
              if (again.querySelector('input').checked) {
                for (const it of inputs) if (it.input.tagName === 'TEXTAREA') it.input.value = '';
                return false;
              }
            } else {
              if (!cols.length) return toast('Nothing changed', 'info');
              const sql = `UPDATE ${ctx.rel} SET ${cols.map((c, i) => `${qi(c)} = $${i + 1}`).join(', ')} WHERE ${where.literal}`;
              const r = await runSql(ctx.db, sql, vals);
              if (!r.results[0].rowCount) throw new Error('No row was updated. The row may have changed; refresh and try again.');
              toast('Row updated', 'ok');
              changed = true;
            }
          } catch (e) {
            errBox.textContent = errText(e);
            errBox.classList.remove('hidden');
            return false;
          }
        },
      },
    ],
    onClose: () => changed && onDone && onDone(),
  });
}

function renderInsertPane(pane, ctx) {
  const { el, inputs } = buildRowForm(ctx, null);
  const errBox = h('div', { class: 'err-box hidden' });
  const go = async () => {
    errBox.classList.add('hidden');
    const { cols, vals } = collectRow(inputs, true);
    const sql = cols.length
      ? `INSERT INTO ${ctx.rel} (${cols.map(qi).join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`
      : `INSERT INTO ${ctx.rel} DEFAULT VALUES`;
    try {
      await runSql(ctx.db, sql, vals);
      toast('Row inserted', 'ok');
      for (const it of inputs) if (it.input.tagName === 'TEXTAREA') it.input.value = '';
      ctx.tabs.invalidate('browse');
    } catch (e) {
      errBox.textContent = errText(e);
      errBox.classList.remove('hidden');
    }
  };
  appendTo(pane, h('div', { class: 'card' }, h('h3', null, `Insert a new row into ${ctx.schema}.${ctx.name}`), el, h('div', { class: 'mt' }, errBox), h('div', { class: 'flex mt' }, h('button', { class: 'btn primary', onclick: go }, 'Insert row'))));
}

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */
function renderStructure(pane, ctx, reload) {
  fillPane(pane, async () => {
    const { db, meta, rel } = ctx;
    const isTable = ctx.kind === 'r' || ctx.kind === 'p';
    const [indexes, triggers] = await Promise.all([
      rows(db, `select c.relname as name, pg_get_indexdef(i.indexrelid) as def, i.indisunique as uniq, i.indisprimary as pk,
                       pg_relation_size(i.indexrelid) as size, i.indisvalid as valid,
                       (select count(*) from pg_constraint k where k.conindid = i.indexrelid) > 0 as constraint_backed,
                       coalesce(s.idx_scan, 0) as scans
                  from pg_index i join pg_class c on c.oid = i.indexrelid
                  left join pg_stat_all_indexes s on s.indexrelid = i.indexrelid
                 where i.indrelid = $1::regclass order by i.indisprimary desc, c.relname`, [rel]),
      rows(db, `select tgname as name, pg_get_triggerdef(t.oid, true) as def, tgenabled as enabled
                  from pg_trigger t where tgrelid = $1::regclass and not tgisinternal order by tgname`, [rel]),
    ]);
    const frag = h('div');

    // Columns
    appendTo(frag, 
      sectionHead('Columns',
        isTable ? btn('+ Add column', () => columnDialog(ctx, null, reload), 'primary') : null),
      listTable(
        [
          { key: 'num', label: '#', class: 'muted' },
          {
            label: 'Name',
            render: (c) => {
              const f = meta.colFlags[c.name] || new Set();
              return h('span', null, h('b', null, c.name), ' ',
                f.has('p') ? h('span', { class: 'badge pk' }, 'PK') : null,
                f.has('f') ? h('span', { class: 'badge fk' }, 'FK') : null,
                f.has('u') ? h('span', { class: 'badge uq' }, 'UNIQUE') : null);
            },
          },
          { label: 'Type', render: (c) => h('span', { class: 'mono' }, c.type) },
          { label: 'Nullable', render: (c) => (isTrue(c.notnull) ? h('span', { class: 'muted' }, 'NOT NULL') : 'yes') },
          {
            label: 'Default',
            render: (c) => h('span', { class: 'mono' },
              c.identity === 'a' ? 'GENERATED ALWAYS AS IDENTITY' : c.identity === 'd' ? 'GENERATED BY DEFAULT AS IDENTITY' : c.generated === 's' ? `GENERATED (${c.def}) STORED` : c.def || ''),
          },
          { key: 'comment', label: 'Comment', class: 'muted' },
        ],
        meta.cols,
        {
          actions: isTable
            ? (c) => [
                btn('Edit', () => columnDialog(ctx, c, reload)),
                btn('Index', () => indexDialog(ctx, [c.name], reload)),
                btn('Drop', () => runSqlDialog(db, `ALTER TABLE ${rel} DROP COLUMN ${qi(c.name)};`, { title: 'Drop column', danger: true, okLabel: 'Drop' }).then((ok) => ok && reload('structure')), 'danger'),
              ]
            : null,
          onRowDblClick: isTable ? (c) => columnDialog(ctx, c, reload) : null,
        }
      )
    );

    if (isTable || ctx.kind === 'm') {
      appendTo(frag, 
        sectionHead('Indexes', btn('+ Create index', () => indexDialog(ctx, [], reload), 'primary')),
        listTable(
          [
            { label: 'Name', render: (i) => h('b', null, i.name) },
            { label: 'Definition', render: (i) => h('span', { class: 'mono' }, i.def) },
            {
              label: 'Flags',
              render: (i) => [
                isTrue(i.pk) ? h('span', { class: 'badge pk' }, 'PRIMARY') : null,
                isTrue(i.uniq) && !isTrue(i.pk) ? h('span', { class: 'badge uq' }, 'UNIQUE') : null,
                !isTrue(i.valid) ? h('span', { class: 'badge err' }, 'INVALID') : null,
              ],
            },
            { label: 'Size', render: (i) => fmtBytes(i.size), class: 'right nowrap' },
            { label: 'Scans', render: (i) => fmtNum(i.scans), class: 'right' },
          ],
          indexes,
          {
            empty: 'No indexes',
            actions: (i) => [
              btn('Reindex', () => runSqlDialog(db, `REINDEX INDEX ${qn(ctx.schema, i.name)};`, { title: 'Reindex' })),
              isTrue(i.constraint_backed)
                ? null
                : btn('Drop', () => runSqlDialog(db, `DROP INDEX ${qn(ctx.schema, i.name)};`, { title: 'Drop index', danger: true, okLabel: 'Drop' }).then((ok) => ok && reload('structure')), 'danger'),
            ],
          }
        )
      );
    }

    if (isTable) {
      const typeName = { p: 'PRIMARY KEY', f: 'FOREIGN KEY', u: 'UNIQUE', c: 'CHECK', x: 'EXCLUDE', t: 'TRIGGER', n: 'NOT NULL' };
      appendTo(frag, 
        sectionHead('Constraints', btn('+ Add constraint', () => constraintDialog(ctx, reload), 'primary')),
        listTable(
          [
            { label: 'Name', render: (c) => h('b', null, c.name) },
            { label: 'Type', render: (c) => h('span', { class: 'badge ' + ({ p: 'pk', f: 'fk', u: 'uq' }[c.type] || '') }, typeName[c.type] || c.type) },
            { label: 'Definition', render: (c) => h('span', { class: 'mono' }, c.def) },
          ],
          meta.cons.filter((c) => c.type !== 'n'),
          {
            empty: 'No constraints',
            actions: (c) => [
              btn('Drop', () => runSqlDialog(db, `ALTER TABLE ${rel} DROP CONSTRAINT ${qi(c.name)};`, { title: 'Drop constraint', danger: true, okLabel: 'Drop' }).then((ok) => ok && reload('structure')), 'danger'),
            ],
          }
        ),
        sectionHead('Triggers', btn('+ Create trigger', () => openSqlTab(db, triggerTemplate(ctx)))),
        listTable(
          [
            { label: 'Name', render: (t) => h('b', null, t.name) },
            { label: 'Definition', render: (t) => h('span', { class: 'mono' }, t.def) },
            { label: 'Enabled', render: (t) => (t.enabled === 'D' ? h('span', { class: 'badge err' }, 'disabled') : h('span', { class: 'badge ok' }, 'enabled')) },
          ],
          triggers,
          {
            empty: 'No triggers',
            actions: (t) => [
              btn(t.enabled === 'D' ? 'Enable' : 'Disable', () =>
                exec(db, `ALTER TABLE ${rel} ${t.enabled === 'D' ? 'ENABLE' : 'DISABLE'} TRIGGER ${qi(t.name)}`).then(() => reload('structure')).catch(errorDlg)),
              btn('Drop', () => runSqlDialog(db, `DROP TRIGGER ${qi(t.name)} ON ${rel};`, { title: 'Drop trigger', danger: true, okLabel: 'Drop' }).then((ok) => ok && reload('structure')), 'danger'),
            ],
          }
        )
      );
    }

    // Size info
    const info = meta.info;
    appendTo(frag, 
      h('h3', null, 'Statistics'),
      h('div', { class: 'cards' },
        statCard('Estimated rows', fmtNum(Math.max(0, Number(info.est)))),
        statCard('Total size', fmtBytes(info.total)),
        statCard('Data size', fmtBytes(info.data)),
        statCard('Index size', fmtBytes(info.idx)),
        statCard('Owner', info.owner, true))
    );
    return frag;
  });
}

function triggerTemplate(ctx) {
  const fn = qn(ctx.schema, `${ctx.name}_trigger_fn`);
  return `CREATE OR REPLACE FUNCTION ${fn}()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER ${qi(ctx.name + '_trg')}
BEFORE INSERT OR UPDATE ON ${ctx.rel}
FOR EACH ROW EXECUTE FUNCTION ${fn}();
`;
}

function typeDatalist() {
  const id = 'pg-types-list';
  if (!document.getElementById(id)) {
    document.body.appendChild(h('datalist', { id }, PG_TYPES.map((t) => h('option', { value: t }))));
  }
  return id;
}

function columnDialog(ctx, col, reload) {
  const isNew = !col;
  const name = h('input', { value: col ? col.name : '' });
  const type = h('input', { value: col ? col.type : 'text', list: typeDatalist() });
  const notnull = h('input', { type: 'checkbox', checked: col && isTrue(col.notnull) });
  const def = h('input', { value: col && !col.identity && col.generated !== 's' ? col.def || '' : '', placeholder: "e.g. now(), 0, 'abc'" });
  const comment = h('input', { value: col ? col.comment || '' : '' });
  const using = h('input', { placeholder: 'optional, e.g. col::integer' });
  const body = h('div', { class: 'grid2' },
    h('label', null, 'Name', name),
    h('label', null, 'Data type', type),
    h('label', { class: 'span2' }, 'Default expression', def),
    h('label', { class: 'span2' }, 'Comment', comment),
    !isNew ? h('label', { class: 'span2' }, 'USING expression for type change', using) : null,
    h('label', { class: 'check' }, notnull, 'NOT NULL'));
  modal({
    title: isNew ? `Add column to ${ctx.name}` : `Edit column ${col.name}`,
    body,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Preview SQL',
        kind: 'primary',
        onClick: async (close) => {
          const n = name.value.trim();
          if (!n) return toast('Column name is required', 'warn'), false;
          const stmts = [];
          const rel = ctx.rel;
          if (isNew) {
            let s = `ALTER TABLE ${rel} ADD COLUMN ${qi(n)} ${type.value.trim()}`;
            if (def.value.trim()) s += ` DEFAULT ${def.value.trim()}`;
            if (notnull.checked) s += ' NOT NULL';
            stmts.push(s + ';');
            if (comment.value.trim()) stmts.push(`COMMENT ON COLUMN ${rel}.${qi(n)} IS ${ql(comment.value.trim())};`);
          } else {
            if (n !== col.name) stmts.push(`ALTER TABLE ${rel} RENAME COLUMN ${qi(col.name)} TO ${qi(n)};`);
            if (type.value.trim() !== col.type)
              stmts.push(`ALTER TABLE ${rel} ALTER COLUMN ${qi(n)} TYPE ${type.value.trim()}${using.value.trim() ? ' USING ' + using.value.trim() : ` USING ${qi(n)}::${type.value.trim()}`};`);
            const oldDef = col.identity || col.generated === 's' ? '' : col.def || '';
            if (def.value.trim() !== oldDef)
              stmts.push(def.value.trim() ? `ALTER TABLE ${rel} ALTER COLUMN ${qi(n)} SET DEFAULT ${def.value.trim()};` : `ALTER TABLE ${rel} ALTER COLUMN ${qi(n)} DROP DEFAULT;`);
            if (notnull.checked !== isTrue(col.notnull)) stmts.push(`ALTER TABLE ${rel} ALTER COLUMN ${qi(n)} ${notnull.checked ? 'SET' : 'DROP'} NOT NULL;`);
            if (comment.value.trim() !== (col.comment || ''))
              stmts.push(`COMMENT ON COLUMN ${rel}.${qi(n)} IS ${comment.value.trim() ? ql(comment.value.trim()) : 'NULL'};`);
          }
          if (!stmts.length) return toast('Nothing changed', 'info'), false;
          close();
          if (await runSqlDialog(ctx.db, stmts.join('\n'), { title: isNew ? 'Add column' : 'Alter column' })) reload('structure');
        },
      },
    ],
  });
}

function indexDialog(ctx, cols, reload) {
  const name = h('input', { value: `${ctx.name}_${cols.join('_') || 'col'}_idx` });
  const colsIn = h('input', { value: cols.map(qi).join(', '), placeholder: '"col1", "col2" DESC, lower("email")' });
  const method = h('select', null, ['btree', 'hash', 'gin', 'gist', 'brin', 'spgist'].map((m) => h('option', null, m)));
  const unique = h('input', { type: 'checkbox' });
  const conc = h('input', { type: 'checkbox' });
  const where = h('input', { placeholder: 'optional partial index predicate' });
  const colPick = h('div', { class: 'flex' }, h('span', { class: 'help' }, 'Click to add:'),
    ctx.meta.cols.map((c) => h('button', { class: 'btn xs', onclick: () => (colsIn.value = colsIn.value.trim() ? colsIn.value + ', ' + qi(c.name) : qi(c.name)) }, c.name)));
  modal({
    title: 'Create index',
    size: 'wide',
    body: h('div', { class: 'grid2' },
      h('label', null, 'Index name', name),
      h('label', null, 'Method', method),
      h('label', { class: 'span2' }, 'Columns / expressions', colsIn),
      h('div', { class: 'span2' }, colPick),
      h('label', { class: 'span2' }, 'WHERE', where),
      h('label', { class: 'check' }, unique, 'Unique'),
      h('label', { class: 'check' }, conc, 'Concurrently (no write lock)')),
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Preview SQL',
        kind: 'primary',
        onClick: async (close) => {
          if (!colsIn.value.trim()) return toast('Specify at least one column', 'warn'), false;
          const sql = `CREATE ${unique.checked ? 'UNIQUE ' : ''}INDEX ${conc.checked ? 'CONCURRENTLY ' : ''}${qi(name.value.trim())}\n  ON ${ctx.rel} USING ${method.value} (${colsIn.value.trim()})${where.value.trim() ? '\n  WHERE ' + where.value.trim() : ''};`;
          close();
          if (await runSqlDialog(ctx.db, sql, { title: 'Create index' })) reload('structure');
        },
      },
    ],
  });
}

async function constraintDialog(ctx, reload) {
  const type = h('select', null, ['PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY', 'CHECK'].map((t) => h('option', null, t)));
  const name = h('input', { placeholder: 'optional' });
  const cols = h('input', { placeholder: '"col1", "col2"' });
  const check = h('input', { placeholder: 'price > 0' });
  const refTable = h('select');
  const refCols = h('input', { placeholder: '"id"' });
  const onDel = h('select', null, ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'].map((t) => h('option', null, t)));
  const onUpd = h('select', null, ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'].map((t) => h('option', null, t)));
  try {
    const list = await rows(ctx.db, `select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema') order by 1, 2`);
    for (const t of list) refTable.appendChild(h('option', { value: qn(t.s, t.t) }, `${t.s}.${t.t}`));
  } catch {}
  const fkPart = h('div', { class: 'grid2 span2' },
    h('label', { class: 'span2' }, 'Referenced table', refTable),
    h('label', { class: 'span2' }, 'Referenced columns', refCols),
    h('label', null, 'ON DELETE', onDel),
    h('label', null, 'ON UPDATE', onUpd));
  const colsLabel = h('label', { class: 'span2' }, 'Columns', cols);
  const checkLabel = h('label', { class: 'span2' }, 'Check expression', check);
  const sync = () => {
    fkPart.classList.toggle('hidden', type.value !== 'FOREIGN KEY');
    checkLabel.classList.toggle('hidden', type.value !== 'CHECK');
    colsLabel.classList.toggle('hidden', type.value === 'CHECK');
  };
  type.addEventListener('change', sync);
  sync();
  modal({
    title: 'Add constraint',
    size: 'wide',
    body: h('div', { class: 'grid2' }, h('label', null, 'Type', type), h('label', null, 'Name', name), colsLabel, checkLabel, fkPart),
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Preview SQL',
        kind: 'primary',
        onClick: async (close) => {
          let def;
          if (type.value === 'CHECK') def = `CHECK (${check.value})`;
          else if (type.value === 'FOREIGN KEY') def = `FOREIGN KEY (${cols.value}) REFERENCES ${refTable.value} (${refCols.value}) ON DELETE ${onDel.value} ON UPDATE ${onUpd.value}`;
          else def = `${type.value} (${cols.value})`;
          const sql = `ALTER TABLE ${ctx.rel}\n  ADD ${name.value.trim() ? 'CONSTRAINT ' + qi(name.value.trim()) + ' ' : ''}${def};`;
          close();
          if (await runSqlDialog(ctx.db, sql, { title: 'Add constraint' })) reload('structure');
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Export / Import                                                     */
/* ------------------------------------------------------------------ */
function renderExport(pane, ctx) {
  const fmt = h('select', null, h('option', { value: 'csv' }, 'CSV'), h('option', { value: 'json' }, 'JSON'), h('option', { value: 'sql' }, 'SQL INSERT statements'));
  const header = h('input', { type: 'checkbox', checked: true });
  const delim = h('select', null, h('option', { value: ',' }, 'Comma (,)'), h('option', { value: ';' }, 'Semicolon (;)'), h('option', { value: '\t' }, 'Tab'), h('option', { value: '|' }, 'Pipe (|)'));
  const where = h('input', { placeholder: 'optional WHERE condition to export a subset' });
  const withDdl = h('input', { type: 'checkbox' });
  const status = h('div', { class: 'help' });
  const go = async () => {
    const ext = fmt.value;
    const p = await api.saveDialog({ defaultPath: `${ctx.name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!p) return;
    status.textContent = 'Exporting…';
    const sql = `SELECT * FROM ${ctx.rel}${where.value.trim() ? ' WHERE ' + where.value.trim() : ''}`;
    const r = await api.exportData({ key: S.conn.key, database: ctx.db, sql, format: ext, filePath: p, tableName: ctx.rel, header: header.checked, delimiter: delim.value });
    if (!r.ok) {
      status.textContent = '';
      return errorDlg(r.error);
    }
    if (ext === 'sql' && withDdl.checked) {
      const ddl = await buildDdl(ctx);
      const data = await api.readFile(p);
      await api.writeFile({ path: p, content: ddl + '\n\n' + data });
    }
    status.textContent = `Exported ${fmtNum(r.count)} rows to ${p}`;
    toast(`Exported ${fmtNum(r.count)} rows`, 'ok');
  };
  const sync = () => {
    $$('.csv-only', pane).forEach((e) => e.classList.toggle('hidden', fmt.value !== 'csv'));
    $$('.sql-only', pane).forEach((e) => e.classList.toggle('hidden', fmt.value !== 'sql'));
  };
  fmt.addEventListener('change', sync);
  appendTo(pane, 
    h('div', { class: 'card', style: { maxWidth: '700px' } },
      h('h3', null, `Export ${ctx.schema}.${ctx.name}`),
      h('div', { class: 'grid2' },
        h('label', null, 'Format', fmt),
        h('label', { class: 'csv-only' }, 'Delimiter', delim),
        h('label', { class: 'span2' }, 'Filter (WHERE)', where),
        h('label', { class: 'check csv-only' }, header, 'Include header row'),
        h('label', { class: 'check sql-only' }, withDdl, 'Include CREATE TABLE statement')),
      h('div', { class: 'flex mt' }, h('button', { class: 'btn primary', onclick: go }, 'Export…'), status))
  );
  sync();
}

function renderImport(pane, ctx) {
  const delim = h('select', null, h('option', { value: ',' }, 'Comma (,)'), h('option', { value: ';' }, 'Semicolon (;)'), h('option', { value: '\t' }, 'Tab'), h('option', { value: '|' }, 'Pipe (|)'));
  const header = h('input', { type: 'checkbox', checked: true });
  const emptyNull = h('input', { type: 'checkbox', checked: true });
  const truncate = h('input', { type: 'checkbox' });
  const preview = h('div');
  const progress = h('div', { class: 'progress hidden' }, h('div'));
  const status = h('div', { class: 'help' });
  let text = null;
  let filePath = null;
  const fileLabel = h('span', { class: 'muted' }, 'No file selected');

  const pick = async () => {
    const p = await api.openDialog({ filters: [{ name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] }, { name: 'All files', extensions: ['*'] }] });
    if (!p) return;
    filePath = p;
    if (p.endsWith('.tsv')) delim.value = '\t';
    fileLabel.textContent = p;
    text = await api.readFile(p);
    paint();
  };
  let mapping = [];
  function paint() {
    clear(preview);
    if (!text) return;
    const sample = parseCsv(text, delim.value, 6);
    if (!sample.length) return preview.appendChild(h('div', { class: 'muted' }, 'File is empty'));
    const headerRow = header.checked ? sample[0] : sample[0].map((_, i) => `column ${i + 1}`);
    const body = header.checked ? sample.slice(1) : sample;
    const colNames = ctx.meta.cols.filter((c) => c.generated !== 's').map((c) => c.name);
    mapping = headerRow.map((hname, i) => {
      const sel = h('select', null, h('option', { value: '' }, '— skip —'), colNames.map((n) => h('option', { value: n }, n)));
      const match = colNames.find((n) => n.toLowerCase() === String(hname).trim().toLowerCase()) || (!header.checked ? colNames[i] : null);
      if (match) sel.value = match;
      return sel;
    });
    const t = h('table', { class: 'list' },
      h('thead', null, h('tr', null, headerRow.map((hn, i) => h('th', null, h('div', null, hn), mapping[i])))),
      h('tbody', null, body.map((r) => h('tr', null, headerRow.map((_, i) => h('td', { class: 'mono' }, r[i] ?? ''))))));
    appendTo(preview, h('h3', null, 'Column mapping & preview'), h('div', { class: 'list-wrap' }, t));
  }
  delim.addEventListener('change', paint);
  header.addEventListener('change', paint);

  const run = async () => {
    if (!text) return toast('Choose a file first', 'warn');
    const map = mapping.map((s, i) => ({ i, col: s.value })).filter((m) => m.col);
    for (const m of map) {
      const c = ctx.meta.cols.find((x) => x.name === m.col);
      m.hasDefault = !!(c && (c.def || c.identity));
    }
    if (!map.length) return toast('Map at least one column', 'warn');
    const all = parseCsv(text, delim.value);
    const data = header.checked ? all.slice(1) : all;
    const cols = map.map((m) => qi(m.col)).join(', ');
    const batch = Math.max(1, Math.floor(30000 / map.length));
    progress.classList.remove('hidden');
    const bar = progress.firstChild;
    const session = uid('import');
    try {
      await runSql(ctx.db, 'BEGIN', [], { session });
      if (truncate.checked) await runSql(ctx.db, `TRUNCATE ${ctx.rel}`, [], { session });
      for (let off = 0; off < data.length; off += batch) {
        const chunk = data.slice(off, off + batch).filter((r) => !(r.length === 1 && r[0] === ''));
        if (!chunk.length) continue;
        const params = [];
        const tuples = chunk.map((r) => '(' + map.map((m) => {
          let v = r[m.i];
          // empty cell on a column with a default / identity -> use DEFAULT
          if ((v === undefined || v === '') && m.hasDefault) return 'DEFAULT';
          if (v === undefined || (emptyNull.checked && v === '')) v = null;
          params.push(v);
          return '$' + params.length;
        }).join(', ') + ')');
        await runSql(ctx.db, `INSERT INTO ${ctx.rel} (${cols}) VALUES ${tuples.join(', ')}`, params, { session });
        bar.style.width = Math.round(((off + chunk.length) / data.length) * 100) + '%';
        status.textContent = `Imported ${fmtNum(off + chunk.length)} / ${fmtNum(data.length)} rows…`;
      }
      await runSql(ctx.db, 'COMMIT', [], { session });
      status.textContent = `Imported ${fmtNum(data.length)} rows from ${filePath}`;
      toast(`Imported ${fmtNum(data.length)} rows`, 'ok');
      ctx.tabs.invalidate('browse');
    } catch (e) {
      await runSql(ctx.db, 'ROLLBACK', [], { session }).catch(() => {});
      status.textContent = 'Import failed — all changes rolled back.';
      errorDlg(e, 'Import failed');
    } finally {
      api.closeSession({ key: S.conn.key, session });
    }
  };

  appendTo(pane, 
    h('div', { class: 'card' },
      h('h3', null, `Import CSV into ${ctx.schema}.${ctx.name}`),
      h('div', { class: 'flex' }, h('button', { class: 'btn', onclick: pick }, 'Choose file…'), fileLabel),
      h('div', { class: 'grid3 mt' },
        h('label', null, 'Delimiter', delim),
        h('label', { class: 'check' }, header, 'First row is a header'),
        h('label', { class: 'check' }, emptyNull, 'Treat empty values as NULL'),
        h('label', { class: 'check' }, truncate, 'Empty table before import')),
      h('div', { class: 'mt' }, preview),
      h('div', { class: 'mt' }, progress),
      h('div', { class: 'flex mt' }, h('button', { class: 'btn primary', onclick: run }, 'Import'), status),
      h('p', { class: 'help' }, 'The import runs inside a single transaction: if any row fails, nothing is imported. Empty cells in columns that have a default (e.g. auto-increment ids) use that default.'))
  );
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */
function renderTableOps(pane, ctx, reload) {
  fillPane(pane, async () => {
    const { db, rel, schema, name, kind } = ctx;
    const isTable = kind === 'r' || kind === 'p';
    const objType = { r: 'TABLE', p: 'TABLE', v: 'VIEW', m: 'MATERIALIZED VIEW', f: 'FOREIGN TABLE' }[kind];
    const [schemas, roles] = await Promise.all([
      rows(db, `select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' order by 1`),
      rows(db, `select rolname from pg_roles order by 1`),
    ]);
    const after = (ok, sub) => {
      if (ok) {
        refreshTree();
        reload(sub || 'operations');
      }
    };

    const newName = h('input', { value: name });
    const schemaSel = h('select', null, schemas.map((s) => h('option', { selected: s.nspname === schema }, s.nspname)));
    const ownerSel = h('select', null, roles.map((r) => h('option', { selected: r.rolname === ctx.meta.info.owner }, r.rolname)));
    const comment = h('textarea', { rows: 2 });
    comment.value = ctx.meta.info.comment || '';
    const copyName = h('input', { value: name + '_copy' });
    const copyData = h('input', { type: 'checkbox', checked: true });
    const cascade = h('input', { type: 'checkbox' });
    const restart = h('input', { type: 'checkbox' });

    const renamed = async (sql, newRel) => {
      if (await runSqlDialog(db, sql, { title: 'Execute' })) {
        refreshTree();
        closeTab(`tbl:${db}:${schema}:${name}`);
        openTableTab(db, newRel[0], newRel[1], kind, 'operations');
      }
    };

    return h('div', { style: { maxWidth: '900px' } },
      h('div', { class: 'card' },
        h('h3', null, 'Rename'),
        h('div', { class: 'flex' }, newName, btn('Rename', () => renamed(`ALTER ${objType} ${rel} RENAME TO ${qi(newName.value.trim())};`, [schema, newName.value.trim()])))),
      h('div', { class: 'card' },
        h('h3', null, 'Move to schema'),
        h('div', { class: 'flex' }, schemaSel, btn('Move', () => renamed(`ALTER ${objType} ${rel} SET SCHEMA ${qi(schemaSel.value)};`, [schemaSel.value, name])))),
      h('div', { class: 'card' },
        h('h3', null, 'Owner'),
        h('div', { class: 'flex' }, ownerSel, btn('Change owner', () => runSqlDialog(db, `ALTER ${objType} ${rel} OWNER TO ${qi(ownerSel.value)};`).then((ok) => after(ok))))),
      h('div', { class: 'card' },
        h('h3', null, 'Comment'),
        comment,
        h('div', { class: 'flex mt' }, btn('Save comment', () => runSqlDialog(db, `COMMENT ON ${objType} ${rel} IS ${comment.value.trim() ? ql(comment.value.trim()) : 'NULL'};`).then((ok) => after(ok))))),
      isTable
        ? h('div', { class: 'card' },
            h('h3', null, 'Copy table'),
            h('div', { class: 'flex' }, copyName, h('label', { class: 'check' }, copyData, 'with data'),
              btn('Copy', () =>
                runSqlDialog(db,
                  `CREATE TABLE ${qn(schema, copyName.value.trim())} (LIKE ${rel} INCLUDING ALL);` +
                    (copyData.checked ? `\nINSERT INTO ${qn(schema, copyName.value.trim())} SELECT * FROM ${rel};` : ''),
                  { title: 'Copy table' }).then((ok) => ok && refreshTree()))))
        : null,
      h('div', { class: 'card' },
        h('h3', null, 'Maintenance'),
        h('div', { class: 'btn-group' },
          isTable || kind === 'm' ? btn('VACUUM', () => runSqlDialog(db, `VACUUM (VERBOSE) ${rel};`, { title: 'Vacuum' })) : null,
          isTable || kind === 'm' ? btn('VACUUM FULL', () => runSqlDialog(db, `VACUUM (FULL, VERBOSE) ${rel};`, { title: 'Vacuum full (locks table)' })) : null,
          isTable || kind === 'm' ? btn('VACUUM ANALYZE', () => runSqlDialog(db, `VACUUM (ANALYZE) ${rel};`, { title: 'Vacuum analyze' })) : null,
          isTable || kind === 'm' ? btn('ANALYZE', () => runSqlDialog(db, `ANALYZE ${rel};`, { title: 'Analyze' })) : null,
          isTable || kind === 'm' ? btn('REINDEX', () => runSqlDialog(db, `REINDEX TABLE ${rel};`, { title: 'Reindex table' })) : null,
          kind === 'm' ? btn('REFRESH', () => runSqlDialog(db, `REFRESH MATERIALIZED VIEW ${rel};`, { title: 'Refresh materialized view' })) : null),
        h('p', { class: 'help' }, 'VACUUM reclaims storage occupied by dead tuples; ANALYZE updates planner statistics; REINDEX rebuilds indexes.')),
      h('div', { class: 'card', style: { borderColor: 'var(--danger)' } },
        h('h3', { class: 'err' }, 'Danger zone'),
        h('div', { class: 'flex' },
          h('label', { class: 'check' }, cascade, 'CASCADE'),
          isTable ? h('label', { class: 'check' }, restart, 'RESTART IDENTITY (truncate)') : null),
        h('div', { class: 'btn-group mt' },
          isTable
            ? btn('Empty table (TRUNCATE)', () =>
                runSqlDialog(db, `TRUNCATE TABLE ${rel}${restart.checked ? ' RESTART IDENTITY' : ''}${cascade.checked ? ' CASCADE' : ''};`, { title: 'Truncate table', danger: true, okLabel: 'Truncate' }).then((ok) => ok && reload('operations')), 'danger')
            : null,
          btn(`Drop ${objType.toLowerCase()}`, async () => {
            const ok = await runSqlDialog(db, `DROP ${objType} ${rel}${cascade.checked ? ' CASCADE' : ''};`, { title: `Drop ${objType.toLowerCase()}`, danger: true, okLabel: 'Drop' });
            if (ok) {
              refreshTree();
              closeTab(`tbl:${db}:${schema}:${name}`);
            }
          }, 'danger')))
    );
  });
}

/* ------------------------------------------------------------------ */
/* DDL                                                                 */
/* ------------------------------------------------------------------ */
async function buildDdl(ctx) {
  const { db, rel, meta, kind } = ctx;
  if (kind === 'v' || kind === 'm') {
    const r = await one(db, `select pg_get_viewdef($1::regclass, true) as def`, [rel]);
    let s = kind === 'v' ? `CREATE OR REPLACE VIEW ${rel} AS\n${r.def}` : `CREATE MATERIALIZED VIEW ${rel} AS\n${r.def.replace(/;\s*$/, '')}\nWITH DATA;`;
    if (meta.info.comment) s += `\n\nCOMMENT ON ${kind === 'v' ? 'VIEW' : 'MATERIALIZED VIEW'} ${rel} IS ${ql(meta.info.comment)};`;
    return s;
  }
  const lines = meta.cols.map((c) => {
    let s = `  ${qi(c.name)} ${c.type}`;
    if (c.identity === 'a') s += ' GENERATED ALWAYS AS IDENTITY';
    else if (c.identity === 'd') s += ' GENERATED BY DEFAULT AS IDENTITY';
    else if (c.generated === 's') s += ` GENERATED ALWAYS AS (${c.def}) STORED`;
    else if (c.def) s += ` DEFAULT ${c.def}`;
    if (isTrue(c.notnull)) s += ' NOT NULL';
    return s;
  });
  for (const c of meta.cons) if (c.type !== 'n') lines.push(`  CONSTRAINT ${qi(c.name)} ${c.def}`);
  let ddl = `CREATE TABLE ${rel} (\n${lines.join(',\n')}\n)`;
  if (kind === 'p') {
    const pk = await one(db, `select pg_get_partkeydef($1::regclass) as k`, [rel]);
    ddl += ` PARTITION BY ${pk.k}`;
  }
  ddl += ';\n';
  const idx = await rows(db, `select pg_get_indexdef(i.indexrelid) as def from pg_index i where i.indrelid = $1::regclass and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.conrelid = i.indrelid)`, [rel]);
  if (idx.length) ddl += '\n' + idx.map((i) => i.def + ';').join('\n') + '\n';
  const trg = await rows(db, `select pg_get_triggerdef(oid, true) as def from pg_trigger where tgrelid = $1::regclass and not tgisinternal`, [rel]);
  if (trg.length) ddl += '\n' + trg.map((t) => t.def + ';').join('\n') + '\n';
  if (meta.info.comment) ddl += `\nCOMMENT ON TABLE ${rel} IS ${ql(meta.info.comment)};\n`;
  for (const c of meta.cols) if (c.comment) ddl += `COMMENT ON COLUMN ${rel}.${qi(c.name)} IS ${ql(c.comment)};\n`;
  return ddl;
}

function renderDdl(pane, ctx) {
  fillPane(pane, async () => {
    const ddl = await buildDdl(ctx);
    const holder = h('div', { class: 'code-box' });
    const wrap = h('div', null,
      h('div', { class: 'flex', style: { marginBottom: '10px' } },
        btn('Copy', () => navigator.clipboard.writeText(ddl).then(() => toast('Copied', 'ok'))),
        btn('Open in SQL editor', () => openSqlTab(ctx.db, ddl))),
      holder);
    setTimeout(() => makeEditor(holder, { value: ddl, readOnly: true }).refresh(), 0);
    return wrap;
  });
}
