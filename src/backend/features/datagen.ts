// Test data generator (namespace api.datagen) and the "dataGen" profile runner for automation.

import type { DataGenApi, DataGenPlan } from '@shared/apis/datagen';
import { defaultDataGenOptions } from '@shared/datagen/auto';
import { tr } from '@shared/i18n';
import { deepMerge } from '@shared/util';
import type { BackendContext } from '../api';
import { KsError } from '../errors';
import { registerProfileRunner } from '../profileRunners';
import type { TaskContext } from '../tasks';
import { analyzeDatabase } from './datagen/analyze';
import { previewPlan, runGeneration } from './datagen/engine';

function normalizePlan(p: unknown): DataGenPlan {
  const x = (p ?? {}) as Partial<DataGenPlan>;
  if (!x.connectionId || !x.database) {
    throw new KsError(tr('Der Generierungsplan ist unvollständig (Verbindung oder Datenbank fehlt).', 'The generation plan is incomplete (connection or database missing).'));
  }
  return {
    connectionId: String(x.connectionId),
    database: String(x.database),
    tables: Array.isArray(x.tables) ? x.tables.map((t) => ({ ...t, rows: Math.max(0, Math.floor(Number(t.rows) || 0)), columns: Array.isArray(t.columns) ? t.columns : [] })) : [],
    options: deepMerge(defaultDataGenOptions(), x.options ?? {})
  };
}

async function generate(ctx: BackendContext, raw: unknown, t: TaskContext) {
  const plan = normalizePlan(raw);
  const s = await ctx.sessions.open(plan.connectionId, plan.database);
  const onAbort = () => void ctx.sessions.killQuery(s).catch(() => undefined);
  t.signal.addEventListener('abort', onAbort);
  try {
    t.progress(null, tr('Analysiere Tabellen …', 'Analyzing tables …'));
    const analysis = await analyzeDatabase(s, plan.database);
    return await runGeneration(s, plan, analysis, t);
  } finally {
    t.signal.removeEventListener('abort', onAbort);
    await ctx.sessions.close(s.id);
  }
}

registerProfileRunner('dataGen', (ctx, profile, task) => generate(ctx, profile, task));

export function createDataGenApi(ctx: BackendContext): DataGenApi {
  return {
    async analyze(connectionId, database) {
      const s = await ctx.sessions.open(connectionId, database);
      try {
        return await analyzeDatabase(s, database);
      } finally {
        await ctx.sessions.close(s.id);
      }
    },
    async preview(raw, rows = 20) {
      const plan = normalizePlan(raw);
      const s = await ctx.sessions.open(plan.connectionId, plan.database);
      try {
        const analysis = await analyzeDatabase(s, plan.database);
        return await previewPlan(s, plan, analysis, Math.max(1, Math.min(200, rows)));
      } finally {
        await ctx.sessions.close(s.id);
      }
    },
    start: async (raw) => {
      const plan = normalizePlan(raw);
      return ctx.tasks.start('dataGen', tr('Datengenerator – {db}', 'Data generator – {db}', { db: plan.database }), (t) => generate(ctx, plan, t));
    }
  };
}
