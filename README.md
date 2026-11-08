<p align="center">
  <img src="build/icon.png" alt="My Postgres icon" width="128" height="128" />
</p>

# My Postgres

A desktop PostgreSQL management tool for Linux (Electron), similar in spirit to phpMyAdmin.

## Features

- **Connections:** saved connections, with passwords encrypted by the system keyring. SSL is supported, and you can test a connection before saving it.
- **Navigator:** a tree of server → databases → schemas → tables, views, materialized views, functions and sequences, with filtering and context menus.
- **Browse and edit data:** pagination, column sorting, `WHERE` filters and a quick filter builder. Double-click a cell to edit it, use the row editor form, insert rows, set cells to NULL, and delete selected rows. Editing uses the primary key, or `ctid` when a table has no primary key.
- **Structure:** add, edit and drop columns (rename, change type, default, NOT NULL, comment). Create and drop indexes, constraints (PK, UNIQUE, FK, CHECK) and triggers.
- **SQL editor:** syntax highlighting and autocomplete for tables and columns. Runs several statements and shows one result tab per statement. Supports run current statement, EXPLAIN / EXPLAIN ANALYZE, cancel, transactions (commit/rollback), history, opening and saving `.sql` files, and exporting results.
- **Import/export:** export tables to CSV, JSON or SQL INSERT statements (streamed). Import CSV with column mapping, inside a transaction.
- **Operations:** rename a table, move it to another schema, change its owner or comment, copy it, TRUNCATE or DROP it. VACUUM, ANALYZE, REINDEX and REFRESH MATERIALIZED VIEW are also available.
- **Database:** tables overview with bulk actions, schemas, functions, extensions (install/uninstall), maintenance stats, backup and restore (`pg_dump`, `pg_restore`, `psql`), and rename/drop.
- **Server:** overview, create and drop databases, live activity (cancel or terminate backends), locks, users and roles (create, edit, grant privileges), and settings (with ALTER SYSTEM for superusers).
- Dark and light themes.

## Install (Ubuntu)

```bash
sudo apt install ./dist/my-postgres_1.0.0_amd64.deb
# optional, for backup/restore:
sudo apt install postgresql-client
```

Launch **My Postgres** from the applications menu, or run `my-postgres`.
To uninstall: `sudo apt remove my-postgres`.

You can also use the portable AppImage:

```bash
chmod +x "dist/My Postgres-1.0.0.AppImage" && "./dist/My Postgres-1.0.0.AppImage"
```

## Development

```bash
npm install
npm start          # run the app
npm run dist       # build dist/*.deb and dist/*.AppImage
```

Note: build the `.deb` from a regular terminal. electron-builder's bundled `fpm` needs `libcrypt.so.1`, which sandboxed (Flatpak) terminals lack.

## Layout

- `main.js`: main process (pg connection pools and sessions, export streaming, pg_dump/psql runner, saved connections)
- `preload.js`: secure IPC bridge (`window.api`)
- `src/renderer/`: UI (vanilla JS + CodeMirror 5)
  - `js/views/table.js`: browse, edit, structure, import/export, operations and DDL
  - `js/views/database.js`, `js/views/server.js`, `js/views/sql.js`
- `scripts/make-icon.js`: generates `build/icon.png`
