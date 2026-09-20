import { useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Activity,
  ArrowLeftRight,
  Clock,
  Code,
  Dices,
  FileInput,
  FileOutput,
  FileText,
  GitCompare,
  GitCompareArrows,
  LayoutGrid,
  Search,
  Settings,
  SquareTerminal,
  X
} from 'lucide-react';
import { tr } from '@shared/i18n';
import { ObjIcon, type ObjKind } from '../components/icons';
import { showContextMenu, SEP } from '../components/ui/Menu';
import { TabContent } from '../tabs/registry';
import { OBJECTS_TAB, useTabs, type TabInfo } from '../store/tabs';
import { useWorkspace } from '../store/workspace';

const OBJ_KINDS = new Set<string>([
  'connection',
  'database',
  'table',
  'view',
  'function',
  'procedure',
  'event',
  'trigger',
  'query',
  'backup',
  'user',
  'role',
  'model',
  'chart',
  'automation'
]);

export function TabIconView({ icon, size = 15 }: { icon: string; size?: number }) {
  if (OBJ_KINDS.has(icon)) return <ObjIcon kind={icon as ObjKind} size={size} />;
  const p = { size, className: 'ks-tab-glyph' };
  switch (icon) {
    case 'objects':
      return <LayoutGrid {...p} />;
    case 'console':
      return <SquareTerminal {...p} />;
    case 'monitor':
      return <Activity {...p} />;
    case 'history':
      return <Clock {...p} />;
    case 'transfer':
      return <ArrowLeftRight {...p} />;
    case 'sync':
      return <GitCompareArrows {...p} />;
    case 'structsync':
      return <GitCompare {...p} />;
    case 'import':
      return <FileInput {...p} />;
    case 'export':
      return <FileOutput {...p} />;
    case 'datagen':
      return <Dices {...p} />;
    case 'search':
      return <Search {...p} />;
    case 'snippets':
      return <Code {...p} />;
    case 'settings':
      return <Settings {...p} />;
    default:
      return <FileText {...p} />;
  }
}

function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const profiles = useWorkspace((s) => s.profiles);
  const scroller = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const menu = (e: React.MouseEvent, t: TabInfo) => {
    const s = useTabs.getState();
    const idx = s.tabs.findIndex((x) => x.id === t.id);
    showContextMenu(e, [
      { label: tr('Schließen', 'Close'), shortcut: 'Ctrl+W', disabled: t.id === OBJECTS_TAB, onClick: () => void s.close(t.id) },
      {
        label: tr('Andere schließen', 'Close Others'),
        onClick: () => void s.closeMany(s.tabs.filter((x) => x.id !== t.id && x.id !== OBJECTS_TAB).map((x) => x.id))
      },
      {
        label: tr('Rechts davon schließen', 'Close Tabs to the Right'),
        onClick: () => void s.closeMany(s.tabs.slice(idx + 1).map((x) => x.id))
      },
      SEP,
      { label: tr('Alle schließen', 'Close All'), onClick: () => void s.closeMany(s.tabs.filter((x) => x.id !== OBJECTS_TAB).map((x) => x.id)) }
    ]);
  };

  return (
    <div
      className="ks-tabbar"
      ref={scroller}
      onWheel={(e) => {
        if (scroller.current) scroller.current.scrollLeft += e.deltaY;
      }}
    >
      {tabs.map((t, i) => {
        const color = t.connectionId ? profiles.find((p) => p.id === t.connectionId)?.color : null;
        return (
          <div
            key={t.id}
            className={clsx('ks-doctab', t.id === activeId && 'active', dragId === t.id && 'dragging')}
            title={t.subtitle ? `${t.title}\n${t.subtitle}` : t.title}
            draggable={t.id !== OBJECTS_TAB}
            onDragStart={(e) => {
              setDragId(t.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => {
              if (dragId && dragId !== t.id) {
                e.preventDefault();
                useTabs.getState().move(dragId, i);
              }
            }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void useTabs.getState().close(t.id);
              } else if (e.button === 0) useTabs.getState().activate(t.id);
            }}
            onContextMenu={(e) => menu(e, t)}
          >
            {color && <span className="ks-doctab-color" style={{ background: color }} />}
            <TabIconView icon={t.icon} />
            <span className="ks-doctab-title">{t.title}</span>
            {t.dirty && <span className="ks-doctab-dirty">●</span>}
            {t.id !== OBJECTS_TAB && (
              <button
                type="button"
                className="ks-doctab-close"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => void useTabs.getState().close(t.id)}
                title={tr('Schließen', 'Close')}
              >
                <X size={13} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function TabArea() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  return (
    <div className="ks-tabarea">
      <TabBar />
      <div className="ks-tabcontent">
        {tabs.map((t) => (
          <div key={t.id} className="ks-tabpane" style={{ display: t.id === activeId ? 'flex' : 'none' }}>
            <TabContent tab={t} active={t.id === activeId} />
          </div>
        ))}
      </div>
    </div>
  );
}
