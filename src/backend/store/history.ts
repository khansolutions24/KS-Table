// History log of executed SQL (<userData>/history.jsonl).

import fs from 'node:fs';
import path from 'node:path';
import type { HistoryEntry } from '@shared/types';
import { newId } from '@shared/defaults';
import { emit } from '../events';
import { getSettings } from './settings';

const MAX_SQL = 100_000;

export class HistoryStore {
  private readonly file: string;
  private entries: HistoryEntry[] = [];

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'history.jsonl');
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.entries.push(JSON.parse(line) as HistoryEntry);
        } catch {
          // skip damaged line
        }
      }
    } catch {
      // no history yet
    }
    const max = getSettings().historyMaxEntries;
    if (this.entries.length > max) {
      this.entries = this.entries.slice(-max);
      this.rewrite();
    }
  }

  add(e: Omit<HistoryEntry, 'id' | 'time'>): void {
    const s = getSettings();
    if (!s.historyEnabled) return;
    const entry: HistoryEntry = {
      ...e,
      id: newId('h'),
      time: Date.now(),
      sql: e.sql.length > MAX_SQL ? e.sql.slice(0, MAX_SQL) + ' …' : e.sql
    };
    this.entries.push(entry);
    fs.appendFile(this.file, JSON.stringify(entry) + '\n', () => undefined);
    emit('history:added', entry);
    if (this.entries.length > s.historyMaxEntries * 1.2) {
      this.entries = this.entries.slice(-s.historyMaxEntries);
      this.rewrite();
    }
  }

  list(filter: { connectionId?: string; search?: string; limit?: number } = {}): HistoryEntry[] {
    let list = this.entries;
    if (filter.connectionId) list = list.filter((e) => e.connectionId === filter.connectionId);
    if (filter.search) {
      const q = filter.search.toLowerCase();
      list = list.filter((e) => e.sql.toLowerCase().includes(q) || (e.database ?? '').toLowerCase().includes(q));
    }
    const limit = filter.limit ?? 2000;
    return list.slice(-limit).reverse();
  }

  clear(): void {
    this.entries = [];
    this.rewrite();
  }

  private rewrite(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, this.entries.map((e) => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : ''));
    } catch {
      // ignore
    }
  }
}
