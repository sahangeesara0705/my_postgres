'use strict';

/* ---------- Toasts ---------- */
function toast(msg, type = 'info', ms) {
  const el = h('div', { class: 'toast ' + type }, msg);
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms || (type === 'err' ? 8000 : 3500));
  el.addEventListener('click', () => el.remove());
}

function setStatus(text, right) {
  $('#status-text').textContent = text;
  if (right !== undefined) $('#status-right').textContent = right;
}

/* ---------- Modals ---------- */
// buttons: [{label, kind: 'primary'|'danger', onClick: async (close) => {} , close: true}]
function modal({ title, body, buttons = [], size = '', onClose, footLeft }) {
  const root = $('#modal-root');
  const box = h('div', { class: 'modal ' + size });
  const backdrop = h('div', { class: 'backdrop' }, box);
  let closed = false;
  const close = (v) => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose && onClose(v);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && root.lastElementChild === backdrop) {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  const foot = h('div', { class: 'modal-foot' });
  if (footLeft) {
    foot.appendChild(footLeft);
    foot.appendChild(h('span', { class: 'spacer' }));
  }
  for (const b of buttons) {
    const btn = h('button', { class: 'btn ' + (b.kind || '') }, b.label);
    btn.addEventListener('click', async () => {
      if (!b.onClick) return close(b.value);
      btn.disabled = true;
      try {
        const r = await b.onClick(close);
        if (r !== false && b.autoClose !== false) close(b.value);
      } finally {
        btn.disabled = false;
      }
    });
    foot.appendChild(btn);
  }
  appendTo(box, 
    h('div', { class: 'modal-head' }, title, h('button', { class: 'x', onclick: () => close() }, '×')),
    h('div', { class: 'modal-body' }, body),
    buttons.length || footLeft ? foot : null
  );
  root.appendChild(backdrop);
  setTimeout(() => {
    const f = box.querySelector('input:not([type=checkbox]):not([disabled]), textarea, select');
    if (f) f.focus();
  }, 30);
  return { close, box };
}

function confirmDlg(message, { title = 'Confirm', okLabel = 'OK', danger = false, sql } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: [h('div', { class: 'msg' }, message), sql ? h('pre', { class: 'sql-preview' }, sql) : null],
      buttons: [
        { label: 'Cancel', value: false },
        { label: okLabel, kind: danger ? 'danger' : 'primary', value: true },
      ],
      onClose: (v) => resolve(!!v),
    });
  });
}

function promptDlg(label, { title = 'Input', value = '', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { value, placeholder });
    let result = null;
    const m = modal({
      title,
      body: h('label', null, label, input),
      buttons: [
        { label: 'Cancel' },
        { label: 'OK', kind: 'primary', onClick: () => (result = input.value) },
      ],
      onClose: () => resolve(result),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        result = input.value;
        m.close();
      }
    });
    setTimeout(() => input.select(), 40);
  });
}

function errorDlg(err, title = 'Error') {
  modal({ title, body: h('div', { class: 'err-box' }, errText(err)), buttons: [{ label: 'Close', kind: 'primary' }] });
}

/**
 * Show generated SQL, let the user review/edit it and run it.
 * Returns true when executed successfully.
 */
function runSqlDialog(database, sql, { title = 'Execute SQL', okLabel = 'Execute', danger = false, success, editable = true } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const errBox = h('div', { class: 'err-box hidden' });
    const holder = h('div', { class: 'code-box' });
    const body = [h('div', { class: 'help' }, 'Review the SQL that will be executed:'), holder, errBox];
    let cm;
    const m = modal({
      title,
      size: 'wide',
      body,
      buttons: [
        { label: 'Cancel' },
        {
          label: okLabel,
          kind: danger ? 'danger' : 'primary',
          onClick: async () => {
            errBox.classList.add('hidden');
            try {
              const text = cm.getValue();
              const r = await execScript(database, text);
              if (r.error) throw new DbError(r.error);
              ok = true;
              toast(success || `Done in ${fmtMs(r.duration)}`, 'ok');
            } catch (e) {
              errBox.textContent = errText(e);
              errBox.classList.remove('hidden');
              return false;
            }
          },
        },
      ],
      onClose: () => resolve(ok),
    });
    cm = makeEditor(holder, { value: sql, readOnly: !editable, autofocus: false });
    setTimeout(() => cm.refresh(), 20);
    void m;
  });
}

/* ---------- Context menu ---------- */
function contextMenu(ev, items) {
  ev.preventDefault();
  const menu = $('#ctxmenu');
  clear(menu);
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      menu.appendChild(h('div', { class: 'ms' }));
      continue;
    }
    menu.appendChild(
      h('div', {
        class: 'mi' + (it.danger ? ' danger' : ''),
        onclick: () => {
          hideMenu();
          it.action();
        },
      }, it.label)
    );
  }
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(ev.clientX, window.innerWidth - r.width - 6) + 'px';
  menu.style.top = Math.min(ev.clientY, window.innerHeight - r.height - 6) + 'px';
}
function hideMenu() {
  $('#ctxmenu').classList.add('hidden');
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ctxmenu')) hideMenu();
});

/* ---------- CodeMirror ---------- */
function makeEditor(parent, opts = {}) {
  const cm = CodeMirror(parent, {
    value: opts.value || '',
    mode: 'text/x-pgsql',
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    indentWithTabs: false,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: !opts.readOnly,
    readOnly: opts.readOnly || false,
    lineWrapping: !!opts.lineWrapping,
    autofocus: opts.autofocus !== false && !opts.readOnly,
    extraKeys: {
      'Ctrl-Space': 'autocomplete',
      'Ctrl-/': 'toggleComment',
      Tab: (c) => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ', 'end')),
      'Shift-Tab': (c) => c.indentSelection('subtract'),
      ...(opts.extraKeys || {}),
    },
    hintOptions: { completeSingle: false, tables: opts.tables || {} },
  });
  return cm;
}

/* ---------- Sub tabs ---------- */
// tabs: [{id, label, render: (pane) => void}] — rendered lazily, re-rendered when `refresh` is called
function subTabs(container, tabs, initial) {
  const bar = h('div', { class: 'subtabs' });
  const paneHolder = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
  appendTo(container, bar, paneHolder);
  const panes = {};
  let current = null;
  const api = {
    show(id, force) {
      const t = tabs.find((x) => x.id === id) || tabs[0];
      current = t.id;
      $$('.subtab', bar).forEach((b) => b.classList.toggle('active', b.dataset.id === t.id));
      for (const [k, p] of Object.entries(panes)) p.classList.toggle('hidden', k !== t.id);
      if (!panes[t.id] || force) {
        if (panes[t.id]) panes[t.id].remove();
        const p = h('div', { class: 'subpane' + (t.flush ? ' flush' : '') });
        panes[t.id] = p;
        paneHolder.appendChild(p);
        t.render(p, api);
      } else if (t.onShow) t.onShow(panes[t.id]);
    },
    refresh(id) {
      api.show(id || current, true);
    },
    get current() {
      return current;
    },
    invalidate(...ids) {
      for (const id of ids) {
        if (panes[id] && id !== current) {
          panes[id].remove();
          delete panes[id];
        }
      }
    },
  };
  for (const t of tabs) {
    bar.appendChild(h('div', { class: 'subtab', 'data-id': t.id, onclick: () => api.show(t.id) }, t.label));
  }
  api.show(initial || tabs[0].id);
  return api;
}

function loadingPane(text = 'Loading…') {
  return h('div', { class: 'loading-pane' }, h('span', { class: 'spinner' }), text);
}

// Generic list table. cols: [{key, label, render?(row) -> node|string, class}]
function listTable(cols, data, { actions, empty = 'No items', onRowDblClick, checkable } = {}) {
  const thead = h('tr', null,
    checkable ? h('th', { style: { width: '28px' } }, h('input', { type: 'checkbox', onchange: (e) => $$('tbody input.rowck', table).forEach((c) => (c.checked = e.target.checked)) })) : null,
    cols.map((c) => h('th', { class: c.class || '' }, c.label)),
    actions ? h('th', null, '') : null
  );
  const tbody = h('tbody');
  if (!data.length) {
    tbody.appendChild(h('tr', null, h('td', { colspan: cols.length + (actions ? 1 : 0) + (checkable ? 1 : 0), class: 'muted', style: { textAlign: 'center', padding: '18px' } }, empty)));
  }
  data.forEach((row, i) => {
    const tr = h('tr', null,
      checkable ? h('td', null, h('input', { type: 'checkbox', class: 'rowck', 'data-i': i })) : null,
      cols.map((c) => {
        const v = c.render ? c.render(row) : row[c.key];
        return h('td', { class: c.class || '' }, v === null || v === undefined ? '' : v);
      }),
      actions ? h('td', { class: 'actions' }, actions(row)) : null
    );
    if (onRowDblClick) tr.addEventListener('dblclick', () => onRowDblClick(row));
    tbody.appendChild(tr);
  });
  const table = h('table', { class: 'list' }, h('thead', null, thead), tbody);
  table.getChecked = () => $$('tbody input.rowck:checked', table).map((c) => data[Number(c.dataset.i)]);
  return h('div', { class: 'list-wrap' }, table);
}

function statCard(k, v, small) {
  return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' + (small ? ' small' : ''), title: String(v ?? '') }, v ?? '—'));
}

function sectionHead(title, ...actions) {
  return h('div', { class: 'section-head' }, h('h3', null, title), h('span', { class: 'spacer' }), ...actions);
}

function btn(label, onClick, kind = '', title) {
  return h('button', { class: 'btn sm ' + kind, onclick: onClick, title }, label);
}

// Runs an async renderer into a pane with loading + error handling
async function fillPane(pane, fn) {
  clear(pane).appendChild(loadingPane());
  try {
    const node = await fn();
    clear(pane);
    if (node) appendKids(pane, [node]);
  } catch (e) {
    clear(pane).appendChild(h('div', { class: 'err-box' }, errText(e)));
  }
}
