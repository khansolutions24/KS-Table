// Long running jobs (import, export, transfer, sync, backup, ...) with progress and log events.

import { randomUUID } from 'node:crypto';
import type { TaskInfo, TaskLogEntry } from '@shared/types';
import { tr } from '@shared/i18n';
import { emit } from './events';

export class CancelledError extends Error {
  constructor() {
    super(tr('Abgebrochen', 'Cancelled'));
    this.name = 'CancelledError';
  }
}

export interface TaskContext {
  readonly taskId: string;
  readonly signal: AbortSignal;
  log(level: TaskLogEntry['level'], message: string): void;
  /** value 0..1 or null for indeterminate */
  progress(value: number | null, message?: string): void;
  throwIfCancelled(): void;
}

interface TaskRecord {
  info: TaskInfo;
  log: TaskLogEntry[];
  controller: AbortController;
}

const MAX_LOG = 50_000;

export class TaskManager {
  private tasks = new Map<string, TaskRecord>();

  start(kind: string, title: string, fn: (ctx: TaskContext) => Promise<unknown>): string {
    const taskId = randomUUID();
    const controller = new AbortController();
    const rec: TaskRecord = {
      info: { taskId, kind, title, status: 'running', progress: 0, message: '', startedAt: Date.now() },
      log: [],
      controller
    };
    this.tasks.set(taskId, rec);
    let lastEmit = 0;
    const ctx: TaskContext = {
      taskId,
      signal: controller.signal,
      log: (level, message) => {
        const e: TaskLogEntry = { taskId, time: Date.now(), level, message };
        rec.log.push(e);
        if (rec.log.length > MAX_LOG) rec.log.splice(0, rec.log.length - MAX_LOG);
        emit('task:log', e);
      },
      progress: (value, message) => {
        rec.info = { ...rec.info, progress: value, message: message ?? rec.info.message };
        const now = Date.now();
        if (now - lastEmit > 100 || value === 1) {
          lastEmit = now;
          emit('task:update', { ...rec.info });
        }
      },
      throwIfCancelled: () => {
        if (controller.signal.aborted) throw new CancelledError();
      }
    };
    emit('task:update', { ...rec.info });
    void (async () => {
      try {
        const result = await fn(ctx);
        if (controller.signal.aborted) throw new CancelledError();
        rec.info = { ...rec.info, status: 'done', progress: 1, endedAt: Date.now(), result };
      } catch (e) {
        const cancelled = controller.signal.aborted || e instanceof CancelledError;
        const message = cancelled ? tr('Abgebrochen', 'Cancelled') : e instanceof Error ? e.message : String(e);
        rec.info = { ...rec.info, status: cancelled ? 'cancelled' : 'error', endedAt: Date.now(), message };
        ctx.log(cancelled ? 'warn' : 'error', message);
      }
      emit('task:update', { ...rec.info });
    })();
    return taskId;
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()].map((t) => ({ ...t.info }));
  }

  log(taskId: string): TaskLogEntry[] {
    return this.tasks.get(taskId)?.log.slice() ?? [];
  }

  cancel(taskId: string): void {
    this.tasks.get(taskId)?.controller.abort();
  }
}
