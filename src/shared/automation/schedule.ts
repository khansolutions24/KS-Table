// Schedules of automation jobs: next start calculation and description (backend scheduler + UI).

import type { AutomationJob, JobEmail, JobSchedule } from '../apis/automation';
import { getLang, locale, tr } from '../i18n';

const p2 = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DDTHH:mm' in local time (value format of <input type="datetime-local">) */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function parseLocal(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

function endOfDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime() : null;
}

export function defaultSchedule(now: Date = new Date()): JobSchedule {
  const d = new Date(now.getTime() + 3_600_000);
  d.setMinutes(0, 0, 0);
  return {
    enabled: false,
    type: 'daily',
    start: toLocalInput(d),
    interval: 1,
    weekdays: [d.getDay()],
    monthDays: [d.getDate()],
    end: '',
    runner: 'app',
    runWhenLoggedOff: false
  };
}

export function defaultEmail(): JobEmail {
  return {
    enabled: false,
    onSuccess: false,
    onFailure: true,
    to: '',
    cc: '',
    subject: tr('KS Table: {job} – {status}', 'KS Table: {job} – {status}'),
    body: tr(
      'Der Auftrag „{job}“ wurde am {start} ausgeführt.\nStatus: {status}\nDauer: {duration}\n\n{steps}',
      'Job "{job}" ran on {start}.\nStatus: {status}\nDuration: {duration}\n\n{steps}'
    ),
    attachLog: true
  };
}

export function newJob(id: string, name: string): AutomationJob {
  const now = Date.now();
  return { id, name, description: '', steps: [], schedule: defaultSchedule(), email: defaultEmail(), windowsTask: null, createdAt: now, updatedAt: now };
}

const mondayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));

/** Next start strictly after `after` (epoch ms) or null when the schedule has no further start. */
export function nextRun(sc: JobSchedule, after: number): number | null {
  const start = parseLocal(sc.start);
  if (!start) return null;
  const s0 = start.getTime();
  const end = sc.end ? endOfDay(sc.end) : null;
  const n = Math.max(1, Math.floor(Number(sc.interval) || 1));
  const ok = (t: number | null): number | null => (t !== null && (end === null || t <= end) ? t : null);
  const h = start.getHours();
  const mi = start.getMinutes();

  switch (sc.type) {
    case 'once':
      return ok(s0 > after ? s0 : null);
    case 'minutes':
    case 'hourly': {
      const period = n * (sc.type === 'minutes' ? 60_000 : 3_600_000);
      if (s0 > after) return ok(s0);
      return ok(s0 + (Math.floor((after - s0) / period) + 1) * period);
    }
    case 'daily': {
      let k = s0 > after ? 0 : Math.max(0, Math.floor((after - s0) / (n * 86_400_000)) - 1);
      for (let i = 0; i < 10; i++, k++) {
        const c = new Date(start.getFullYear(), start.getMonth(), start.getDate() + k * n, h, mi).getTime();
        if (c > after) return ok(c);
      }
      return null;
    }
    case 'weekly': {
      const days = new Set(sc.weekdays.length ? sc.weekdays : [start.getDay()]);
      const startWeek = mondayOf(start).getTime();
      const from = new Date(Math.max(after, s0 - 1));
      for (let i = 0; i <= 7 * n + 7; i++) {
        const c = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, mi);
        const ct = c.getTime();
        if (ct <= after || ct < s0 || !days.has(c.getDay())) continue;
        const week = Math.floor(Math.round((mondayOf(c).getTime() - startWeek) / 86_400_000) / 7);
        if (week % n !== 0) continue;
        return ok(ct);
      }
      return null;
    }
    case 'monthly': {
      const days = [...new Set(sc.monthDays.length ? sc.monthDays : [start.getDate()])].filter((d) => d >= 1 && d <= 31).sort((a, b) => a - b);
      const from = new Date(Math.max(after, s0));
      let offset = (from.getFullYear() - start.getFullYear()) * 12 + (from.getMonth() - start.getMonth());
      offset = Math.max(0, offset - (offset % n));
      for (let i = 0; i < 240; i++, offset += n) {
        const y = start.getFullYear();
        const m = start.getMonth() + offset;
        const dim = new Date(y, m + 1, 0).getDate();
        for (const day of days) {
          if (day > dim) continue;
          const ct = new Date(y, m, day, h, mi).getTime();
          if (ct > after && ct >= s0) return ok(ct);
        }
        if (end !== null && new Date(y, m, 1).getTime() > end) return null;
      }
      return null;
    }
  }
  return null;
}

const WEEKDAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function weekdayName(d: number): string {
  return (getLang() === 'en' ? WEEKDAYS_EN : WEEKDAYS_DE)[d] ?? String(d);
}

export function formatStart(t: number | Date): string {
  const d = typeof t === 'number' ? new Date(t) : t;
  return `${d.toLocaleDateString(locale(), { year: 'numeric', month: '2-digit', day: '2-digit' })} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Human readable schedule, e.g. "Täglich um 03:00" */
export function describeSchedule(sc: JobSchedule): string {
  if (!sc.enabled) return tr('Kein Zeitplan', 'Not scheduled');
  const start = parseLocal(sc.start);
  if (!start) return tr('Ungültiger Zeitplan', 'Invalid schedule');
  const n = Math.max(1, Math.floor(Number(sc.interval) || 1));
  const time = `${p2(start.getHours())}:${p2(start.getMinutes())}`;
  const from = formatStart(start);
  let text: string;
  switch (sc.type) {
    case 'once':
      text = tr('Einmalig am {d}', 'Once on {d}', { d: from });
      break;
    case 'minutes':
      text = n === 1 ? tr('Jede Minute ab {d}', 'Every minute from {d}', { d: from }) : tr('Alle {n} Minuten ab {d}', 'Every {n} minutes from {d}', { n, d: from });
      break;
    case 'hourly':
      text = n === 1 ? tr('Stündlich ab {d}', 'Hourly from {d}', { d: from }) : tr('Alle {n} Stunden ab {d}', 'Every {n} hours from {d}', { n, d: from });
      break;
    case 'daily':
      text = n === 1 ? tr('Täglich um {t}', 'Daily at {t}', { t: time }) : tr('Alle {n} Tage um {t}', 'Every {n} days at {t}', { n, t: time });
      break;
    case 'weekly': {
      const days = (sc.weekdays.length ? sc.weekdays : [start.getDay()])
        .slice()
        .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
        .map(weekdayName)
        .join(', ');
      text = n === 1 ? tr('Wöchentlich ({w}) um {t}', 'Weekly ({w}) at {t}', { w: days, t: time }) : tr('Alle {n} Wochen ({w}) um {t}', 'Every {n} weeks ({w}) at {t}', { n, w: days, t: time });
      break;
    }
    case 'monthly': {
      const days = (sc.monthDays.length ? sc.monthDays : [start.getDate()])
        .slice()
        .sort((a, b) => a - b)
        .map((d) => (getLang() === 'en' ? String(d) : `${d}.`))
        .join(', ');
      text =
        n === 1
          ? tr('Monatlich am {d} um {t}', 'Monthly on day {d} at {t}', { d: days, t: time })
          : tr('Alle {n} Monate am {d} um {t}', 'Every {n} months on day {d} at {t}', { n, d: days, t: time });
      break;
    }
  }
  if (sc.end) text += tr(' bis {e}', ' until {e}', { e: sc.end });
  return text;
}
