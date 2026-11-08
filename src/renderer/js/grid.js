'use strict';

/**
 * Data grid used by table browser and SQL results.
 * opts: {
 *   fields: [{name, dataTypeID}], rows: [[...]], types: {colName: typeName},
 *   hidden: Set<index>, startIndex, sort: {col, dir}, onSort(colName),
 *   editable, onCellEdit(rowIdx, colIdx, value) => Promise<boolean>,
 *   onRowEdit(rowIdx), onRowDelete(rowIdx), onFilter(colName, value), selectable
 * }
 */
function dataGrid(opts) {
  const { fields, rows, types = {}, hidden = new Set(), startIndex = 0, editable, selectable } = opts;
  const wrap = h('div', { class: 'grid-wrap' });
  const table = h('table', { class: 'grid' });
  const visible = fields.map((f, i) => i).filter((i) => !hidden.has(i));
  const selected = new Set();

  // header
  const htr = h('tr', null, h('th', { class: 'rn' }, '#'));
  if (selectable) {
    const all = h('input', {
      type: 'checkbox',
      onchange: () => {
        $$('tbody tr', table).forEach((tr, i) => {
          tr.classList.toggle('selected', all.checked);
          tr.querySelector('td.ck input').checked = all.checked;
          if (all.checked) selected.add(i);
          else selected.delete(i);
        });
      },
    });
    htr.appendChild(h('th', { class: 'ck' }, all));
  }
  if (editable) htr.appendChild(h('th', null, ''));
  for (const i of visible) {
    const f = fields[i];
    const sorted = opts.sort && opts.sort.col === f.name;
    const th = h('th', { class: opts.onSort ? 'sortable' : '', title: opts.onSort ? 'Click to sort' : '' },
      f.name,
      sorted ? h('span', { class: 'sort' }, opts.sort.dir === 'DESC' ? '▼' : '▲') : null,
      types[f.name] ? h('span', { class: 'ty' }, types[f.name]) : null
    );
    if (opts.onSort) th.addEventListener('click', () => opts.onSort(f.name));
    htr.appendChild(th);
  }
  table.appendChild(h('thead', null, htr));

  const tbody = h('tbody');
  const frag = document.createDocumentFragment();
  rows.forEach((row, ri) => {
    const tr = h('tr');
    tr.appendChild(h('td', { class: 'rn' }, String(startIndex + ri + 1)));
    if (selectable) {
      const ck = h('input', { type: 'checkbox' });
      ck.addEventListener('change', () => {
        tr.classList.toggle('selected', ck.checked);
        if (ck.checked) selected.add(ri);
        else selected.delete(ri);
      });
      tr.appendChild(h('td', { class: 'ck' }, ck));
    }
    if (editable) {
      tr.appendChild(
        h('td', { class: 'ra' },
          h('button', { title: 'Edit row', onclick: () => opts.onRowEdit && opts.onRowEdit(ri) }, '✎'),
          h('button', { title: 'Delete row', class: 'del', onclick: () => opts.onRowDelete && opts.onRowDelete(ri) }, '🗑')
        )
      );
    }
    for (const ci of visible) {
      const td = h('td');
      paintCell(td, row[ci], fields[ci], types[fields[ci].name]);
      td.dataset.r = ri;
      td.dataset.c = ci;
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
  table.appendChild(tbody);
  wrap.appendChild(table);

  // inline editing
  if (editable && opts.onCellEdit) {
    tbody.addEventListener('dblclick', (e) => {
      const td = e.target.closest('td[data-c]');
      if (!td || td.classList.contains('editing')) return;
      startEdit(td);
    });
  }

  function startEdit(td) {
    const ri = Number(td.dataset.r);
    const ci = Number(td.dataset.c);
    const orig = rows[ri][ci];
    const w = td.offsetWidth;
    td.classList.add('editing');
    clear(td);
    const ta = h('textarea', { rows: 1 });
    ta.value = orig === null ? '' : orig;
    ta.style.width = Math.max(w, 160) + 'px';
    if (ta.value.includes('\n') || ta.value.length > 60) ta.style.height = '90px';
    td.appendChild(ta);
    ta.focus();
    ta.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const val = ta.value;
      td.classList.remove('editing');
      if (commit && val !== (orig === null ? '' : orig)) {
        paintCell(td, val, fields[ci], types[fields[ci].name]);
        const ok = await opts.onCellEdit(ri, ci, val);
        if (ok) {
          rows[ri][ci] = val;
          td.classList.add('edited');
        } else paintCell(td, orig, fields[ci], types[fields[ci].name]);
      } else paintCell(td, orig, fields[ci], types[fields[ci].name]);
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    ta.addEventListener('blur', () => finish(true));
  }

  // context menu
  tbody.addEventListener('contextmenu', (e) => {
    const td = e.target.closest('td[data-c]');
    if (!td || td.classList.contains('editing')) return;
    const ri = Number(td.dataset.r);
    const ci = Number(td.dataset.c);
    const v = rows[ri][ci];
    const tsv = (r) => visible.map((i) => (r[i] === null ? '' : String(r[i]).replace(/[\t\n]/g, ' '))).join('\t');
    const sel = selected.size ? [...selected].sort((a, b) => a - b).map((i) => rows[i]) : [rows[ri]];
    contextMenu(e, [
      { label: 'Copy value', action: () => navigator.clipboard.writeText(v === null ? '' : String(v)) },
      { label: 'Copy row(s) as TSV', action: () => navigator.clipboard.writeText(sel.map(tsv).join('\n')) },
      {
        label: 'Copy row(s) as JSON',
        action: () =>
          navigator.clipboard.writeText(
            JSON.stringify(sel.map((r) => Object.fromEntries(visible.map((i) => [fields[i].name, r[i]]))), null, 2)
          ),
      },
      { label: 'Copy column name', action: () => navigator.clipboard.writeText(fields[ci].name) },
      editable || opts.onFilter ? '-' : null,
      opts.onFilter ? { label: 'Filter by this value', action: () => opts.onFilter(fields[ci].name, v) } : null,
      editable ? { label: 'Edit cell', action: () => startEdit(td) } : null,
      editable
        ? {
            label: 'Set to NULL',
            action: async () => {
              if (await opts.onCellEdit(ri, ci, null)) {
                rows[ri][ci] = null;
                paintCell(td, null, fields[ci]);
                td.classList.add('edited');
              }
            },
          }
        : null,
      editable ? { label: 'Edit row…', action: () => opts.onRowEdit(ri) } : null,
      editable ? { label: 'Delete row', danger: true, action: () => opts.onRowDelete(ri) } : null,
    ]);
  });

  return {
    el: wrap,
    getSelected: () => [...selected].sort((a, b) => a - b),
  };
}

function paintCell(td, v, field, typeName) {
  td.className = '';
  td.removeAttribute('title');
  if (v === null || v === undefined) {
    td.textContent = 'NULL';
    td.classList.add('null');
    return;
  }
  let s = String(v);
  if (field && NUMERIC_OIDS.has(field.dataTypeID)) td.classList.add('num');
  if (field && field.dataTypeID === 16) td.classList.add(s === 't' ? 'bool-t' : 'bool-f');
  if (s.length > 40 && s.length < 4000) td.title = s;
  if (s.length > 300) s = s.slice(0, 300) + '…';
  td.textContent = s.replace(/\n/g, '↵ ');
  void typeName;
}
