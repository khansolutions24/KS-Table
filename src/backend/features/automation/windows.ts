// Windows Task Scheduler integration: an XML task definition registered with schtasks.exe.
// Tasks are only created when the user saves a job with the runner "Windows-Aufgabenplanung".

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import type { AutomationJob } from '@shared/apis/automation';
import { parseLocal } from '@shared/automation/schedule';
import { tr } from '@shared/i18n';
import { KsError } from '../../errors';

export interface LaunchCommand {
  command: string;
  args: string[];
  cwd: string;
}

export function schtasksPath(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
}

export function schtasksAvailable(): boolean {
  return process.platform === 'win32' && fs.existsSync(schtasksPath());
}

/** Command line that starts this installation of KS Table (without --run-job). */
export function launchCommand(): LaunchCommand | { error: string } {
  if (process.platform !== 'win32') return { error: tr('Die Windows-Aufgabenplanung ist nur unter Windows verfügbar.', 'The Windows Task Scheduler is only available on Windows.') };
  if (process.versions.electron) {
    const exe = process.execPath;
    if ((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp) {
      // development build: electron.exe <app folder>
      const appArg = process.argv.slice(1).find((a) => !a.startsWith('-'));
      const appDir = path.resolve(appArg ?? '.');
      return { command: exe, args: [appDir], cwd: appDir };
    }
    return { command: exe, args: [], cwd: path.dirname(exe) };
  }
  // browser development mode (plain Node backend): start the Electron build of this project folder
  const root = process.cwd();
  const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(exe) || !fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
    return {
      error: tr(
        'Im Browser-Entwicklungsmodus ist keine startbare Desktop-Anwendung vorhanden (zuerst „npm run build“ ausführen).',
        'No startable desktop application exists in browser development mode (run "npm run build" first).'
      )
    };
  }
  return { command: exe, args: [root], cwd: root };
}

const quoteArg = (a: string): string => (/[\s"]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a);

export function formatCommand(cmd: LaunchCommand, jobId: string): string {
  return [cmd.command, ...cmd.args, '--run-job', jobId].map(quoteArg).join(' ');
}

export function taskNameFor(job: AutomationJob): string {
  const clean = job.name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || tr('Auftrag', 'Job');
  return `KS Table ${clean} (${job.id.slice(-6)})`;
}

const xmlEsc = (s: string): string =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function taskXml(job: AutomationJob, cmd: LaunchCommand): string {
  const sc = job.schedule;
  const start = parseLocal(sc.start);
  if (!start) throw new KsError(tr('Der Startzeitpunkt des Zeitplans ist ungültig.', 'The start time of the schedule is invalid.'));
  const p2 = (n: number) => String(n).padStart(2, '0');
  const iso = `${start.getFullYear()}-${p2(start.getMonth() + 1)}-${p2(start.getDate())}T${p2(start.getHours())}:${p2(start.getMinutes())}:00`;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(sc.end) ? `<EndBoundary>${sc.end}T23:59:59</EndBoundary>` : '';
  const base = `<StartBoundary>${iso}</StartBoundary>${end}<Enabled>true</Enabled>`;
  const n = Math.max(1, Math.floor(sc.interval || 1));
  let trigger: string;
  switch (sc.type) {
    case 'once':
      trigger = `<TimeTrigger>${base}</TimeTrigger>`;
      break;
    case 'minutes':
    case 'hourly':
      trigger = `<TimeTrigger><Repetition><Interval>PT${n}${sc.type === 'minutes' ? 'M' : 'H'}</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>${base}</TimeTrigger>`;
      break;
    case 'daily':
      trigger = `<CalendarTrigger>${base}<ScheduleByDay><DaysInterval>${n}</DaysInterval></ScheduleByDay></CalendarTrigger>`;
      break;
    case 'weekly': {
      const days = [...new Set(sc.weekdays.length ? sc.weekdays : [start.getDay()])].sort((a, b) => a - b);
      trigger = `<CalendarTrigger>${base}<ScheduleByWeek><DaysOfWeek>${days.map((d) => `<${DAYS[d]} />`).join('')}</DaysOfWeek><WeeksInterval>${n}</WeeksInterval></ScheduleByWeek></CalendarTrigger>`;
      break;
    }
    default: {
      const days = [...new Set(sc.monthDays.length ? sc.monthDays : [start.getDate()])].sort((a, b) => a - b);
      // every n months starting with the month of the first run
      const months = MONTHS.filter((_, m) => ((m - start.getMonth() + 12) % 12) % n === 0);
      trigger = `<CalendarTrigger>${base}<ScheduleByMonth><DaysOfMonth>${days.map((d) => `<Day>${d}</Day>`).join('')}</DaysOfMonth><Months>${months.map((m) => `<${m} />`).join('')}</Months></ScheduleByMonth></CalendarTrigger>`;
    }
  }
  const user = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${process.env.USERNAME || os.userInfo().username}`;
  const args = [...cmd.args, '--run-job', job.id].map(quoteArg).join(' ');
  const description = tr('KS Table – Automatisierungsauftrag „{j}“', 'KS Table – automation job "{j}"', { j: job.name });
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>KS Table</Author>
    <Description>${xmlEsc(description)}</Description>
  </RegistrationInfo>
  <Triggers>${trigger}</Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEsc(user)}</UserId>
      <LogonType>${sc.runWhenLoggedOff ? 'S4U' : 'InteractiveToken'}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEsc(cmd.command)}</Command>
      <Arguments>${xmlEsc(args)}</Arguments>
      <WorkingDirectory>${xmlEsc(cmd.cwd)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function decode(b: Buffer | string): string {
  if (typeof b === 'string') return b;
  const s = b.toString('utf8');
  return s.includes('\uFFFD') ? iconv.decode(b, 'cp850') : s;
}

function schtasks(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(schtasksPath(), args, { windowsHide: true, encoding: 'buffer', timeout: 30_000 }, (err, stdout, stderr) => {
      const out = `${decode(stdout)}\n${decode(stderr)}`.replace(/\s+/g, ' ').trim();
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 1) : 0;
      resolve({ code, out });
    });
  });
}

export async function registerTask(name: string, xml: string): Promise<void> {
  const file = path.join(os.tmpdir(), `ks-table-task-${process.pid}-${Date.now()}.xml`);
  await fsp.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  try {
    const r = await schtasks(['/Create', '/TN', name, '/XML', file, '/F']);
    if (r.code !== 0) {
      throw new KsError(tr('Die Windows-Aufgabe konnte nicht angelegt werden: {m}', 'The Windows task could not be created: {m}', { m: r.out || `exit ${r.code}` }));
    }
  } finally {
    await fsp.rm(file, { force: true }).catch(() => undefined);
  }
}

export async function taskExists(name: string): Promise<boolean> {
  return (await schtasks(['/Query', '/TN', name])).code === 0;
}

export async function deleteTask(name: string): Promise<void> {
  if (!(await taskExists(name))) return;
  const r = await schtasks(['/Delete', '/TN', name, '/F']);
  if (r.code !== 0) {
    throw new KsError(tr('Die Windows-Aufgabe „{n}“ konnte nicht gelöscht werden: {m}', 'The Windows task "{n}" could not be deleted: {m}', { n: name, m: r.out || `exit ${r.code}` }));
  }
}
