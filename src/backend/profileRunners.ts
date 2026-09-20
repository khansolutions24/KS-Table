// Registry of headless runners for saved profiles (used by automation / batch jobs).
// Feature modules register a runner for their profile kind at import time:
//   registerProfileRunner('export', (ctx, profile, task) => runExport(ctx, profile as ExportProfile, task));
// The runner receives exactly the object that the feature stores with api.profiles.save(kind, name, data).

import type { BackendContext } from './api';
import type { TaskContext } from './tasks';

export type ProfileRunner = (ctx: BackendContext, profile: unknown, task: TaskContext) => Promise<unknown>;

const runners = new Map<string, ProfileRunner>();

export function registerProfileRunner(kind: string, runner: ProfileRunner): void {
  runners.set(kind, runner);
}

export function getProfileRunner(kind: string): ProfileRunner | undefined {
  return runners.get(kind);
}

export function profileRunnerKinds(): string[] {
  return [...runners.keys()].sort();
}
