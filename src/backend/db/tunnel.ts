// SSH tunnel: one ssh2 client per connection profile; every MySQL connection
// gets its own forwarded channel.

import fs from 'node:fs';
import type { Duplex } from 'node:stream';
import { Client, type ConnectConfig } from 'ssh2';
import type { SshConfig } from '@shared/types';
import { tr } from '@shared/i18n';
import { KsError } from '../errors';

export class SshTunnel {
  private client = new Client();
  private ready: Promise<void> | null = null;
  closed = false;

  constructor(
    private readonly cfg: SshConfig,
    private readonly secrets: { password: string; passphrase: string }
  ) {}

  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const c: ConnectConfig = {
        host: this.cfg.host,
        port: this.cfg.port || 22,
        username: this.cfg.user,
        readyTimeout: 20000,
        keepaliveInterval: 30000,
        tryKeyboard: this.cfg.authMethod === 'password'
      };
      if (this.cfg.authMethod === 'password') {
        c.password = this.secrets.password;
      } else if (this.cfg.authMethod === 'publicKey') {
        try {
          c.privateKey = fs.readFileSync(this.cfg.privateKeyPath);
        } catch (e) {
          reject(new KsError(tr('Privater Schlüssel kann nicht gelesen werden: {p}', 'Cannot read private key: {p}', { p: this.cfg.privateKeyPath })));
          return;
        }
        if (this.secrets.passphrase) c.passphrase = this.secrets.passphrase;
      } else {
        c.agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK;
      }
      let settled = false;
      this.client
        .on('ready', () => {
          settled = true;
          resolve();
        })
        .on('error', (err) => {
          this.closed = true;
          if (!settled) {
            settled = true;
            reject(new KsError(tr('SSH-Fehler: {m}', 'SSH error: {m}', { m: err.message }), 'SSH_ERROR'));
          }
        })
        .on('close', () => {
          this.closed = true;
        })
        .on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
          finish(prompts.map(() => this.secrets.password));
        });
      this.client.connect(c);
    });
    return this.ready;
  }

  async forward(host: string, port: number): Promise<Duplex> {
    await this.connect();
    return new Promise<Duplex>((resolve, reject) => {
      this.client.forwardOut('127.0.0.1', 0, host || '127.0.0.1', port, (err, stream) => {
        if (err) reject(new KsError(tr('SSH-Weiterleitung fehlgeschlagen: {m}', 'SSH port forwarding failed: {m}', { m: err.message }), 'SSH_ERROR'));
        else resolve(stream);
      });
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.client.end();
    } catch {
      // ignore
    }
  }
}
