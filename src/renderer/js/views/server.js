'use strict';

function openServerTab(initialSub) {
  const id = 'server';
  if (activateTab(id, initialSub)) return;
  const pane = h('div', { class: 'tabpane' });
  pane.appendChild(
    h('div', { class: 'view-head' },
      h('div', { class: 'crumbs' }, h('span', null, S.conn.name), h('span', { class: 'kind' }, 'server')),
      h('span', { class: 'spacer' }),
      btn('+ New database', () => createDatabaseDialog(), 'primary'))
  );
  const body = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
  pane.appendChild(body);
  const tabs = subTabs(body, [
    { id: 'overview', label: 'Overview', render: (p) => renderOverview(p) },
    { id: 'databases', label: 'Databases', render: (p, t) => renderDatabases(p, t) },
    { id: 'activity', label: 'Activity', render: (p) => renderActivity(p) },
    { id: 'locks', label: 'Locks', render: (p) => renderLocks(p) },
    { id: 'roles', label: 'Users & Roles', render: (p, t) => renderRoles(p, t) },
    { id: 'settings', label: 'Settings', render: (p) => renderSettings(p) },
  ], initialSub);
  S.serverTabs = tabs;
  addTab({ id, title: 'Server', icon: '🖥', pane, onActivate: (sub) => sub && tabs.show(sub) });
}

function renderOverview(pane) {
  const db = S.conn.database;
  fillPane(pane, async () => {
    const [info, counts, appInfo] = await Promise.all([
      one(db, `select version() as version, current_setting('server_version') as sv, pg_postmaster_start_time() as started,
                      now() - pg_postmaster_start_time() as uptime, inet_server_addr()::text as addr, inet_server_port() as port,
                      current_user as usr, current_setting('max_connections') as maxconn,
                      current_setting('shared_buffers') as sb, current_setting('work_mem') as wm, current_setting('TimeZone') as tz,
                      current_setting('server_encoding') as enc, pg_is_in_recovery() as recovery`),
      one(db, `select (select count(*) from pg_database where not datistemplate) as dbs,
                      (select count(*) from pg_stat_activity) as conns,
                      (select count(*) from pg_stat_activity where state = 'active') as active,
                      (select coalesce(sum(pg_database_size(oid)), 0) from pg_database) as total,
                      (select count(*) from pg_roles) as roles`),
      api.appInfo(),
    ]);
    return h('div', null,
      h('div', { class: 'cards' },
        statCard('PostgreSQL', String(info.sv).split(' ')[0]),
        statCard('Databases', fmtNum(counts.dbs)),
        statCard('Total size', fmtBytes(counts.total)),
        statCard('Connections', `${counts.conns} / ${info.maxconn}`),
        statCard('Active queries', fmtNum(counts.active)),
        statCard('Roles', fmtNum(counts.roles)),
        statCard('Uptime', String(info.uptime).replace(/\.\d+$/, ''), true)),
      h('div', { class: 'card' },
        h('h3', null, 'Server'),
        h('div', { class: 'kv' },
          h('div', null, 'Version'), h('div', null, info.version),
          h('div', null, 'Address'), h('div', null, `${info.addr || 'local socket'}:${info.port || ''}`),
          h('div', null, 'Started'), h('div', null, info.started),
          h('div', null, 'Connected as'), h('div', null, `${info.usr}${S.conn.superuser ? ' (superuser)' : ''}`),
          h('div', null, 'Encoding / TimeZone'), h('div', null, `${info.enc} / ${info.tz}`),
          h('div', null, 'shared_buffers / work_mem'), h('div', null, `${info.sb} / ${info.wm}`),
          h('div', null, 'Replica (in recovery)'), h('div', null, isTrue(info.recovery) ? 'yes' : 'no'))),
      h('div', { class: 'card' },
        h('h3', null, 'My Postgres'),
        h('div', { class: 'kv' },
          h('div', null, 'App version'), h('div', null, appInfo.version),
          h('div', null, 'Electron / Chrome / Node'), h('div', null, `${appInfo.electron} / ${appInfo.chrome} / ${appInfo.node}`))));
  });
}

function createDatabaseDialog() {
  const name = h('input', { placeholder: 'new_database' });
  const owner = h('select', null, h('option', { value: '' }, '(current user)'));
  const template = h('select', null, h('option', { value: '' }, '(default: template1)'));
  const encoding = h('select', null, ['', 'UTF8', 'LATIN1', 'SQL_ASCII', 'WIN1252'].map((e) => h('option', { value: e }, e || '(default)')));
  const collate = h('input', { placeholder: 'e.g. en_US.UTF-8 (optional)' });
  rows(S.conn.database, 'select rolname from pg_roles order by 1').then((l) => l.forEach((r) => owner.appendChild(h('option', null, r.rolname))));
  rows(S.conn.database, 'select datname from pg_database order by 1').then((l) => l.forEach((r) => template.appendChild(h('option', null, r.datname))));
  modal({
    title: 'Create database',
    body: h('div', { class: 'grid2' },
      h('label', { class: 'span2' }, 'Database name', name),
      h('label', null, 'Owner', owner),
      h('label', null, 'Template', template),
      h('label', null, 'Encoding', encoding),
      h('label', null, 'Collation', collate)),
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Preview SQL',
        kind: 'primary',
        onClick: async (close) => {
          const n = name.value.trim();
          if (!n) return toast('Name required', 'warn'), false;
          const opts = [];
          if (owner.value) opts.push(`OWNER = ${qi(owner.value)}`);
          if (template.value) opts.push(`TEMPLATE = ${qi(template.value)}`);
          if (encoding.value) opts.push(`ENCODING = ${ql(encoding.value)}`);
          if (collate.value.trim()) opts.push(`LC_COLLATE = ${ql(collate.value.trim())}`, `LC_CTYPE = ${ql(collate.value.trim())}`);
          if (encoding.value || collate.value.trim()) if (!template.value) opts.push('TEMPLATE = template0');
          const sql = `CREATE DATABASE ${qi(n)}${opts.length ? '\n  ' + opts.join('\n  ') : ''};`;
          close();
          if (await runSqlDialog(S.conn.database, sql, { title: 'Create database' })) {
            refreshTree();
            if (S.serverTabs) S.serverTabs.invalidate('databases');
            openDatabaseTab(n);
          }
        },
      },
    ],
  });
}

function renderDatabases(pane, tabs) {
  fillPane(pane, async () => {
    const list = await rows(S.conn.database, `
      select d.datname as name, pg_get_userbyid(d.datdba) as owner, pg_encoding_to_char(d.encoding) as encoding,
             d.datcollate as collate, d.datistemplate as template, d.datallowconn as allowconn,
             case when has_database_privilege(d.oid, 'CONNECT') then pg_database_size(d.oid) end as size,
             (select count(*) from pg_stat_activity a where a.datid = d.oid) as conns,
             shobj_description(d.oid, 'pg_database') as comment
        from pg_database d order by d.datname`);
    const total = list.reduce((a, r) => a + Number(r.size || 0), 0);
    return h('div', null,
      sectionHead(`Databases (${list.length}, ${fmtBytes(total)})`, btn('+ Create database', createDatabaseDialog, 'primary'), btn('Refresh', () => tabs.refresh())),
      listTable(
        [
          { label: 'Name', render: (r) => (isTrue(r.allowconn) ? h('a', { onclick: () => openDatabaseTab(r.name) }, r.name) : h('span', { class: 'muted' }, r.name)) },
          { key: 'owner', label: 'Owner' },
          { key: 'encoding', label: 'Encoding' },
          { key: 'collate', label: 'Collation' },
          { label: 'Size', render: (r) => fmtBytes(r.size), class: 'right nowrap' },
          { label: 'Connections', render: (r) => fmtNum(r.conns), class: 'right' },
          { label: '', render: (r) => (isTrue(r.template) ? h('span', { class: 'badge' }, 'template') : '') },
          { key: 'comment', label: 'Comment', class: 'muted' },
        ],
        list,
        {
          actions: (r) => (isTrue(r.allowconn)
            ? [
                btn('Open', () => openDatabaseTab(r.name)),
                btn('SQL', () => openSqlTab(r.name)),
                btn('Backup', () => openDatabaseTab(r.name, 'backup')),
                !isTrue(r.template) ? btn('Drop', () => openDatabaseTab(r.name, 'ops'), 'danger') : null,
              ]
            : null),
        }
      ));
  });
}

function renderActivity(pane) {
  let timer = null;
  const auto = h('input', { type: 'checkbox' });
  const hideIdle = h('input', { type: 'checkbox', checked: true });
  const holder = h('div');
  const load = async () => {
    try {
      const list = await rows(S.conn.database, `
        select pid, datname, usename, application_name as app, client_addr::text as client, state, wait_event_type || ':' || wait_event as wait,
               backend_type as type, to_char(now() - query_start, 'HH24:MI:SS.MS') as duration,
               to_char(backend_start, 'YYYY-MM-DD HH24:MI:SS') as started, left(query, 2000) as query, pid = pg_backend_pid() as me
          from pg_stat_activity
         where ${hideIdle.checked ? "state is distinct from 'idle' and backend_type = 'client backend'" : 'true'}
         order by query_start nulls last`);
      clear(holder).appendChild(
        listTable(
          [
            { key: 'pid', label: 'PID' },
            { key: 'datname', label: 'Database' },
            { key: 'usename', label: 'User' },
            { key: 'app', label: 'Application' },
            { key: 'client', label: 'Client' },
            { label: 'State', render: (r) => h('span', { class: 'badge ' + (r.state === 'active' ? 'ok' : r.state && r.state.startsWith('idle in') ? 'err' : '') }, r.state || r.type) },
            { key: 'wait', label: 'Wait' },
            { key: 'duration', label: 'Duration', class: 'nowrap' },
            { label: 'Query', render: (r) => h('span', { class: 'mono', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, (r.query || '').slice(0, 400)) },
          ],
          list,
          {
            empty: 'No sessions',
            actions: (r) => (isTrue(r.me) ? h('span', { class: 'muted' }, 'this session') : [
              btn('Cancel', () => exec(S.conn.database, 'select pg_cancel_backend($1)', [r.pid]).then(() => (toast('Cancel sent', 'ok'), load())).catch(errorDlg)),
              btn('Terminate', async () => {
                if (await confirmDlg(`Terminate backend ${r.pid}?`, { danger: true, okLabel: 'Terminate' }))
                  exec(S.conn.database, 'select pg_terminate_backend($1)', [r.pid]).then(() => (toast('Terminated', 'ok'), load())).catch(errorDlg);
              }, 'danger'),
            ]),
          }
        )
      );
    } catch (e) {
      clear(holder).appendChild(h('div', { class: 'err-box' }, errText(e)));
    }
  };
  auto.addEventListener('change', () => {
    clearInterval(timer);
    if (auto.checked) timer = setInterval(() => (document.body.contains(holder) ? load() : clearInterval(timer)), 3000);
  });
  hideIdle.addEventListener('change', load);
  appendTo(pane, 
    h('div', { class: 'flex', style: { marginBottom: '10px' } },
      btn('Refresh', load, 'primary'),
      h('label', { class: 'check' }, auto, 'Auto-refresh (3s)'),
      h('label', { class: 'check' }, hideIdle, 'Hide idle & background sessions')),
    holder);
  load();
}

function renderLocks(pane) {
  fillPane(pane, async () => {
    const list = await rows(S.conn.database, `
      select l.pid, a.datname, l.locktype, l.mode, l.granted, coalesce(l.relation::regclass::text, '') as relation,
             a.usename, left(a.query, 300) as query, pg_blocking_pids(l.pid)::text as blocked_by
        from pg_locks l left join pg_stat_activity a on a.pid = l.pid
       where l.pid <> pg_backend_pid()
       order by l.granted, l.pid limit 500`);
    return h('div', null,
      sectionHead('Locks', btn('Refresh', () => renderLocks(pane))),
      listTable(
        [
          { key: 'pid', label: 'PID' },
          { key: 'datname', label: 'Database' },
          { key: 'locktype', label: 'Type' },
          { key: 'relation', label: 'Relation' },
          { key: 'mode', label: 'Mode' },
          { label: 'Granted', render: (r) => (isTrue(r.granted) ? h('span', { class: 'badge ok' }, 'yes') : h('span', { class: 'badge err' }, 'waiting')) },
          { label: 'Blocked by', render: (r) => (r.blocked_by === '{}' ? '' : r.blocked_by) },
          { key: 'usename', label: 'User' },
          { label: 'Query', render: (r) => h('span', { class: 'mono' }, r.query || '') },
        ],
        list,
        { empty: 'No locks held by other sessions' }
      ));
  });
}

function renderRoles(pane, tabs) {
  fillPane(pane, async () => {
    const list = await rows(S.conn.database, `
      select r.rolname as name, r.rolsuper as super, r.rolcanlogin as login, r.rolcreatedb as createdb, r.rolcreaterole as createrole,
             r.rolreplication as repl, r.rolinherit as inherit, r.rolbypassrls as bypassrls, r.rolconnlimit as connlimit,
             to_char(r.rolvaliduntil, 'YYYY-MM-DD HH24:MI') as validuntil,
             (select string_agg(b.rolname, ', ') from pg_auth_members m join pg_roles b on b.oid = m.roleid where m.member = r.oid) as memberof
        from pg_roles r
       where ${S.showSystem ? 'true' : "r.rolname not like 'pg\\_%'"}
       order by 1`);
    const flag = (v, label, cls = '') => (isTrue(v) ? h('span', { class: 'badge ' + cls }, label) : null);
    return h('div', null,
      sectionHead('Users & roles', btn('+ Create role', () => roleDialog(null, tabs), 'primary')),
      listTable(
        [
          { label: 'Role', render: (r) => h('b', null, r.name) },
          {
            label: 'Attributes',
            render: (r) => [flag(r.super, 'SUPERUSER', 'pk'), flag(r.login, 'LOGIN', 'ok'), flag(r.createdb, 'CREATEDB'), flag(r.createrole, 'CREATEROLE'), flag(r.repl, 'REPLICATION'), flag(r.bypassrls, 'BYPASSRLS')],
          },
          { key: 'memberof', label: 'Member of' },
          { label: 'Conn. limit', render: (r) => (r.connlimit === '-1' ? '∞' : r.connlimit) },
          { key: 'validuntil', label: 'Valid until' },
        ],
        list,
        {
          actions: (r) => [
            btn('Edit', () => roleDialog(r, tabs)),
            btn('Privileges', () => grantDialog(r.name)),
            r.name !== S.conn.user
              ? btn('Drop', () => runSqlDialog(S.conn.database, `DROP ROLE ${qi(r.name)};`, { title: 'Drop role', danger: true, okLabel: 'Drop' }).then((ok) => ok && tabs.refresh()), 'danger')
              : null,
          ],
        }
      ));
  });
}

function roleDialog(role, tabs) {
  const isNew = !role;
  const name = h('input', { value: role ? role.name : '' });
  const pw = h('input', { type: 'password', placeholder: isNew ? '' : 'leave empty to keep' });
  const valid = h('input', { type: 'date', value: role && role.validuntil ? role.validuntil.slice(0, 10) : '' });
  const connlimit = h('input', { type: 'number', value: role ? role.connlimit : '-1' });
  const memberOf = h('input', { value: role ? role.memberof || '' : '', placeholder: 'comma-separated role names' });
  const ck = (key, label, def) => {
    const c = h('input', { type: 'checkbox', checked: role ? isTrue(role[key]) : def });
    c.dataset.key = key;
    return { c, el: h('label', { class: 'check' }, c, label) };
  };
  const attrs = { login: ck('login', 'Can login (LOGIN)', true), super: ck('super', 'Superuser', false), createdb: ck('createdb', 'Create databases', false), createrole: ck('createrole', 'Create roles', false), inherit: ck('inherit', 'Inherit privileges', true), repl: ck('repl', 'Replication', false), bypassrls: ck('bypassrls', 'Bypass RLS', false) };
  const kw = { login: 'LOGIN', super: 'SUPERUSER', createdb: 'CREATEDB', createrole: 'CREATEROLE', inherit: 'INHERIT', repl: 'REPLICATION', bypassrls: 'BYPASSRLS' };
  modal({
    title: isNew ? 'Create role' : `Edit role ${role.name}`,
    body: h('div', { class: 'grid2' },
      h('label', null, 'Role name', name),
      h('label', null, 'Password', pw),
      h('label', null, 'Valid until', valid),
      h('label', null, 'Connection limit', connlimit),
      h('label', { class: 'span2' }, 'Member of', memberOf),
      Object.values(attrs).map((a) => a.el)),
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Preview SQL',
        kind: 'primary',
        onClick: async (close) => {
          const n = name.value.trim();
          if (!n) return toast('Name required', 'warn'), false;
          const opts = Object.entries(attrs).map(([k, a]) => (a.c.checked ? kw[k] : 'NO' + kw[k]));
          if (pw.value) opts.push(`PASSWORD ${ql(pw.value)}`);
          opts.push(`CONNECTION LIMIT ${Number(connlimit.value) || -1}`);
          if (valid.value) opts.push(`VALID UNTIL ${ql(valid.value)}`);
          else if (role && role.validuntil) opts.push(`VALID UNTIL 'infinity'`);
          const stmts = [];
          if (isNew) stmts.push(`CREATE ROLE ${qi(n)} WITH ${opts.join(' ')};`);
          else {
            if (n !== role.name) stmts.push(`ALTER ROLE ${qi(role.name)} RENAME TO ${qi(n)};`);
            stmts.push(`ALTER ROLE ${qi(n)} WITH ${opts.join(' ')};`);
          }
          const oldM = new Set((role && role.memberof ? role.memberof.split(',') : []).map((s) => s.trim()).filter(Boolean));
          const newM = new Set(memberOf.value.split(',').map((s) => s.trim()).filter(Boolean));
          for (const m of newM) if (!oldM.has(m)) stmts.push(`GRANT ${qi(m)} TO ${qi(n)};`);
          for (const m of oldM) if (!newM.has(m)) stmts.push(`REVOKE ${qi(m)} FROM ${qi(n)};`);
          close();
          if (await runSqlDialog(S.conn.database, stmts.join('\n'), { title: isNew ? 'Create role' : 'Alter role' })) tabs.refresh();
        },
      },
    ],
  });
}

async function grantDialog(roleName) {
  const dbSel = h('select');
  const dbs = await rows(S.conn.database, 'select datname from pg_database where datallowconn and not datistemplate order by 1');
  dbs.forEach((d) => dbSel.appendChild(h('option', { selected: d.datname === S.conn.database }, d.datname)));
  const schemaIn = h('input', { value: 'public' });
  const level = h('select', null,
    h('option', { value: 'connect' }, 'CONNECT to database'),
    h('option', { value: 'ro' }, 'Read-only (SELECT on all tables in schema)'),
    h('option', { value: 'rw' }, 'Read/write (SELECT, INSERT, UPDATE, DELETE)'),
    h('option', { value: 'all' }, 'ALL privileges on database & schema objects'),
    h('option', { value: 'revoke' }, 'REVOKE all privileges'));
  const defaults = h('input', { type: 'checkbox', checked: true });
  modal({
    title: `Privileges for ${roleName}`,
    body: h('div', { class: 'grid2' },
      h('label', null, 'Database', dbSel),
      h('label', null, 'Schema', schemaIn),
      h('label', { class: 'span2' }, 'Access level', level),
      h('label', { class: 'check span2' }, defaults, 'Also apply to tables created in the future (default privileges)')),
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Preview SQL',
        kind: 'primary',
        onClick: async (close) => {
          const r = qi(roleName);
          const d = qi(dbSel.value);
          const s = qi(schemaIn.value.trim() || 'public');
          const st = [];
          const v = level.value;
          if (v === 'revoke') {
            st.push(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM ${r};`, `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM ${r};`, `REVOKE ALL ON SCHEMA ${s} FROM ${r};`, `REVOKE ALL ON DATABASE ${d} FROM ${r};`);
            if (defaults.checked) st.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON TABLES FROM ${r};`);
          } else {
            st.push(`GRANT ${v === 'all' ? 'ALL PRIVILEGES' : 'CONNECT'} ON DATABASE ${d} TO ${r};`);
            if (v !== 'connect') {
              const tp = v === 'ro' ? 'SELECT' : v === 'rw' ? 'SELECT, INSERT, UPDATE, DELETE' : 'ALL PRIVILEGES';
              st.push(`GRANT ${v === 'all' ? 'ALL' : 'USAGE'} ON SCHEMA ${s} TO ${r};`);
              st.push(`GRANT ${tp} ON ALL TABLES IN SCHEMA ${s} TO ${r};`);
              if (v !== 'ro') st.push(`GRANT USAGE, SELECT${v === 'all' ? ', UPDATE' : ''} ON ALL SEQUENCES IN SCHEMA ${s} TO ${r};`);
              if (defaults.checked) st.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT ${tp} ON TABLES TO ${r};`);
            }
          }
          close();
          await runSqlDialog(dbSel.value, st.join('\n'), { title: 'Privileges' });
        },
      },
    ],
  });
}

function renderSettings(pane) {
  fillPane(pane, async () => {
    const list = await rows(S.conn.database, `select name, setting, unit, category, short_desc, context, source, boot_val, reset_val, pending_restart from pg_settings order by category, name`);
    const search = h('input', { placeholder: 'Search settings…', style: { width: '320px' } });
    const holder = h('div');
    const paint = () => {
      const f = search.value.toLowerCase();
      clear(holder).appendChild(
        listTable(
          [
            { label: 'Name', render: (r) => h('b', { class: 'mono' }, r.name) },
            { label: 'Value', render: (r) => h('span', { class: 'mono' }, r.setting + (r.unit ? ' ' + r.unit : ''), isTrue(r.pending_restart) ? h('span', { class: 'badge err', style: { marginLeft: '6px' } }, 'restart pending') : null) },
            { label: 'Category', render: (r) => (r.category || '').split(' / ').pop(), class: 'muted' },
            { key: 'short_desc', label: 'Description' },
            { key: 'context', label: 'Context', class: 'muted' },
            { key: 'source', label: 'Source', class: 'muted' },
          ],
          list.filter((r) => !f || r.name.includes(f) || (r.short_desc || '').toLowerCase().includes(f) || (r.category || '').toLowerCase().includes(f)),
          {
            actions: S.conn.superuser
              ? (r) => (r.context === 'internal' ? null : btn('Edit', async () => {
                  const v = await promptDlg(`New value for ${r.name}${r.unit ? ' (unit: ' + r.unit + ')' : ''}\nContext: ${r.context}`, { title: 'ALTER SYSTEM', value: r.setting });
                  if (v === null) return;
                  const ok = await runSqlDialog(S.conn.database, `ALTER SYSTEM SET ${r.name} = ${ql(v)};\nSELECT pg_reload_conf();`, { title: 'Change server setting' });
                  if (ok && r.context === 'postmaster') toast('This setting requires a server restart to take effect.', 'warn');
                  if (ok) renderSettings(pane);
                }))
              : null,
          }
        )
      );
    };
    search.addEventListener('input', debounce(paint, 150));
    paint();
    return h('div', null, h('div', { class: 'flex', style: { marginBottom: '10px' } }, search, h('span', { class: 'help' }, S.conn.superuser ? 'Edits use ALTER SYSTEM and reload the configuration.' : 'Superuser privileges are required to change settings.')), holder);
  });
}
