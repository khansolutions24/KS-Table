// Labels of the automation feature (backend logs / e-mails and UI).

import type { JobStep, JobStepKind, RunStatus, RunTrigger, StepResult } from '../apis/automation';
import { tr } from '../i18n';

/** Profile kinds documented for automation (a kind is executable when its feature registered a runner) */
export const KNOWN_PROFILE_KINDS = ['import', 'export', 'dumpSql', 'execSqlFile', 'dataTransfer', 'dataSync', 'structSync', 'backup', 'dataGen'];

export function profileKindLabel(kind: string): string {
  switch (kind) {
    case 'import':
      return tr('Import', 'Import');
    case 'export':
      return tr('Export', 'Export');
    case 'dumpSql':
      return tr('SQL-Datei ausgeben', 'Dump SQL file');
    case 'execSqlFile':
      return tr('SQL-Datei ausführen', 'Execute SQL file');
    case 'dataTransfer':
      return tr('Datenübertragung', 'Data transfer');
    case 'dataSync':
      return tr('Datensynchronisation', 'Data synchronization');
    case 'structSync':
      return tr('Struktursynchronisation', 'Structure synchronization');
    case 'backup':
      return tr('Sicherung', 'Backup');
    case 'dataGen':
      return tr('Datengenerator', 'Data generator');
    default:
      return kind;
  }
}

export function stepKindLabel(kind: JobStepKind): string {
  if (kind === 'sql') return tr('SQL ausführen', 'Execute SQL');
  if (kind === 'backup') return tr('Sicherung', 'Backup');
  return tr('Gespeichertes Profil ausführen', 'Run saved profile');
}

export function runStatusLabel(s: RunStatus): string {
  switch (s) {
    case 'running':
      return tr('Läuft', 'Running');
    case 'success':
      return tr('Erfolgreich', 'Successful');
    case 'warning':
      return tr('Mit Fehlern beendet', 'Finished with errors');
    case 'error':
      return tr('Fehlgeschlagen', 'Failed');
    default:
      return tr('Abgebrochen', 'Cancelled');
  }
}

export function stepStatusLabel(s: StepResult['status']): string {
  switch (s) {
    case 'success':
      return tr('Erfolgreich', 'Successful');
    case 'error':
      return tr('Fehler', 'Error');
    case 'skipped':
      return tr('Übersprungen', 'Skipped');
    default:
      return tr('Abgebrochen', 'Cancelled');
  }
}

export function triggerLabel(t: RunTrigger): string {
  if (t === 'manual') return tr('manuell gestartet', 'started manually');
  if (t === 'schedule') return tr('Zeitplan von KS Table', 'KS Table schedule');
  return tr('Windows-Aufgabenplanung', 'Windows Task Scheduler');
}

/** Name of a step without an explicit name */
export function defaultStepName(step: JobStep, connectionName: (id: string) => string = (id) => id): string {
  const conn = (id: string) => (id ? connectionName(id) : '?');
  switch (step.kind) {
    case 'sql':
      return step.source === 'file' && step.file
        ? tr('SQL-Datei {f}', 'SQL file {f}', { f: step.file.split(/[\\/]/).pop() ?? step.file })
        : tr('SQL auf {c}{d}', 'SQL on {c}{d}', { c: conn(step.connectionId), d: step.database ? ` / ${step.database}` : '' });
    case 'backup':
      return tr('Sicherung {c} / {d}', 'Backup {c} / {d}', { c: conn(step.connectionId), d: step.database || '?' });
    default:
      return `${profileKindLabel(step.profileKind)}: ${step.profileName || '?'}`;
  }
}
