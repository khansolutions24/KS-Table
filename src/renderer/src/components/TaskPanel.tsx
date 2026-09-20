// Progress + log view for long running backend tasks (import, export, transfer, sync, backup …).

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Square } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { TaskInfo, TaskLogEntry } from '@shared/types';
import { formatDuration } from '@shared/util';
import { api, onEvent } from '../api/client';
import { Button, ProgressBar } from './ui/controls';

/** Subscribes to a task's updates and log lines. */
export function useTask(taskId: string | null): { info: TaskInfo | null; log: TaskLogEntry[] } {
  const [info, setInfo] = useState<TaskInfo | null>(null);
  const [log, setLog] = useState<TaskLogEntry[]>([]);
  useEffect(() => {
    setInfo(null);
    setLog([]);
    if (!taskId) return;
    let cancelled = false;
    void api.tasks.list().then((all) => {
      if (cancelled) return;
      const t = all.find((x) => x.taskId === taskId);
      if (t) setInfo(t);
    });
    void api.tasks.log(taskId).then((l) => !cancelled && setLog(l));
    const off1 = onEvent('task:update', (t) => {
      if (t.taskId === taskId) setInfo(t);
    });
    const off2 = onEvent('task:log', (e) => {
      if (e.taskId === taskId) setLog((l) => (l.length > 20000 ? [...l.slice(-15000), e] : [...l, e]));
    });
    return () => {
      cancelled = true;
      off1();
      off2();
    };
  }, [taskId]);
  return { info, log };
}

export function TaskPanel({ taskId, className }: { taskId: string | null; className?: string }) {
  const { info, log } = useTask(taskId);
  const logRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (info?.status !== 'running') return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [info?.status]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  if (!taskId) return null;
  const running = info?.status === 'running';
  const elapsed = info ? (info.endedAt ?? now) - info.startedAt : 0;
  const statusText = !info
    ? tr('Startet …', 'Starting …')
    : info.status === 'running'
      ? info.message || tr('Läuft …', 'Running …')
      : info.status === 'done'
        ? tr('Abgeschlossen', 'Finished')
        : info.status === 'cancelled'
          ? tr('Abgebrochen', 'Cancelled')
          : tr('Fehler: {m}', 'Error: {m}', { m: info.message });

  return (
    <div className={clsx('ks-task', className)}>
      <div className="ks-task-head">
        <div className={clsx('ks-task-status', info?.status)}>{statusText}</div>
        <div className="spacer" />
        <span className="muted">{formatDuration(elapsed)}</span>
        {running && (
          <Button size="sm" variant="danger" icon={<Square size={12} />} onClick={() => void api.tasks.cancel(taskId)}>
            {tr('Abbrechen', 'Stop')}
          </Button>
        )}
      </div>
      <ProgressBar value={running ? (info?.progress ?? null) : 1} />
      <div className="ks-task-log selectable" ref={logRef}>
        {log.map((e, i) => (
          <div key={i} className={clsx('ks-task-line', e.level)}>
            <span className="ks-task-time">{new Date(e.time).toLocaleTimeString()}</span>
            <span>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
