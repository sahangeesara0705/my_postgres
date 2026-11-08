'use strict';

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */
function addTab({ id, title, icon, pane, onActivate, onClose }) {
  const el = h('div', { class: 'tab', title });
  const label = h('span', { class: 'tl' }, title);
  appendTo(el, h('span', null, icon || ''), label, h('button', { class: 'tx', title: 'Close (Ctrl+W)', onclick: (e) => (e.stopPropagation(), closeTab(id)) }, '×'));
  el.addEventListener('click', () => activateTab(id));
  el.addEventListener('auxclick', (e) => e.button === 1 && closeTab(id));
  el.addEventListener('contextmenu', (e) =>
    contextMenu(e, [
      { label: 'Close', action: () => closeTab(id) },
      { label: 'Close others', action: () => S.tabs.filter((t) => t.id !== id).forEach((t) => closeTab(t.id)) },
      { label: 'Close all', action: () => [...S.tabs].forEach((t) => closeTab(t.id)) },
    ])
  );
  $('#tabbar').appendChild(el);
  pane.classList.add('hidden');
  $('#tabcontent').appendChild(pane);
  const tab = {
    id,
    el,
    pane,
    onActivate,
    onClose,
    setTitle: (t) => {
      label.textContent = t;
      el.title = t;
    },
  };
  S.tabs.push(tab);
  updateEmpty();
  activateTab(id);
  return tab;
}

function activateTab(id, sub) {
  const tab = S.tabs.find((t) => t.id === id);
  if (!tab) return false;
  for (const t of S.tabs) {
    t.el.classList.toggle('active', t === tab);
    t.pane.classList.toggle('hidden', t !== tab);
  }
  S.activeTab = id;
  tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (tab.onActivate) tab.onActivate(sub);
  return true;
}

function closeTab(id) {
  const i = S.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const tab = S.tabs[i];
  if (tab.onClose) tab.onClose();
  tab.el.remove();
  tab.pane.remove();
  S.tabs.splice(i, 1);
  if (S.activeTab === id) {
    const next = S.tabs[i] || S.tabs[i - 1];
    if (next) activateTab(next.id);
    else S.activeTab = null;
  }
  updateEmpty();
}

function updateEmpty() {
  let empty = $('#tab-empty');
  if (!S.tabs.length) {
    if (!empty) {
      empty = h('div', { id: 'tab-empty', class: 'empty-state' },
        h('img', { src: '../../build/icon.png', alt: '' }),
        h('div', { style: { fontSize: '16px', color: 'var(--text2)' } }, 'My Postgres'),
        h('div', null, 'Pick a database or table in the navigator, or'),
        h('div', { class: 'flex' }, btn('Open SQL editor', () => openSqlTab()), btn('Server overview', () => openServerTab())));
      $('#tabcontent').appendChild(empty);
    }
  } else if (empty) empty.remove();
}

/* ------------------------------------------------------------------ */
/* Connection screen                                                   */
/* ------------------------------------------------------------------ */
let savedConns = [];
let editingId = null;

async function showConnectScreen() {
  $('#app').classList.add('hidden');
  $('#connect-screen').classList.remove('hidden');
  savedConns = await api.listConnections();
  paintSaved();
  if (savedConns.length && !editingId) selectConn(savedConns[0]);
}

function paintSaved() {
  const box = clear($('#saved-conns'));
  if (!savedConns.length) box.appendChild(h('div', { class: 'saved-empty' }, 'No saved connections yet. Fill in the form and click Save or Connect.'));
  for (const c of savedConns) {
    box.appendChild(
      h('div', {
        class: 'saved-item' + (c.id === editingId ? ' active' : ''),
        onclick: () => selectConn(c),
        ondblclick: () => {
          selectConn(c);
          doConnect();
        },
      },
      h('span', { class: 'dot', style: { background: c.color || '#336791' } }),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, c.name), h('div', { class: 's' }, `${c.user}@${c.host}:${c.port}/${c.database}`)))
    );
  }
}

function selectConn(c) {
  editingId = c ? c.id : null;
  const f = $('#conn-form');
  f.name.value = c ? c.name : '';
  f.host.value = c ? c.host : 'localhost';
  f.port.value = c ? c.port : 5432;
  f.user.value = c ? c.user : 'postgres';
  f.password.value = '';
  f.password.placeholder = c && c.hasPassword ? '•••••••• (saved)' : '';
  f.database.value = c ? c.database : 'postgres';
  f.ssl.checked = c ? c.ssl : false;
  f.sslVerify.checked = c ? c.sslVerify : false;
  f.savePassword.checked = c ? c.savePassword : true;
  f.color.value = c ? c.color || '#336791' : '#336791';
  $('#conn-form-title').textContent = c ? 'Edit connection' : 'New connection';
  $('#btn-del-conn').classList.toggle('hidden', !c);
  $('#conn-msg').textContent = '';
  paintSaved();
}

function formConfig() {
  const f = $('#conn-form');
  return {
    id: editingId || undefined,
    name: f.name.value.trim(),
    host: f.host.value.trim() || 'localhost',
    port: Number(f.port.value) || 5432,
    user: f.user.value.trim(),
    password: f.password.value,
    database: f.database.value.trim() || 'postgres',
    ssl: f.ssl.checked,
    sslVerify: f.sslVerify.checked,
    savePassword: f.savePassword.checked,
    color: f.color.value,
  };
}

function connMsg(text, cls = '') {
  const m = $('#conn-msg');
  m.className = 'conn-msg ' + cls;
  m.textContent = text;
}

async function saveConn() {
  const saved = await api.saveConnection(formConfig());
  editingId = saved.id;
  savedConns = await api.listConnections();
  selectConn(saved);
  connMsg('Connection saved.', 'ok');
  return saved;
}

async function doConnect() {
  const btnC = $('#btn-connect');
  btnC.disabled = true;
  connMsg('Connecting…');
  try {
    let cfg = formConfig();
    // Always persist the connection so it appears in the list next time
    const saved = await api.saveConnection(cfg);
    editingId = saved.id;
    cfg = { ...cfg, id: saved.id, name: saved.name };
    const r = await api.connect(cfg);
    if (!r.ok) {
      connMsg(errText(new DbError(r.error)), 'err');
      savedConns = await api.listConnections();
      paintSaved();
      return;
    }
    S.conn = { ...r, color: cfg.color, cfgId: saved.id };
    store('lastConn', saved.id);
    enterApp();
  } finally {
    btnC.disabled = false;
  }
}

function enterApp() {
  $('#connect-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const badge = clear($('#conn-badge'));
  appendTo(badge, 
    h('span', { class: 'dot', style: { background: S.conn.color } }),
    h('b', null, S.conn.name),
    h('span', null, `${S.conn.user}@${S.conn.host}:${S.conn.port}`),
    h('span', { class: 'muted' }, 'PostgreSQL ' + (S.conn.version.match(/PostgreSQL ([\d.]+\w*)/) || [])[1])
  );
  document.title = `${S.conn.name} — My Postgres`;
  setStatus('Connected', S.conn.version.split(',')[0]);
  updateEmpty();
  refreshTree();
}

async function disconnect() {
  for (const t of [...S.tabs]) closeTab(t.id);
  if (S.conn) await api.disconnect(S.conn.key);
  S.conn = null;
  document.title = 'My Postgres';
  showConnectScreen();
}

/* ------------------------------------------------------------------ */
/* Theme / layout                                                      */
/* ------------------------------------------------------------------ */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store('theme', t);
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

function initResizer() {
  const r = $('#resizer');
  const side = $('#sidebar');
  const w = store('sidebarWidth');
  if (w) side.style.width = w + 'px';
  r.addEventListener('mousedown', (e) => {
    e.preventDefault();
    r.classList.add('drag');
    const startX = e.clientX;
    const startW = side.offsetWidth;
    const move = (ev) => (side.style.width = Math.min(600, Math.max(180, startW + ev.clientX - startX)) + 'px');
    const up = () => {
      r.classList.remove('drag');
      store('sidebarWidth', side.offsetWidth);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

function about() {
  api.appInfo().then((i) =>
    modal({
      title: 'About My Postgres',
      body: h('div', { class: 'flex', style: { alignItems: 'flex-start', gap: '16px' } },
        h('img', { src: '../../build/icon.png', style: { width: '72px' } }),
        h('div', null,
          h('h2', null, 'My Postgres ' + i.version),
          h('p', null, 'A graphical PostgreSQL database management tool: browse and edit data, manage structure, users, maintenance, backups and run SQL.'),
          h('p', { class: 'muted' }, `Electron ${i.electron} · Chrome ${i.chrome} · Node ${i.node}`))),
      buttons: [{ label: 'Close', kind: 'primary' }],
    })
  );
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
function init() {
  applyTheme(store('theme') || 'dark');
  initResizer();

  $('#conn-form').addEventListener('submit', (e) => {
    e.preventDefault();
    doConnect();
  });
  $('#btn-new-conn').onclick = () => selectConn(null);
  $('#btn-save-conn').onclick = saveConn;
  $('#btn-test-conn').onclick = async () => {
    connMsg('Testing…');
    const r = await api.test(formConfig());
    if (r.ok) connMsg('✔ Connection successful\n' + r.version, 'ok');
    else connMsg('✘ ' + errText(new DbError(r.error)), 'err');
  };
  $('#btn-del-conn').onclick = async () => {
    if (!editingId) return;
    if (!(await confirmDlg('Delete this saved connection?', { danger: true, okLabel: 'Delete' }))) return;
    await api.deleteConnection(editingId);
    editingId = null;
    savedConns = await api.listConnections();
    selectConn(savedConns[0] || null);
  };

  $('#btn-disconnect').onclick = disconnect;
  $('#btn-theme').onclick = toggleTheme;
  $('#btn-sql').onclick = () => openSqlTab();
  $('#btn-server').onclick = () => openServerTab();
  $('#btn-refresh-tree').onclick = refreshTree;
  $('#tree-filter').addEventListener('input', debounce(applyTreeFilter, 120));
  $('#opt-system').addEventListener('change', (e) => {
    S.showSystem = e.target.checked;
    refreshTree();
  });

  document.addEventListener('keydown', (e) => {
    if (!S.conn) return;
    if (e.ctrlKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (S.activeTab) closeTab(S.activeTab);
    } else if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      const i = S.tabs.findIndex((t) => t.id === S.activeTab);
      const n = S.tabs[(i + (e.shiftKey ? -1 : 1) + S.tabs.length) % S.tabs.length];
      if (n) activateTab(n.id);
    }
  });

  api.onMenu(async (ch) => {
    if (ch === 'toggle-theme') return toggleTheme();
    if (ch === 'about') return about();
    if (!S.conn) return;
    if (ch === 'new-sql') openSqlTab();
    else if (ch === 'refresh') refreshTree();
    else if (ch === 'disconnect') disconnect();
    else if (ch === 'open-sql') {
      const p = await api.openDialog({ filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }] });
      if (p) openSqlTab(undefined, await api.readFile(p), p.split('/').pop()).setFile(p);
    }
  });

  showConnectScreen().then(() => {
    const last = store('lastConn');
    const c = savedConns.find((x) => x.id === last);
    if (c) selectConn(c);
  });
}

init();
