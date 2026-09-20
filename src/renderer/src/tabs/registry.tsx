// Tab kind → component. Feature tabs are discovered with import.meta.glob and loaded lazily,
// so a feature only has to create its file (default export) to become available.

import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { tr } from '@shared/i18n';
import { EmptyState, Spinner } from '../components/ui/controls';
import type { TabProps } from '../store/tabs';

const modules = import.meta.glob<{ default: ComponentType<TabProps> }>('../features/**/*Tab.tsx');

/** Tab kind → module path (relative to this file). Params per kind: see docs/ARCHITECTURE.md */
export const TAB_MODULES: Record<string, string> = {
  objects: '../features/objects/ObjectsTab.tsx',
  tableData: '../features/tableData/TableDataTab.tsx',
  tableDesign: '../features/tableDesign/TableDesignTab.tsx',
  viewDesign: '../features/viewDesign/ViewDesignTab.tsx',
  routineDesign: '../features/routineDesign/RoutineDesignTab.tsx',
  eventDesign: '../features/eventDesign/EventDesignTab.tsx',
  query: '../features/query/QueryTab.tsx',
  userDesign: '../features/users/UserDesignTab.tsx',
  privileges: '../features/users/PrivilegesTab.tsx',
  console: '../features/console/ConsoleTab.tsx',
  serverMonitor: '../features/monitor/ServerMonitorTab.tsx',
  findInDb: '../features/find/FindTab.tsx',
  history: '../features/history/HistoryTab.tsx',
  snippets: '../features/snippets/SnippetsTab.tsx',
  import: '../features/io/ImportTab.tsx',
  export: '../features/io/ExportTab.tsx',
  dumpSql: '../features/io/DumpSqlTab.tsx',
  execSqlFile: '../features/io/ExecSqlFileTab.tsx',
  dataTransfer: '../features/sync/DataTransferTab.tsx',
  dataSync: '../features/sync/DataSyncTab.tsx',
  structSync: '../features/sync/StructSyncTab.tsx',
  model: '../features/model/ModelTab.tsx',
  charts: '../features/charts/ChartsTab.tsx',
  backup: '../features/backup/BackupTab.tsx',
  automation: '../features/automation/AutomationTab.tsx',
  dataGen: '../features/datagen/DataGenTab.tsx',
  options: '../features/options/OptionsTab.tsx',
  profiling: '../features/profiling/ProfilingTab.tsx'
};

const cache = new Map<string, LazyExoticComponent<ComponentType<TabProps>>>();

function componentFor(kind: string): LazyExoticComponent<ComponentType<TabProps>> | null {
  const path = TAB_MODULES[kind];
  const loader = path ? modules[path] : undefined;
  if (!path || !loader) return null;
  let c = cache.get(path);
  if (!c) {
    c = lazy(loader);
    cache.set(path, c);
  }
  return c;
}

export function TabContent(props: TabProps) {
  const C = componentFor(props.tab.kind);
  if (!C) {
    return (
      <EmptyState title={tr('Noch nicht verfügbar', 'Not available yet')}>
        {tr('Dieses Modul wird gerade entwickelt.', 'This module is under development.')} <span className="faint">({props.tab.kind})</span>
      </EmptyState>
    );
  }
  return (
    <Suspense
      fallback={
        <div className="ks-tab-loading">
          <Spinner size={22} />
        </div>
      }
    >
      <C {...props} />
    </Suspense>
  );
}
