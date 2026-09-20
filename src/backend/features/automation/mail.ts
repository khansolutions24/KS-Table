// E-mail notification after job runs (nodemailer with the SMTP settings of the app).

import os from 'node:os';
import { createTransport, type SendMailOptions } from 'nodemailer';
import type { AutomationJob, RunRecord } from '@shared/apis/automation';
import type { SmtpSettings } from '@shared/types';
import { runStatusLabel, stepStatusLabel, triggerLabel } from '@shared/automation/labels';
import { defaultEmail, formatStart } from '@shared/automation/schedule';
import { tr } from '@shared/i18n';
import { formatDuration, safeFileName } from '@shared/util';
import { KsError } from '../../errors';
import { getSettings } from '../../store/settings';
import { runLogText } from './store';

export interface MailSender {
  sendMail(options: SendMailOptions): Promise<unknown>;
}

export type MailTransportFactory = (smtp: SmtpSettings) => MailSender;

export const smtpTransport: MailTransportFactory = (smtp) => {
  if (!smtp.host?.trim()) {
    throw new KsError(tr('Es ist kein SMTP-Server eingerichtet (Automatisierung → E-Mail-Einstellungen).', 'No SMTP server is configured (Automation → E-mail settings).'), 'SMTP_MISSING');
  }
  return createTransport({
    host: smtp.host.trim(),
    port: Number(smtp.port) || (smtp.secure ? 465 : 587),
    secure: !!smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000
  });
};

export function splitAddresses(s: string): string[] {
  return (s ?? '')
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function sender(smtp: SmtpSettings): string {
  const from = (smtp.from || smtp.user || '').trim();
  if (!from) throw new KsError(tr('Bitte eine Absenderadresse in den E-Mail-Einstellungen angeben.', 'Please enter a sender address in the e-mail settings.'));
  return from;
}

export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export function buildRunMail(job: AutomationJob, rec: RunRecord): { subject: string; text: string; attachments: { filename: string; content: string }[] } {
  const steps = rec.steps.map((s) => `• ${s.name}: ${stepStatusLabel(s.status)}${s.message ? ` – ${s.message}` : ''}`).join('\n');
  const vars: Record<string, string> = {
    job: job.name,
    status: runStatusLabel(rec.status),
    start: formatStart(rec.startedAt),
    end: rec.endedAt ? formatStart(rec.endedAt) : '',
    duration: formatDuration((rec.endedAt ?? Date.now()) - rec.startedAt),
    host: os.hostname(),
    trigger: triggerLabel(rec.trigger),
    steps
  };
  const defaults = defaultEmail();
  return {
    subject: fillTemplate(job.email.subject.trim() || defaults.subject, vars).replace(/[\r\n]+/g, ' '),
    text: fillTemplate(job.email.body.trim() || defaults.body, vars),
    attachments: job.email.attachLog ? [{ filename: `${safeFileName(job.name)}-${rec.runId}.log`, content: runLogText(rec) }] : []
  };
}

/** Sends the notification of a run; returns a log line. */
export async function sendRunMail(
  job: AutomationJob,
  rec: RunRecord,
  smtp: SmtpSettings = getSettings().smtp,
  factory: MailTransportFactory = smtpTransport
): Promise<string> {
  const to = splitAddresses(job.email.to);
  const cc = splitAddresses(job.email.cc);
  if (!to.length) throw new KsError(tr('Für die Benachrichtigung sind keine Empfänger angegeben.', 'No recipients are specified for the notification.'));
  const mail = buildRunMail(job, rec);
  await factory(smtp).sendMail({ from: sender(smtp), to, cc: cc.length ? cc : undefined, subject: mail.subject, text: mail.text, attachments: mail.attachments });
  return tr('E-Mail an {to} gesendet', 'E-mail sent to {to}', { to: [...to, ...cc].join(', ') });
}

export async function sendTestMail(to: string, smtp?: SmtpSettings, factory: MailTransportFactory = smtpTransport): Promise<void> {
  const cfg = smtp ?? getSettings().smtp;
  const rcpt = splitAddresses(to);
  if (!rcpt.length) throw new KsError(tr('Bitte eine Empfängeradresse angeben.', 'Please enter a recipient address.'));
  await factory(cfg).sendMail({
    from: sender(cfg),
    to: rcpt,
    subject: tr('KS Table – Test-E-Mail', 'KS Table – test e-mail'),
    text: tr(
      'Diese Test-E-Mail wurde von KS Table auf {h} gesendet. Die SMTP-Einstellungen funktionieren.',
      'This test e-mail was sent by KS Table on {h}. The SMTP settings work.',
      { h: os.hostname() }
    )
  });
}
