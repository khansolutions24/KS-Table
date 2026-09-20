// Object type icons (lucide glyphs in object type colors).

import clsx from 'clsx';
import logoUrl from '../assets/logo.png';
import {
  Archive,
  Braces,
  CalendarClock,
  ChartColumn,
  Columns3,
  Database,
  FileCode,
  Folder,
  Glasses,
  KeyRound,
  Link2,
  ListTree,
  Network,
  Server,
  SquareFunction,
  Table2,
  Timer,
  User,
  Users,
  Zap,
  type LucideIcon
} from 'lucide-react';

export type ObjKind =
  | 'connection'
  | 'connection-mariadb'
  | 'group'
  | 'database'
  | 'table'
  | 'view'
  | 'function'
  | 'procedure'
  | 'event'
  | 'trigger'
  | 'query'
  | 'backup'
  | 'user'
  | 'role'
  | 'model'
  | 'chart'
  | 'automation'
  | 'index'
  | 'key'
  | 'foreignKey'
  | 'column';

const MAP: Record<ObjKind, [LucideIcon, string]> = {
  connection: [Server, 'var(--c-mysql)'],
  'connection-mariadb': [Server, 'var(--c-mariadb)'],
  group: [Folder, 'var(--c-backup)'],
  database: [Database, 'var(--c-database, #b7791f)'],
  table: [Table2, 'var(--c-table)'],
  view: [Glasses, 'var(--c-view)'],
  function: [SquareFunction, 'var(--c-function)'],
  procedure: [Braces, 'var(--c-procedure)'],
  event: [CalendarClock, 'var(--c-event)'],
  trigger: [Zap, 'var(--c-trigger)'],
  query: [FileCode, 'var(--c-query)'],
  backup: [Archive, 'var(--c-backup)'],
  user: [User, 'var(--c-user)'],
  role: [Users, 'var(--c-user)'],
  model: [Network, 'var(--c-model)'],
  chart: [ChartColumn, 'var(--c-chart)'],
  automation: [Timer, 'var(--c-event)'],
  index: [ListTree, 'var(--c-index)'],
  key: [KeyRound, 'var(--c-key)'],
  foreignKey: [Link2, 'var(--c-view)'],
  column: [Columns3, 'var(--c-index)']
};

export function ObjIcon({
  kind,
  size = 16,
  dim,
  className,
  strokeWidth = 1.8
}: {
  kind: ObjKind;
  size?: number;
  dim?: boolean;
  className?: string;
  strokeWidth?: number;
}) {
  const [Icon, color] = MAP[kind] ?? MAP.table;
  return (
    <Icon
      size={size}
      strokeWidth={strokeWidth}
      className={clsx('ks-obj-icon', className)}
      style={{ color: dim ? 'var(--fg-faint)' : color, flex: 'none' }}
    />
  );
}

/** Brand mark of KS Table. */
export function AppLogo({ size = 20 }: { size?: number }) {
  return <img src={logoUrl} width={size} height={size} alt="" aria-hidden="true" style={{ display: 'block' }} />;
}
