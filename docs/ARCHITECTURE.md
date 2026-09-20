# KS Table – Architecture & Conventions

KS Table is an original desktop database manager for **MySQL / MariaDB**. Stack: **Electron + React 18 +
TypeScript 7**, bundled with electron-vite (Vite 7).
All code, names, icons and texts are our own.

## 1. Running & checking

| Task | Command |
| --- | --- |
| Type-check (must stay at 0 errors in your files) | `npx tsc --noEmit -p tsconfig.web.json` and `npx tsc --noEmit -p tsconfig.node.json` |
| Unit tests (vitest, files `src/**/*.test.ts`) | `npx vitest run <path>` |
| Browser dev mode (already running during development) | `npm run dev:web` → renderer http://localhost:5174, backend WebSocket 127.0.0.1:5199 |
| Electron dev | `npm run dev` |

Node is installed but not on the default PATH of new shells. In PowerShell prefix commands with
`$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User");`

**Test database**: portable MySQL 8.4 on `127.0.0.1:3307`, user `root`, password `kstable` (already running – never start/stop it).
Sample databases: `ks_shop` (main demo: 12 tables incl. every column type, FKs, checks, generated columns, views,
functions, procedures, triggers, events; `page_views` has 200 000 rows), `ks_hr`, `ks_shop_staging` (structural variant of
ks_shop for sync tests). Never modify these destructively. For tests create your own scratch databases named
`ks_t_<feature>` and drop them when done.

**Backend test harness**: `src/devserver/harness.ts` → `const { api, ctx, connectionId, shutdown } = await bootBackend();`
boots the real backend with an isolated user-data dir and a saved connection profile for the test server.
Run scripts with `npx tsx --tsconfig tsconfig.node.json <file.ts>` (put throw-away scripts in your scratchpad, real tests in
`src/**/__tests__/*.test.ts`).

## 2. Source layout

```
src/shared/            code used by backend AND renderer (no Node / DOM specifics)
  types.ts             domain types (connections, metadata, results, TableDesign, tasks, settings …)
  api.ts               RPC contract (Api interface) + EventMap (backend → renderer events)
  apis/*.ts            RPC interfaces of feature namespaces (users, io, sync, admin, backup, automation, datagen, model, profiles, snippets)
  i18n.ts              tr('Deutsch', 'English', params?)
  util.ts              deepMerge, formatBytes, formatNumber, formatDuration, formatDateTime, uniqueName, safeFileName
  defaults.ts          newId, defaultConnection, defaultSettings, newField, newTableDesign, SYSTEM_SCHEMAS
  sql/quote.ts         quoteId, qname, quoteString, literal, hexLiteral, toHex/fromHex, parseEnumValues, escapeLike
  sql/splitter.ts      splitStatements (DELIMITER, BEGIN…END blocks), statementAt, firstKeyword, isUnsafeWrite
  sql/ddl.ts           createTableSql, alterTableSql, syncTableSql, asExisting, columnDefinition, indexDefinition, fkDefinition, triggerSql …
src/backend/           Node backend (runs inside Electron main or the dev WebSocket server)
  api.ts               createBackend(): composes the Api object; BackendContext; dispatch()
  db/driver.ts         SqlConn (mysql2 wrapper: run() with row limit, result normalisation)
  db/sessions.ts       SessionManager / Session (one MySQL connection per session, SSH tunnel, auto reconnect)
  db/meta.ts           metadata queries; db/design.ts loadTableDesign; db/data.ts table viewer fetch/apply; db/exec.ts QueryRunner
  features/<ns>.ts     implementation of feature namespaces (createXxxApi(ctx))
  store/*              settings, connection profiles (encrypted secrets), history log
  tasks.ts             TaskManager for long running jobs (progress + log events, cancel)
src/main, src/preload  Electron entry points;  src/devserver  dev WebSocket host + test harness
src/renderer/src/      React app
  api/client.ts        `api` proxy (api.meta.tables(sessionId, db) …), onEvent(channel, cb), RpcError, errorMessage/errorCode
  store/               zustand stores: workspace (profiles + runtime state), tabs, nav (navigator selection), settings
  actions/             user actions (connection, database, objects, query, tools, menus = context menus)
  layout/              main window parts (TitleBar, MainToolbar, Navigator, TabArea, InfoPane, StatusBar)
  components/          UI kit and shared widgets (see §6)
  features/<feature>/  feature modules (tabs, dialogs, panels) – one directory per feature
  tabs/registry.tsx    tab kind → lazily loaded component (auto-discovered via import.meta.glob)
  styles/              app.css (theme tokens), ui.css (kit), layout.css, components.css
```

## 3. RPC between renderer and backend

* Renderer calls `api.<namespace>.<method>(...args)` – every method returns a Promise. Errors arrive as `RpcError`
  (`message`, `code`, `errno`, `sqlState`, `sql`); show them with `errorDialog(e)`.
* **Adding methods to your feature namespace**: extend the interface in `src/shared/apis/<ns>.ts` and implement it in
  `src/backend/features/<ns>.ts` (`createXxxApi(ctx: BackendContext)`). The namespace is already wired into `Api`
  and `createBackend()` – you do not need to touch `api.ts` files.
* Arguments / results must be structured-clone / JSON friendly (plain objects, arrays, strings, numbers, booleans, null,
  `Uint8Array`). No functions, no class instances, no `Date` (use ISO strings or epoch ms), no `bigint` (use strings).
* Backend → renderer events: `emit(channel, payload)` in backend (`src/backend/events.ts`), `onEvent(channel, cb)` in the
  renderer. Channels are declared in `EventMap` (`src/shared/api.ts`); prefer the generic task events for jobs.

### Sessions (MySQL connections)
* Every tab that executes user SQL opens **its own session** and closes it on unmount:
  `const info = await openSessionWithPrompt(connectionId, database)` (store/workspace – asks for passwords if needed)
  … `api.session.close(info.sessionId)`.
* Quick metadata / DDL from the renderer may use the navigator session: `metaSession(connectionId)` or
  `runSql(connectionId, sql)` (actions/sql.ts, throws on the first failing statement). Do not change session state
  (USE, SET, transactions) on the navigator session.
* Useful calls: `api.query.execute(sessionId, sql, { maxRows, stopOnError, queryId, noSplit, history })`,
  `api.query.cancel(sessionId)`, `api.meta.*` (databases, tables, views, routines, events, triggers, columns, ddl,
  charsets, collations, engines, tableDesign, completion), `api.data.fetch/count/apply` (table viewer).
* Backend side (tasks): `const s = await ctx.sessions.open(connectionId, database)` → `s.rows(sql, values)`,
  `s.rowset(sql)`, `s.exec(sql)`, `s.run(sql, { maxRows, values })`; always `await ctx.sessions.close(s.id)` in `finally`.
  Credentials entered by the user are cached per connection, so tasks work for connections the user has opened.
* Result values: all non-binary values are **strings** (exact DECIMAL/BIGINT, dates as text), `null` for NULL,
  `Uint8Array` for binary / BLOB / BIT / GEOMETRY (MySQL internal format: 4-byte SRID + WKB).

### Long running jobs (tasks)
```ts
// backend
const taskId = ctx.tasks.start('export', tr('Export', 'Export'), async (t) => {
  t.log('info', tr('Exportiere {n} …', 'Exporting {n} …', { n: table }));
  t.progress(done / total, `${done}/${total}`);   // 0..1 or null (indeterminate)
  t.throwIfCancelled();                           // call regularly
  return { rows: total };                         // becomes TaskInfo.result
});
return taskId;
```
Renderer: `<TaskPanel taskId={id} />` (progress bar, live log, stop button) or `useTask(taskId)` for custom UIs.

Saved profiles that automation (batch jobs) can execute: register a headless runner at module load
(`registerProfileRunner(kind, (ctx, profile, task) => …)` from `src/backend/profileRunners.ts`). The runner receives
exactly the object stored with `api.profiles.save(kind, name, data)`. Kinds: `import`, `export`, `dumpSql`,
`execSqlFile`, `dataTransfer`, `dataSync`, `structSync`, `backup`.

## 4. Tabs

* Open: `useTabs.getState().open({ kind, title, icon, params, key?, connectionId?, subtitle? })` – tabs with the same
  `key` are reused. Close guard for unsaved changes: `setCloseGuard(tab.id, async () => boolean)` (use `askDialog`).
  Mark dirty / rename: `useTabs.getState().update(tab.id, { dirty, title })`.
* A tab module is `src/renderer/src/features/<dir>/<Name>Tab.tsx` with a **default export** `(props: TabProps) => JSX`
  (`props.tab.params`, `props.active`). It is picked up automatically through `TAB_MODULES` in `tabs/registry.tsx`.
* Entry points (menus, toolbars, context menus) already exist in `actions/tools.ts`, `actions/objects.tsx`,
  `actions/query.ts`, `actions/menus.tsx` and open these kinds with these params:

| kind | module | params |
| --- | --- | --- |
| tableData | tableData/TableDataTab | `{ connectionId, database, table, view: boolean, where?: string }` (`where` = initial filter) |
| tableDesign | tableDesign/TableDesignTab | `{ connectionId, database, table: string \| null }` (null = new table) |
| viewDesign | viewDesign/ViewDesignTab | `{ connectionId, database, view: string \| null }` |
| routineDesign | routineDesign/RoutineDesignTab | `{ connectionId, database, name: string \| null, routineType: 'FUNCTION' \| 'PROCEDURE' }` |
| eventDesign | eventDesign/EventDesignTab | `{ connectionId, database, name: string \| null }` |
| query | query/QueryTab | `{ connectionId, database: string \| null, sql: string \| null, file: string \| null, saved?: boolean }` |
| userDesign | users/UserDesignTab | `{ connectionId, user: string \| null, host: string \| null }` |
| privileges | users/PrivilegesTab | `{ connectionId }` |
| console | console/ConsoleTab | `{ connectionId, database: string \| null }` |
| serverMonitor | monitor/ServerMonitorTab | `{ connectionId: string \| null }` |
| findInDb | find/FindTab | `{ connectionId, database: string \| null }` |
| history | history/HistoryTab | `{}` |
| snippets | snippets/SnippetsTab | `{}` |
| import | io/ImportTab | `{ connectionId, database: string \| null, table: string \| null }` |
| export | io/ExportTab | `{ connectionId, database: string \| null, tables: string[] \| null, query: string \| null }` |
| dumpSql | io/DumpSqlTab | `{ connectionId, database, tables: string[] \| null, structureOnly: boolean }` |
| execSqlFile | io/ExecSqlFileTab | `{ connectionId, database: string \| null }` |
| dataTransfer | sync/DataTransferTab | `{ connectionId, database, tables: string[] \| null }` (all may be null) |
| dataSync | sync/DataSyncTab | `{ connectionId, database }` (may be null) |
| structSync | sync/StructSyncTab | `{ connectionId, database }` (may be null) |
| model | model/ModelTab | `{ file: string \| null, reverse?: { connectionId, database } }` |
| charts | charts/ChartsTab | `{}` |
| backup | backup/BackupTab | `{ connectionId, database, mode: 'backup' \| 'restore' \| 'extract', file?: string }` |
| automation | automation/AutomationTab | `{}` |
| dataGen | datagen/DataGenTab | `{ connectionId, database, tables: string[] \| null }` |
| options | options/OptionsTab | `{}` |
| profiling | profiling/ProfilingTab | `{ connectionId, database, table }` |

* Other plug-in points discovered automatically when the file exists:
  `features/users/UsersPane.tsx` (default export `({ connectionId }) => JSX`, shown in the Objects tab when the toolbar
  button "Benutzer" is active) and `features/model/ErDiagramView.tsx` (default export, props `ErViewProps` from
  `features/objects/ObjectsTab.tsx`, shown as third view mode of the table list).
* `features/queryBuilder/index.ts` exports `openQueryBuilder({ connectionId, database, sql? }): Promise<string | null>`
  (visual query builder dialog, implemented by the model feature; used by the query editor and the view designer).

## 5. Workspace state

`useWorkspace` (store/workspace.ts): `profiles`, `groups`, `conns[connectionId] = { status, sessionId, server,
databases, dbs[db] = { loaded, tables, views, routines, events, queries, backups } }`, `profilesDir`.
After changing objects call `useWorkspace.getState().refreshDatabase(connectionId, db, ['tables'])` (lists: tables,
views, routines, events, queries, backups) or `refreshConnection(connectionId)` (databases).
Saved queries live in `queriesDir(profilesDir, connectionId, db)` (`*.sql`), backups in `backupsDir(...)` (`*.ksbak`).
Saved wizard settings: `api.profiles.list/load/save/remove(kind, name, data)`.
Settings: `useSettings((s) => s.settings)` / `getSettings()`; `AppSettings` in shared/types.ts.

## 6. UI kit (use it – do not build parallel versions)

* `components/ui/controls.tsx`: `Button` (variant default|primary|danger|ghost|link, size sm|md, icon),
  `IconButton`, `TextInput`, `NumberInput`, `TextArea`, `Select` (options: strings or {value,label}), `Checkbox`,
  `RadioGroup`, `Field` (label + control row, `labelWidth`), `Section` (group box), `TabStrip`, `Spinner`,
  `ProgressBar`, `Toolbar` + `ToolbarButton` (inline icon+label; `onDropdown` for split buttons) + `ToolbarSep`,
  `SearchInput`, `EmptyState`, `ColorSwatches`.
* `components/ui/Dialog.tsx`: `openDialog(close => <Dialog …/>)` → Promise; `Dialog` props: title, icon, width,
  height, onClose, onSubmit (Enter), footer, footerLeft, noPadding, resizable. Helpers `confirmDialog`, `askDialog`
  (yes/no/cancel), `alertDialog`, `errorDialog(e)`, `promptDialog`.
* `components/ui/Menu.tsx`: `showContextMenu(e, items)`, `showMenuBelow(el, items)`; items
  `{ label, icon, shortcut, disabled, danger, checked, onClick, submenu }` or `SEP`.
* `components/ui/PathInput.tsx` (file/folder picker field), `lib/files.ts` (`pickOpenFile`, `pickOpenFiles`,
  `pickSaveFile`, `pickDirectory`, `joinPath`, `baseName`, `dirName`, `stripExt`) – work in Electron and browser mode.
* `components/Toast.tsx` `toast(text, 'info'|'success'|'error')`; `components/icons.tsx` `ObjIcon kind=…`;
  `components/SqlHighlight.tsx` (read-only SQL), `components/ObjectTable.tsx` (virtualized list with sortable columns),
  `components/TaskPanel.tsx`.
* **Data grid** `components/grid/DataGrid.tsx`: `<DataGrid columns={GridColumnDef[]} rowCount getValue={(row,col)=>CellValue}
  editable onEdit rowState cellModified onCellContextMenu onHeaderContextMenu onHeaderClick sortState freezeColumns
  rowNumberOffset searchOpen onSearchClose ref={DataGridHandle} />`; helpers in `components/grid/cellFormat.ts`
  (`columnFromResult`, `columnFromMeta`, `displayText`, `editText`, `geometryToWkt`, `imageMime`).
* **SQL editor** `components/editor/SqlEditor.tsx`: `<SqlEditor value onChange completion={{ connectionId, database }}
  onMount={(editor, monaco) => …} language="mysql" readOnly options />`; `insertAtCursor(editor, text)`;
  `beautifySql`, `minifySql` from `components/editor/monaco.ts`; extra completion sources via
  `registerCompletionSource` (components/editor/completion.ts).
* Icons: `lucide-react` 1.x (names like `TriangleAlert`, `CircleCheck`, `Trash2`, `Ellipsis`, `ChartColumn`).
* Keyboard: `keyCombo(e)` from `lib/shortcuts.ts` → `'Ctrl+Shift+F'`. Components that handle a key call
  `e.stopPropagation()` so global shortcuts do not fire.
* Available libraries (do NOT install others): react 18, zustand, @glideapps/glide-data-grid, monaco-editor 0.56,
  @xyflow/react 12, @dagrejs/dagre, echarts 6, html-to-image, sql-formatter, node-sql-parser, lucide-react, clsx,
  @tanstack/react-virtual, react-resizable-panels 4 (`Group`/`Panel`/`Separator`, `orientation`, sizes: number = px,
  string = %), backend: mysql2, ssh2, exceljs, papaparse, fast-xml-parser, yazl/yauzl, nodemailer, @faker-js/faker,
  iconv-lite.

## 7. Look & feel

* Desktop density: 13px UI font (Segoe UI), controls 26–28px high, 24px list rows. Each tab: optional `Toolbar` on top,
  content, `ks-statusline` (24px) at the bottom. Designers use `TabStrip` for their sections and `Field` forms
  (label width 130–160px). Wizards may use the `.ks-wizard*` classes (components.css).
* Plain CSS with the tokens from `styles/app.css` (`--bg-panel`, `--bg-toolbar`, `--fg`, `--fg-muted`, `--border`,
  `--accent`, `--danger`, `--success`, `--warning`, `--c-table` …, `--font-mono`, `--radius`). **Dark mode must work**:
  never hard-code light colors. Each feature has its own CSS file imported by its entry component; class prefix
  `ks-<feature>-`.
* All visible text – including backend messages and task logs – via `tr('Deutsch', 'English')`. German is primary; use
  real umlauts and consistent terms: Verbindung, Datenbank, Tabelle, Ansicht, Funktion, Prozedur, Ereignis, Trigger,
  Abfrage, Sicherung, Datensatz, Feld, Index, Fremdschlüssel, Primärschlüssel, Benutzer, Rechte, Rolle.
* Errors: `errorDialog(e)` for actions, task log lines for jobs. Confirm destructive actions (`confirmDialog` with
  `danger`). Keyboard accessible, no console errors.

## 8. Rules for parallel feature work

* Only create/modify files you own: `src/renderer/src/features/<your dirs>/**`, `src/backend/features/<your ns>.ts`
  (or a directory `src/backend/features/<your ns>/**`), `src/shared/apis/<your ns>.ts`, and new shared helpers under
  `src/shared/<your feature>/**`. Shared files are off limits unless your task explicitly allows a minimal `Edit`.
* Never run `npm install`, never edit package.json, never run git, never start/stop servers or MySQL, never use the
  browser tools (the lead developer does visual testing).
* Other features are being written at the same time: type errors in files you do not own are not your concern, but your
  files must type-check cleanly. If you need something from another area, work with what exists and mention it in
  your final report.
* Quality bar: complete, working functionality end to end (backend + UI), no placeholders or TODOs, robust error
  handling, verified against the test database with the harness.
