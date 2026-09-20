// Data dictionary: self-contained HTML documentation of tables (columns, keys, indexes, foreign keys,
// checks, triggers), views, routines and events – generated for a database or for a model.

import type { FieldDef, ForeignKeyDef, TableDesign, TableStatus } from '../types';
import type { EventInfo, RoutineInfo } from '../apis/model';
import { createTableSql, defaultSql, fieldTypeSql } from '../sql/ddl';
import { getLang, tr } from '../i18n';
import { formatBytes, formatNumber } from '../util';

export interface DictTable {
  design: TableDesign;
  status?: TableStatus | null;
}

export interface DictView {
  name: string;
  definition: string;
  algorithm?: string;
  security?: string;
  checkOption?: string;
  definer?: string;
  comment?: string;
}

export interface DictionaryInput {
  title: string;
  subtitle: string;
  description: string;
  /** e.g. "Verbindung Produktion · Datenbank shop" or "Modell shop.ksmodel" */
  source: string;
  server: string;
  charset: string;
  collation: string;
  generatedAt: string;
  tables: DictTable[];
  views: DictView[];
  routines: RoutineInfo[];
  events: EventInfo[];
}

export interface DictionaryOptions {
  toc: boolean;
  indexes: boolean;
  foreignKeys: boolean;
  referencedBy: boolean;
  checks: boolean;
  triggers: boolean;
  views: boolean;
  routines: boolean;
  events: boolean;
  ddl: boolean;
  /** Follow the dark mode of the viewer (prefers-color-scheme) */
  autoDark: boolean;
  serverType: 'mysql' | 'mariadb';
}

export function defaultDictionaryOptions(): DictionaryOptions {
  return {
    toc: true,
    indexes: true,
    foreignKeys: true,
    referencedBy: true,
    checks: true,
    triggers: true,
    views: true,
    routines: true,
    events: true,
    ddl: false,
    autoDark: true,
    serverType: 'mysql'
  };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const lc = (s: string) => s.toLowerCase();

const CSS = `
:root{--fg:#1d2228;--muted:#5f6772;--faint:#98a0aa;--bg:#fff;--bg2:#f5f7fa;--border:#dfe3e8;--accent:#2563eb;--code:#f6f8fa;
--pk-bg:#fdf1c8;--pk:#8a6400;--fk-bg:#efe7ff;--fk:#6d28d9;--uq-bg:#e0f2fe;--uq:#0369a1;--ix-bg:#eef0f3;--ix:#475569}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 'Segoe UI',system-ui,-apple-system,sans-serif;color:var(--fg);background:var(--bg)}
.page{max-width:1120px;margin:0 auto;padding:36px 44px 64px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.cover{border-bottom:3px solid var(--accent);padding-bottom:22px;margin-bottom:8px}
.eyebrow{text-transform:uppercase;letter-spacing:.08em;color:var(--accent);font-weight:700;font-size:12px}
h1{font-size:30px;line-height:1.2;margin:6px 0 4px}
.sub{font-size:16px;color:var(--muted);margin:0}
.desc{margin:14px 0 0;white-space:pre-wrap}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:3px 18px;margin:16px 0 0;font-size:13px}
dl.meta dt{color:var(--muted)}dl.meta dd{margin:0}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.stat{border:1px solid var(--border);border-radius:8px;padding:8px 14px;min-width:100px;background:var(--bg2)}
.stat b{display:block;font-size:20px;line-height:1.3}.stat span{color:var(--muted);font-size:12px}
h2{font-size:21px;margin:42px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
h3{font-size:17px;margin:0}
h4{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:18px 0 6px}
nav.toc ol{columns:2;column-gap:36px;padding-left:22px;margin:6px 0}
nav.toc li{break-inside:avoid;margin:1px 0}
nav.toc .c{color:var(--faint);font-size:12px}
.obj{border:1px solid var(--border);border-radius:8px;padding:16px 18px;margin:16px 0;background:var(--bg)}
.obj-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.kind{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:0 6px}
.comment{margin:6px 0 0;white-space:pre-wrap}
.facts{color:var(--muted);font-size:12.5px;margin:6px 0 10px}
table.grid{border-collapse:collapse;width:100%;font-size:13px}
table.grid th{text-align:left;background:var(--bg2);font-weight:600;white-space:nowrap}
table.grid th,table.grid td{border-bottom:1px solid var(--border);padding:5px 8px;vertical-align:top}
table.grid td.n{color:var(--faint);text-align:right;width:28px}
table.grid td.name{font-weight:600;white-space:nowrap}
code,pre{font-family:'Cascadia Mono',Consolas,'Courier New',monospace;font-size:12px}
td code{white-space:pre-wrap;word-break:break-word}
pre{background:var(--code);border:1px solid var(--border);border-radius:6px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;margin:6px 0 0}
.badge{display:inline-block;font-size:10.5px;font-weight:700;padding:0 5px;border-radius:4px;margin:0 3px 2px 0;line-height:17px;white-space:nowrap}
.b-pk{background:var(--pk-bg);color:var(--pk)}.b-fk{background:var(--fk-bg);color:var(--fk)}.b-uq{background:var(--uq-bg);color:var(--uq)}.b-ix{background:var(--ix-bg);color:var(--ix)}
.muted{color:var(--muted)}
details{margin-top:12px}summary{cursor:pointer;color:var(--muted);font-size:13px}
footer{margin-top:52px;padding-top:10px;border-top:1px solid var(--border);color:var(--faint);font-size:12px}
@media print{.page{max-width:none;padding:0}.obj{break-inside:avoid}h2{break-after:avoid}nav.toc{break-after:page}a{color:inherit}details{display:block}}
`;

const DARK = `
@media (prefers-color-scheme:dark){:root{--fg:#e2e5ea;--muted:#a0a7b1;--faint:#6f7680;--bg:#1d2025;--bg2:#252930;--border:#353a42;--accent:#6ea0ff;--code:#22262c;
--pk-bg:#3d3418;--pk:#f5cf55;--fk-bg:#2f2547;--fk:#c4a8ff;--uq-bg:#16324a;--uq:#7dc6f5;--ix-bg:#2c3139;--ix:#aab4c3}}
`;

function badge(kind: string, text: string, title: string): string {
  return `<span class="badge b-${kind}" title="${esc(title)}">${esc(text)}</span>`;
}

function keyBadges(d: TableDesign, f: FieldDef): string {
  const n = lc(f.name);
  const out: string[] = [];
  const pk = d.primaryKey.findIndex((x) => lc(x) === n);
  if (pk >= 0) out.push(badge('pk', d.primaryKey.length > 1 ? `PK ${pk + 1}` : 'PK', tr('Primärschlüssel', 'Primary key')));
  if (d.foreignKeys.some((fk) => fk.fields.some((x) => lc(x) === n))) out.push(badge('fk', 'FK', tr('Fremdschlüssel', 'Foreign key')));
  const kinds = new Set<string>();
  for (const ix of d.indexes) {
    if (!ix.fields.some((p) => lc(p.name) === n)) continue;
    kinds.add(ix.type);
  }
  if (kinds.has('UNIQUE')) out.push(badge('uq', 'UQ', tr('Eindeutiger Index', 'Unique index')));
  if (kinds.has('NORMAL')) out.push(badge('ix', 'IX', tr('Index', 'Index')));
  if (kinds.has('FULLTEXT')) out.push(badge('ix', 'FT', tr('Volltextindex', 'Fulltext index')));
  if (kinds.has('SPATIAL')) out.push(badge('ix', 'SP', tr('Räumlicher Index', 'Spatial index')));
  return out.join('');
}

function extraText(f: FieldDef): string {
  const parts: string[] = [];
  if (f.autoIncrement) parts.push('AUTO_INCREMENT');
  if (f.generated && f.generatedExpr.trim()) parts.push(`${tr('Berechnet', 'Generated')} (${f.generatedStored ? 'STORED' : 'VIRTUAL'}): ${f.generatedExpr.trim()}`);
  if (f.onUpdateCurrentTimestamp) parts.push('ON UPDATE CURRENT_TIMESTAMP');
  if (f.invisible) parts.push('INVISIBLE');
  if (f.srid) parts.push(`SRID ${f.srid}`);
  return parts.join(' · ');
}

const actionText = (a: string) => a || 'RESTRICT';

export function buildDictionaryHtml(input: DictionaryInput, o: DictionaryOptions): string {
  const used = new Set<string>();
  const anchor = (prefix: string, name: string) => {
    const base = `${prefix}-${lc(name).replace(/[^a-z0-9_-]+/g, '-') || 'x'}`;
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return id;
  };
  const tableIds = new Map(input.tables.map((t) => [lc(t.design.name), anchor('t', t.design.name)]));
  const views = o.views ? input.views : [];
  const routines = o.routines ? input.routines : [];
  const events = o.events ? input.events : [];
  const viewIds = new Map(views.map((v) => [lc(v.name), anchor('v', v.name)]));
  const routineIds = routines.map((r) => anchor(r.type === 'FUNCTION' ? 'f' : 'p', r.name));
  const eventIds = events.map((e) => anchor('e', e.name));
  const tableLink = (name: string) => {
    const id = tableIds.get(lc(name));
    return id ? `<a href="#${id}">${esc(name)}</a>` : esc(name);
  };
  const incoming = new Map<string, { table: string; fk: ForeignKeyDef }[]>();
  for (const t of input.tables) {
    for (const fk of t.design.foreignKeys) {
      if (fk.refSchema && lc(fk.refSchema) !== lc(t.design.schema)) continue;
      const k = lc(fk.refTable);
      if (!incoming.has(k)) incoming.set(k, []);
      incoming.get(k)!.push({ table: t.design.name, fk });
    }
  }
  const columnCount = input.tables.reduce((n, t) => n + t.design.fields.length, 0);
  const fkCount = input.tables.reduce((n, t) => n + t.design.foreignKeys.length, 0);

  const h: string[] = [];
  h.push(`<!DOCTYPE html><html lang="${getLang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`);
  h.push(`<title>${esc(input.title)}</title><style>${CSS}${o.autoDark ? DARK : ''}</style></head><body><div class="page">`);

  // cover
  h.push('<header class="cover">');
  h.push(`<div class="eyebrow">${esc(tr('Datenwörterbuch', 'Data Dictionary'))}</div><h1>${esc(input.title)}</h1>`);
  if (input.subtitle) h.push(`<p class="sub">${esc(input.subtitle)}</p>`);
  if (input.description) h.push(`<p class="desc">${esc(input.description)}</p>`);
  const meta: [string, string][] = [
    [tr('Quelle', 'Source'), input.source],
    [tr('Server', 'Server'), input.server],
    [tr('Zeichensatz', 'Character set'), [input.charset, input.collation].filter(Boolean).join(' / ')],
    [tr('Erstellt', 'Generated'), input.generatedAt]
  ];
  h.push(`<dl class="meta">${meta.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`);
  const stats: [number, string][] = [
    [input.tables.length, tr('Tabellen', 'Tables')],
    [columnCount, tr('Felder', 'Fields')],
    [fkCount, tr('Fremdschlüssel', 'Foreign keys')]
  ];
  if (o.views) stats.push([views.length, tr('Ansichten', 'Views')]);
  if (o.routines) stats.push([routines.length, tr('Routinen', 'Routines')]);
  if (o.events) stats.push([events.length, tr('Ereignisse', 'Events')]);
  h.push(`<div class="stats">${stats.map(([n, l]) => `<div class="stat"><b>${formatNumber(n)}</b><span>${esc(l)}</span></div>`).join('')}</div>`);
  h.push('</header>');

  // table of contents
  if (o.toc) {
    h.push(`<nav class="toc"><h2>${esc(tr('Inhalt', 'Contents'))}</h2>`);
    const list = (title: string, items: string[]) => {
      if (items.length) h.push(`<h4>${esc(title)}</h4><ol>${items.join('')}</ol>`);
    };
    list(
      tr('Tabellen', 'Tables'),
      input.tables.map((t) => `<li><a href="#${tableIds.get(lc(t.design.name))}">${esc(t.design.name)}</a>${t.design.comment ? ` <span class="c">– ${esc(t.design.comment)}</span>` : ''}</li>`)
    );
    list(tr('Ansichten', 'Views'), views.map((v) => `<li><a href="#${viewIds.get(lc(v.name))}">${esc(v.name)}</a></li>`));
    list(tr('Routinen', 'Routines'), routines.map((r, i) => `<li><a href="#${routineIds[i]}">${esc(r.name)}</a> <span class="c">${r.type === 'FUNCTION' ? esc(tr('Funktion', 'Function')) : esc(tr('Prozedur', 'Procedure'))}</span></li>`));
    list(tr('Ereignisse', 'Events'), events.map((e, i) => `<li><a href="#${eventIds[i]}">${esc(e.name)}</a></li>`));
    h.push('</nav>');
  }

  // tables
  if (input.tables.length) h.push(`<h2>${esc(tr('Tabellen', 'Tables'))}</h2>`);
  for (const t of input.tables) {
    const d = t.design;
    const st = t.status;
    h.push(`<article class="obj" id="${tableIds.get(lc(d.name))}"><div class="obj-head"><span class="kind">${esc(tr('Tabelle', 'Table'))}</span><h3>${esc(d.name)}</h3></div>`);
    if (d.comment) h.push(`<p class="comment">${esc(d.comment)}</p>`);
    const facts: string[] = [];
    const engine = st?.engine ?? d.options.engine;
    if (engine) facts.push(`Engine ${esc(engine)}`);
    if (st?.rows !== null && st?.rows !== undefined) facts.push(esc(tr('ca. {n} Datensätze', 'approx. {n} records', { n: formatNumber(st.rows) })));
    if (st?.dataLength) facts.push(esc(tr('{s} Daten', '{s} data', { s: formatBytes(st.dataLength) })));
    if (st?.indexLength) facts.push(esc(tr('{s} Indizes', '{s} indexes', { s: formatBytes(st.indexLength) })));
    const cs = [d.options.charset, d.options.collation || st?.collation || ''].filter(Boolean).join(' / ');
    if (cs) facts.push(esc(cs));
    if (d.options.rowFormat) facts.push(`ROW_FORMAT ${esc(d.options.rowFormat)}`);
    if (d.partition.trim()) facts.push(esc(tr('partitioniert', 'partitioned')));
    if (facts.length) h.push(`<div class="facts">${facts.join(' · ')}</div>`);

    h.push(
      `<table class="grid"><thead><tr><th>#</th><th>${esc(tr('Feld', 'Field'))}</th><th>${esc(tr('Datentyp', 'Data type'))}</th><th>${esc(tr('Null', 'Null'))}</th>` +
        `<th>${esc(tr('Standardwert', 'Default'))}</th><th>${esc(tr('Schlüssel', 'Keys'))}</th><th>${esc(tr('Extra', 'Extra'))}</th><th>${esc(tr('Kommentar', 'Comment'))}</th></tr></thead><tbody>`
    );
    d.fields.forEach((f, i) => {
      const def = f.generated && f.generatedExpr.trim() ? null : defaultSql(f, { serverType: o.serverType });
      h.push(
        `<tr><td class="n">${i + 1}</td><td class="name">${esc(f.name)}</td><td><code>${esc(fieldTypeSql(f))}</code></td>` +
          `<td>${f.notNull ? esc(tr('Nein', 'No')) : esc(tr('Ja', 'Yes'))}</td><td>${def === null ? '' : `<code>${esc(def)}</code>`}</td>` +
          `<td>${keyBadges(d, f)}</td><td>${esc(extraText(f))}</td><td>${esc(f.comment)}</td></tr>`
      );
    });
    h.push('</tbody></table>');

    if (o.indexes && (d.primaryKey.length || d.indexes.length)) {
      h.push(`<h4>${esc(tr('Indizes', 'Indexes'))}</h4><table class="grid"><thead><tr><th>${esc(tr('Name', 'Name'))}</th><th>${esc(tr('Typ', 'Type'))}</th><th>${esc(tr('Felder', 'Fields'))}</th><th>${esc(tr('Kommentar', 'Comment'))}</th></tr></thead><tbody>`);
      if (d.primaryKey.length) h.push(`<tr><td class="name">PRIMARY</td><td>PRIMARY KEY</td><td>${d.primaryKey.map(esc).join(', ')}</td><td></td></tr>`);
      for (const ix of d.indexes) {
        const cols = ix.fields.map((p) => (p.expr && !p.name ? `(${p.expr})` : `${p.name}${p.subPart ? `(${p.subPart})` : ''}${p.order === 'DESC' ? ' DESC' : ''}`));
        h.push(
          `<tr><td class="name">${esc(ix.name)}</td><td>${esc(ix.type === 'NORMAL' ? 'INDEX' : ix.type)}${ix.method ? ` ${esc(ix.method)}` : ''}${ix.invisible ? ' · INVISIBLE' : ''}</td>` +
            `<td>${esc(cols.join(', '))}</td><td>${esc(ix.comment)}</td></tr>`
        );
      }
      h.push('</tbody></table>');
    }
    if (o.foreignKeys && d.foreignKeys.length) {
      h.push(`<h4>${esc(tr('Fremdschlüssel', 'Foreign keys'))}</h4><table class="grid"><thead><tr><th>${esc(tr('Name', 'Name'))}</th><th>${esc(tr('Felder', 'Fields'))}</th><th>${esc(tr('Referenziert', 'References'))}</th><th>ON DELETE</th><th>ON UPDATE</th></tr></thead><tbody>`);
      for (const fk of d.foreignKeys) {
        const external = fk.refSchema && lc(fk.refSchema) !== lc(d.schema);
        const target = external ? esc(`${fk.refSchema}.${fk.refTable}`) : tableLink(fk.refTable);
        h.push(
          `<tr><td class="name">${esc(fk.name)}</td><td>${esc(fk.fields.join(', '))}</td><td>${target} (${esc(fk.refFields.join(', '))})</td>` +
            `<td>${esc(actionText(fk.onDelete))}</td><td>${esc(actionText(fk.onUpdate))}</td></tr>`
        );
      }
      h.push('</tbody></table>');
    }
    const inc = incoming.get(lc(d.name)) ?? [];
    if (o.referencedBy && inc.length) {
      h.push(`<h4>${esc(tr('Referenziert von', 'Referenced by'))}</h4><table class="grid"><thead><tr><th>${esc(tr('Tabelle', 'Table'))}</th><th>${esc(tr('Fremdschlüssel', 'Foreign key'))}</th><th>${esc(tr('Felder', 'Fields'))}</th></tr></thead><tbody>`);
      for (const r of inc) h.push(`<tr><td class="name">${tableLink(r.table)}</td><td>${esc(r.fk.name)}</td><td>${esc(r.fk.fields.join(', '))} → ${esc(r.fk.refFields.join(', '))}</td></tr>`);
      h.push('</tbody></table>');
    }
    if (o.checks && d.checks.length) {
      h.push(`<h4>${esc(tr('Prüfbedingungen', 'Check constraints'))}</h4><table class="grid"><thead><tr><th>${esc(tr('Name', 'Name'))}</th><th>${esc(tr('Ausdruck', 'Expression'))}</th><th>${esc(tr('Erzwungen', 'Enforced'))}</th></tr></thead><tbody>`);
      for (const c of d.checks) h.push(`<tr><td class="name">${esc(c.name)}</td><td><code>${esc(c.expr)}</code></td><td>${c.enforced ? esc(tr('Ja', 'Yes')) : esc(tr('Nein', 'No'))}</td></tr>`);
      h.push('</tbody></table>');
    }
    if (o.triggers && d.triggers.length) {
      h.push(`<h4>${esc(tr('Trigger', 'Triggers'))}</h4>`);
      for (const trg of d.triggers) h.push(`<div><b>${esc(trg.name)}</b> <span class="muted">${esc(`${trg.timing} ${trg.event}`)}</span><pre>${esc(trg.body.trim())}</pre></div>`);
    }
    if (o.ddl) {
      const sql = createTableSql({ ...d, schema: '' }, { serverType: o.serverType, triggers: false }).join(';\n\n');
      h.push(`<details><summary>DDL</summary><pre>${esc(sql)};</pre></details>`);
    }
    h.push('</article>');
  }

  if (views.length) h.push(`<h2>${esc(tr('Ansichten', 'Views'))}</h2>`);
  for (const v of views) {
    h.push(`<article class="obj" id="${viewIds.get(lc(v.name))}"><div class="obj-head"><span class="kind">${esc(tr('Ansicht', 'View'))}</span><h3>${esc(v.name)}</h3></div>`);
    if (v.comment) h.push(`<p class="comment">${esc(v.comment)}</p>`);
    const facts = [
      v.algorithm ? `ALGORITHM ${v.algorithm}` : '',
      v.security ? `SQL SECURITY ${v.security}` : '',
      v.checkOption ? `WITH ${v.checkOption} CHECK OPTION` : '',
      v.definer ? `DEFINER ${v.definer}` : ''
    ].filter(Boolean);
    if (facts.length) h.push(`<div class="facts">${facts.map(esc).join(' · ')}</div>`);
    h.push(`<pre>${esc(v.definition.trim())}</pre></article>`);
  }

  if (routines.length) h.push(`<h2>${esc(tr('Routinen', 'Routines'))}</h2>`);
  routines.forEach((r, i) => {
    const kind = r.type === 'FUNCTION' ? tr('Funktion', 'Function') : tr('Prozedur', 'Procedure');
    const sig = `${r.name}(${r.params.map((p) => `${r.type === 'PROCEDURE' && p.mode ? `${p.mode} ` : ''}${p.name} ${p.type}`).join(', ')})${r.returns ? ` RETURNS ${r.returns}` : ''}`;
    h.push(`<article class="obj" id="${routineIds[i]}"><div class="obj-head"><span class="kind">${esc(kind)}</span><h3>${esc(r.name)}</h3></div>`);
    if (r.comment) h.push(`<p class="comment">${esc(r.comment)}</p>`);
    const facts = [r.deterministic ? 'DETERMINISTIC' : 'NOT DETERMINISTIC', r.dataAccess, r.security ? `SQL SECURITY ${r.security}` : '', r.definer ? `DEFINER ${r.definer}` : ''].filter(Boolean);
    h.push(`<div class="facts"><code>${esc(sig)}</code><br>${facts.map(esc).join(' · ')}</div>`);
    if (r.body.trim()) h.push(`<pre>${esc(r.body.trim())}</pre>`);
    h.push('</article>');
  });

  if (events.length) h.push(`<h2>${esc(tr('Ereignisse', 'Events'))}</h2>`);
  events.forEach((e, i) => {
    h.push(`<article class="obj" id="${eventIds[i]}"><div class="obj-head"><span class="kind">${esc(tr('Ereignis', 'Event'))}</span><h3>${esc(e.name)}</h3></div>`);
    if (e.comment) h.push(`<p class="comment">${esc(e.comment)}</p>`);
    h.push(`<div class="facts">${esc(e.schedule)} · ${esc(e.status)}${e.definer ? ` · DEFINER ${esc(e.definer)}` : ''}</div>`);
    if (e.body.trim()) h.push(`<pre>${esc(e.body.trim())}</pre>`);
    h.push('</article>');
  });

  h.push(`<footer>${esc(tr('Erstellt mit KS Table am {d}', 'Generated with KS Table on {d}', { d: input.generatedAt }))}</footer>`);
  h.push('</div></body></html>');
  return h.join('\n');
}
