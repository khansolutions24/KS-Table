import { tr } from '@shared/i18n';
import { useCurrentContext } from '../store/nav';
import { useWorkspace } from '../store/workspace';

export function StatusBar() {
  const ctx = useCurrentContext();
  const conns = useWorkspace((s) => s.conns);
  const profiles = useWorkspace((s) => s.profiles);
  const openCount = Object.values(conns).filter((c) => c.status === 'open').length;
  const p = ctx.connectionId ? profiles.find((x) => x.id === ctx.connectionId) : undefined;
  const cs = ctx.connectionId ? conns[ctx.connectionId] : undefined;
  const db = ctx.database && cs ? cs.dbs[ctx.database] : undefined;

  let left = tr('Bereit', 'Ready');
  if (p) {
    left = p.name;
    if (cs?.status === 'open' && cs.server) left += `  ·  ${cs.server.type === 'mariadb' ? 'MariaDB' : 'MySQL'} ${cs.server.version.split('-')[0]}`;
    if (ctx.database) left += `  ·  ${ctx.database}`;
    if (db?.loaded) {
      left += `  ·  ${tr('{t} Tabellen, {v} Ansichten', '{t} tables, {v} views', { t: db.tables.length, v: db.views.length })}`;
    }
  }

  return (
    <div className="ks-statusbar">
      <span className="ellipsis">{left}</span>
      <span className="spacer" />
      <span>{tr('{n} offene Verbindung(en)', '{n} open connection(s)', { n: openCount })}</span>
    </div>
  );
}
