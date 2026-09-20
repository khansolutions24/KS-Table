// Converting a backup archive into one SQL script (runs with "Execute SQL file" or the mysql client).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import type { BackupObjectType, ExtractOptions, ExtractResult, ManifestObject } from '@shared/apis/backup';
import { tr } from '@shared/i18n';
import { quoteId, quoteString } from '@shared/sql/quote';
import { backupTypeLabel, objectKey } from '@shared/backup/options';
import { formatBytes, formatDateTime, formatNumber } from '@shared/util';
import { KsError } from '../../errors';
import type { TaskContext } from '../../tasks';
import { DROP_KW, openArchive, stripDefiner } from './common';

const BASE_SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';
const NAME_RE = /^[A-Za-z0-9_]+$/;
/** Objects with BEGIN … END bodies are written with a temporary delimiter */
const COMPOUND: BackupObjectType[] = ['function', 'procedure', 'trigger', 'event'];

export async function runExtract(file: string, target: string, o: ExtractOptions, t: TaskContext): Promise<ExtractResult> {
  if (!target.trim()) throw new KsError(tr('Bitte eine Zieldatei angeben.', 'Please choose a target file.'));
  if (!o.structure && !o.data) throw new KsError(tr('Weder Struktur noch Daten ausgewählt.', 'Neither structure nor data selected.'));
  if (path.resolve(target).toLowerCase() === path.resolve(file).toLowerCase()) {
    throw new KsError(tr('Die Zieldatei darf nicht die Sicherung selbst sein.', 'The target file must not be the backup itself.'));
  }
  const arc = await openArchive(file);
  const tmp = `${target}.${process.pid}.tmp`;
  let out: fs.WriteStream | null = null;
  try {
    const m = arc.manifest;
    const wanted = o.objects ? new Set(o.objects.map((x) => objectKey(x))) : null;
    const objs = m.objects.filter((x) => !wanted || wanted.has(objectKey(x)));
    if (!objs.length) throw new KsError(tr('Es wurden keine Objekte ausgewählt.', 'No objects were selected.'));
    t.log('info', tr('Schreibe {n} Objekte nach „{f}“ …', 'Writing {n} objects to "{f}" …', { n: objs.length, f: target }));
    await fsp.mkdir(path.dirname(path.resolve(target)), { recursive: true });
    const stream = fs.createWriteStream(tmp, { encoding: 'utf8' });
    out = stream;
    const failed = new Promise<never>((_, reject) => stream.on('error', reject));
    failed.catch(() => undefined);
    const write = async (text: string): Promise<void> => {
      if (!stream.write(text)) await Promise.race([once(stream, 'drain'), failed]);
    };
    let statements = 0;
    const stmt = async (sql: string): Promise<void> => {
      await write(`${sql};\n`);
      statements++;
    };
    const section = (title: string) => write(`\n-- ----------------------------------------------------------\n-- ${title}\n-- ----------------------------------------------------------\n`);
    const label = (x: ManifestObject) => tr('{t} {n}', '{t} {n}', { t: backupTypeLabel(x.type), n: quoteId(x.name) });

    const created = formatDateTime(new Date(m.created));
    await write(
      [
        `-- KS Table – ${tr('SQL-Skript aus einer Sicherung', 'SQL script from a backup')}`,
        `-- ${tr('Sicherung', 'Backup')}: ${path.basename(file)}`,
        `-- ${tr('Datenbank', 'Database')}: ${m.database}   Server: ${m.server.type === 'mariadb' ? 'MariaDB' : 'MySQL'} ${m.server.version}`,
        `-- ${tr('Erstellt', 'Created')}: ${created}`,
        ...(m.comment ? m.comment.split(/\r?\n/).map((l) => `-- ${tr('Kommentar', 'Comment')}: ${l}`) : []),
        `-- ${tr('Extrahiert', 'Extracted')}: ${formatDateTime(new Date())}`,
        '',
        ''
      ].join('\n')
    );
    await stmt('SET NAMES utf8mb4');
    await stmt('SET @KS_OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS');
    await stmt('SET FOREIGN_KEY_CHECKS = 0');
    await stmt('SET @KS_OLD_SQL_MODE = @@SQL_MODE');
    await stmt(`SET SQL_MODE = '${BASE_SQL_MODE}'`);
    await stmt('SET @KS_OLD_TIME_ZONE = @@TIME_ZONE');
    await stmt("SET TIME_ZONE = '+00:00'");
    await stmt('SET @KS_OLD_COLLATION_CONNECTION = @@COLLATION_CONNECTION');

    if (o.createDatabase) {
      const db = o.databaseName.trim() || m.database;
      const cs = NAME_RE.test(m.charset) ? ` DEFAULT CHARACTER SET ${m.charset}` : '';
      const co = cs && NAME_RE.test(m.collation) ? ` COLLATE ${m.collation}` : '';
      await write('\n');
      await stmt(`CREATE DATABASE IF NOT EXISTS ${quoteId(db)}${cs}${co}`);
      await stmt(`USE ${quoteId(db)}`);
    }

    const ddlOf = async (x: ManifestObject): Promise<string | null> => {
      if (!x.ddlFile) return null;
      const ddl = await arc.text(x.ddlFile);
      return o.keepDefiner ? ddl : stripDefiner(ddl);
    };
    const dropOf = (x: ManifestObject) => `DROP ${DROP_KW[x.type]} IF EXISTS ${quoteId(x.name)}`;
    const total = objs.length;
    let done = 0;
    const tick = (name: string) => t.progress(Math.min(0.999, ++done / total), name);

    // tables (structure + data)
    for (const x of objs.filter((y) => y.type === 'table')) {
      t.throwIfCancelled();
      const ddl = o.structure ? await ddlOf(x) : null;
      if (ddl) {
        await section(label(x));
        if (o.dropStatements) await stmt(dropOf(x));
        await stmt(ddl);
      }
      if (o.data && x.dataFiles.length) {
        await write(`\n-- ${tr('Daten für {n} ({r} Datensätze)', 'Data for {n} ({r} records)', { n: quoteId(x.name), r: formatNumber(x.rows ?? 0) })}\n`);
        for (const f of x.dataFiles) {
          for await (const line of arc.lines(f)) {
            if (!line.trim()) continue;
            await write(`${line}\n`);
            statements++;
          }
          t.throwIfCancelled();
        }
      }
      tick(x.name);
    }

    // routines, views, triggers, events
    if (o.structure) {
      for (const type of ['function', 'procedure', 'view', 'trigger', 'event'] as BackupObjectType[]) {
        for (const x of objs.filter((y) => y.type === type)) {
          t.throwIfCancelled();
          const ddl = await ddlOf(x);
          tick(x.name);
          if (!ddl) continue;
          await section(label(x));
          if (o.dropStatements) await stmt(dropOf(x));
          if (x.sqlMode !== undefined) await stmt(`SET SESSION SQL_MODE = ${quoteString(x.sqlMode)}`);
          if (x.collationConnection) await stmt(`SET SESSION COLLATION_CONNECTION = ${quoteString(x.collationConnection)}`);
          if (type === 'event' && x.timeZone) await stmt(`SET TIME_ZONE = ${quoteString(x.timeZone)}`);
          if (COMPOUND.includes(type)) {
            await write(`DELIMITER ;;\n${ddl};;\nDELIMITER ;\n`);
            statements++;
          } else {
            await stmt(ddl);
          }
          if (x.sqlMode !== undefined) await stmt(`SET SESSION SQL_MODE = '${BASE_SQL_MODE}'`);
          if (x.collationConnection) await stmt('SET SESSION COLLATION_CONNECTION = @KS_OLD_COLLATION_CONNECTION');
          if (type === 'event' && x.timeZone) await stmt("SET TIME_ZONE = '+00:00'");
        }
      }
    }

    await write('\n');
    await stmt('SET FOREIGN_KEY_CHECKS = @KS_OLD_FOREIGN_KEY_CHECKS');
    await stmt('SET SQL_MODE = @KS_OLD_SQL_MODE');
    await stmt('SET TIME_ZONE = @KS_OLD_TIME_ZONE');
    stream.end();
    await Promise.race([once(stream, 'close'), failed]);
    out = null;
    await fsp.rm(target, { force: true });
    await fsp.rename(tmp, target);
    const st = await fsp.stat(target);
    t.log(
      'success',
      tr('SQL-Skript geschrieben: {f} ({s}, {n} Anweisungen)', 'SQL script written: {f} ({s}, {n} statements)', {
        f: target,
        s: formatBytes(st.size),
        n: formatNumber(statements)
      })
    );
    return { file: target, statements, size: st.size };
  } catch (e) {
    out?.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  } finally {
    arc.close();
  }
}
