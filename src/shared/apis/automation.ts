// Automation (batch jobs, scheduling, e-mail notification) API (owned by the automation feature).
// Jobs are JSON files in <profilesDir>/automation/<id>.json, run history in <profilesDir>/automation/runs/<id>/.

import type { SmtpSettings, TaskLogEntry } from '../types';
import type { BackupOptions } from './backup';

export type JobStepKind = 'sql' | 'backup' | 'profile';

interface StepBase {
  id: string;
  /** Display name (empty = generated from the step settings) */
  name: string;
  enabled: boolean;
  /** Continue with the next step when this step fails */
  continueOnError: boolean;
}

export interface SqlStep extends StepBase {
  kind: 'sql';
  connectionId: string;
  database: string;
  source: 'text' | 'file';
  sql: string;
  /** SQL file (e.g. a saved query) for source "file" */
  file: string;
}

export interface BackupStep extends StepBase {
  kind: 'backup';
  connectionId: string;
  database: string;
  options: BackupOptions;
}

export interface ProfileStep extends StepBase {
  kind: 'profile';
  /** Profile kind with a registered runner (import, export, backup, dataTransfer …) */
  profileKind: string;
  profileName: string;
}

export type JobStep = SqlStep | BackupStep | ProfileStep;

export type ScheduleType = 'once' | 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface JobSchedule {
  enabled: boolean;
  type: ScheduleType;
  /** First run, local time 'YYYY-MM-DDTHH:mm' */
  start: string;
  /** Every N minutes / hours / days / weeks / months */
  interval: number;
  /** Weekly: 0 = Sunday … 6 = Saturday */
  weekdays: number[];
  /** Monthly: days of the month 1 … 31 */
  monthDays: number[];
  /** Last day on which the job may start 'YYYY-MM-DD' ('' = no end) */
  end: string;
  /** app = KS Table starts the job while it is running; windows = Windows task scheduler (also when KS Table is closed) */
  runner: 'app' | 'windows';
  /** Windows task: run whether the user is logged on or not (S4U logon, needs administrator rights) */
  runWhenLoggedOff: boolean;
}

export interface JobEmail {
  enabled: boolean;
  onSuccess: boolean;
  onFailure: boolean;
  /** Recipients separated by , or ; */
  to: string;
  cc: string;
  /** Placeholders: {job} {status} {start} {end} {duration} {host} {steps} */
  subject: string;
  body: string;
  attachLog: boolean;
}

export interface AutomationJob {
  id: string;
  name: string;
  description: string;
  steps: JobStep[];
  schedule: JobSchedule;
  email: JobEmail;
  /** Name of the registered Windows task (maintained by the backend) */
  windowsTask: string | null;
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = 'running' | 'success' | 'warning' | 'error' | 'cancelled';
export type RunTrigger = 'manual' | 'schedule' | 'windows';

export interface StepResult {
  stepId: string;
  name: string;
  status: 'success' | 'error' | 'skipped' | 'cancelled';
  message: string;
  durationMs: number;
}

export interface RunSummary {
  runId: string;
  jobId: string;
  jobName: string;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  message: string;
  steps: StepResult[];
  /** Result of the e-mail notification ('' = no e-mail) */
  mail: string;
}

export interface RunRecord extends RunSummary {
  log: Omit<TaskLogEntry, 'taskId'>[];
}

export interface JobListItem {
  job: AutomationJob;
  lastRun: RunSummary | null;
  /** Next scheduled start (epoch ms) */
  nextRun: number | null;
  /** Task id while the job runs in this process */
  taskId: string | null;
}

export interface SaveJobResult {
  job: AutomationJob;
  /** The job was saved, but registering / removing the Windows task failed */
  windowsError: string | null;
}

export interface WindowsTaskState {
  name: string;
  exists: boolean;
}

export interface AutomationEnvironment {
  /** Windows task scheduler usable (Windows, schtasks.exe, known app executable) */
  windowsTasks: boolean;
  /** Reason when Windows tasks are not available */
  windowsReason: string;
  /** Command line a Windows task starts (without the job id) */
  launchCommand: string;
  /** Folder of the job files */
  folder: string;
}

export interface AutomationApi {
  list(): Promise<JobListItem[]>;
  get(id: string): Promise<AutomationJob>;
  /** Saves the job and creates / updates / removes its Windows task */
  save(job: AutomationJob): Promise<SaveJobResult>;
  /** Deletes the job, its run history and its Windows task */
  remove(id: string): Promise<void>;
  /** Starts the job now; returns the task id (TaskInfo.result: RunSummary) */
  run(id: string): Promise<string>;
  runs(id: string): Promise<RunSummary[]>;
  runLog(id: string, runId: string): Promise<RunRecord>;
  clearRuns(id: string): Promise<void>;
  /** Saved profile kinds that jobs can execute (kinds with a registered runner) */
  profileKinds(): Promise<string[]>;
  windowsTask(id: string): Promise<WindowsTaskState | null>;
  environment(): Promise<AutomationEnvironment>;
  /** Sends a test e-mail; `smtp` overrides the saved SMTP settings (unsaved form values) */
  sendTestMail(to: string, smtp?: SmtpSettings): Promise<void>;
}
