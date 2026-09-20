// Execute SQL file: runs one or more (huge) script files as a backend task.

import { useState } from 'react';
import { ArrowDown, ArrowUp, FilePlus, FolderOpen, X } from 'lucide-react';
import clsx from 'clsx';
import { tr } from '@shared/i18n';
import type { ExecSqlFileProfile, ExecTransactionMode } from '@shared/apis/io';
import { encodingOptions } from '@shared/io/defaults';
import { api } from '../../api/client';
import { errorDialog } from '../../components/ui/Dialog';
import { Button, Checkbox, Field, IconButton, RadioGroup, Section, Select } from '../../components/ui/controls';
import { TaskPanel } from '../../components/TaskPanel';
import { pickOpenFiles } from '../../lib/files';
import type { TabProps } from '../../store/tabs';
import { useWorkspace } from '../../store/workspace';
import { baseOf, ProfileButtons, useDatabases, useTaskDone } from './common';

const LW = 150;

export default function ExecSqlFileTab({ tab }: TabProps) {
  const params = tab.params as { connectionId: string; database: string | null };
  const cid = params.connectionId;
  const [database, setDatabase] = useState<string>(params.database ?? '');
  const [files, setFiles] = useState<string[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [encoding, setEncoding] = useState('auto');
  const [continueOnError, setContinueOnError] = useState(false);
  const [txMode, setTxMode] = useState<ExecTransactionMode>('autocommit');
  const [taskId, setTaskId] = useState<string | null>(null);
  const databases = useDatabases(cid);

  const running = useTaskDone(taskId, () => {
    // statements may have created or changed objects
    const ws = useWorkspace.getState();
    void ws.refreshConnection(cid);
  });

  const profile = (): ExecSqlFileProfile => ({
    version: 1,
    connectionId: cid,
    database: database || null,
    files,
    encoding,
    continueOnError,
    transactionMode: txMode
  });

  const addFiles = async () => {
    const picked = await pickOpenFiles({
      title: tr('SQL-Dateien auswählen', 'Choose SQL files'),
      filters: [
        { name: tr('SQL-Skripte', 'SQL scripts'), extensions: ['sql', 'txt'] },
        { name: tr('Alle Dateien', 'All files'), extensions: ['*'] }
      ]
    });
    if (picked?.length) setFiles((f) => [...f, ...picked.filter((p) => !f.includes(p))]);
  };

  const move = (d: -1 | 1) => {
    if (sel === null) return;
    const to = sel + d;
    if (to < 0 || to >= files.length) return;
    const next = files.slice();
    [next[sel], next[to]] = [next[to], next[sel]];
    setFiles(next);
    setSel(to);
  };

  const start = async () => {
    try {
      setTaskId(await api.io.startExecSqlFile(profile()));
    } catch (e) {
      void errorDialog(e);
    }
  };

  return (
    <div className="ks-wizard">
      <div className="ks-wizard-body">
        <div className="ks-io-form" style={{ gridTemplateColumns: 'minmax(360px, 1fr) minmax(320px, 1fr)' }}>
          <div className="ks-io-box" style={{ minHeight: 200 }}>
            <div className="ks-io-box-head">
              <strong>{tr('SQL-Dateien', 'SQL files')}</strong>
              <div className="spacer" />
              <IconButton icon={<FilePlus size={15} />} title={tr('Dateien hinzufügen …', 'Add files …')} disabled={running} onClick={() => void addFiles()} />
              <IconButton icon={<ArrowUp size={15} />} title={tr('Nach oben', 'Move up')} disabled={running || sel === null || sel === 0} onClick={() => move(-1)} />
              <IconButton icon={<ArrowDown size={15} />} title={tr('Nach unten', 'Move down')} disabled={running || sel === null || sel >= files.length - 1} onClick={() => move(1)} />
              <IconButton
                icon={<X size={15} />}
                title={tr('Entfernen', 'Remove')}
                disabled={running || sel === null}
                onClick={() => {
                  if (sel === null) return;
                  setFiles(files.filter((_, i) => i !== sel));
                  setSel(null);
                }}
              />
            </div>
            <div
              className="ks-io-box-body"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Delete' && sel !== null && !running) {
                  e.stopPropagation();
                  setFiles(files.filter((_, i) => i !== sel));
                  setSel(null);
                }
              }}
            >
              {files.length === 0 ? (
                <div className="ks-io-preview-msg">
                  <Button icon={<FolderOpen size={14} />} onClick={() => void addFiles()}>
                    {tr('Dateien auswählen …', 'Choose files …')}
                  </Button>
                </div>
              ) : (
                files.map((f, i) => (
                  <div key={f} className={clsx('ks-io-list-item', sel === i && 'selected')} title={f} onMouseDown={() => setSel(i)}>
                    <span className="faint">{i + 1}.</span>
                    <span className="ellipsis">{baseOf(f)}</span>
                    <span className="faint ellipsis" style={{ maxWidth: '45%', flex: 'none' }}>
                      {f.slice(0, Math.max(0, f.length - baseOf(f).length - 1))}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="ks-form">
            <Field label={tr('Datenbank', 'Database')} labelWidth={LW}>
              <Select
                value={database}
                disabled={running}
                onChange={setDatabase}
                options={[{ value: '', label: tr('(keine – laut Skript)', '(none – as in the script)') }, ...[...new Set([...databases, ...(params.database ? [params.database] : [])])].map((d) => ({ value: d, label: d }))]}
              />
            </Field>
            <Field label={tr('Zeichenkodierung', 'Encoding')} labelWidth={LW}>
              <Select value={encoding} disabled={running} onChange={setEncoding} options={encodingOptions('read')} />
            </Field>
            <Section title={tr('Optionen', 'Options')}>
              <Checkbox checked={continueOnError} disabled={running} onChange={setContinueOnError} label={tr('Bei Fehlern fortfahren', 'Continue on error')} />
              <RadioGroup
                value={txMode}
                disabled={running}
                onChange={setTxMode}
                options={[
                  { value: 'autocommit', label: tr('Jede Anweisung sofort festschreiben (Autocommit)', 'Commit every statement (autocommit)') },
                  { value: 'noAutocommit', label: tr('Autocommit aus (SET autocommit = 0), am Ende festschreiben', 'Autocommit off (SET autocommit = 0), commit at the end') },
                  { value: 'transaction', label: tr('Alles in einer Transaktion (Rücksetzen bei Abbruch)', 'Everything in one transaction (rollback on abort)') }
                ]}
              />
            </Section>
          </div>
        </div>
        {taskId ? (
          <div className="ks-io-run">
            <TaskPanel taskId={taskId} />
          </div>
        ) : (
          <div className="muted">
            {tr(
              'Die Dateien werden abschnittsweise gelesen, daher können auch sehr große Sicherungsskripte ausgeführt werden. DELIMITER-Befehle und BEGIN … END-Blöcke werden erkannt.',
              'Files are read in portions, so very large backup scripts can be executed as well. DELIMITER commands and BEGIN … END blocks are recognised.'
            )}
          </div>
        )}
      </div>
      <div className="ks-wizard-footer">
        <ProfileButtons<ExecSqlFileProfile>
          kind="execSqlFile"
          disabled={running}
          current={profile}
          onLoad={(p) => {
            setFiles(p.files ?? []);
            setDatabase(p.database ?? '');
            setEncoding(p.encoding || 'auto');
            setContinueOnError(!!p.continueOnError);
            setTxMode(p.transactionMode ?? 'autocommit');
          }}
        />
        <div className="spacer" />
        <Button variant="primary" disabled={running || !files.length} onClick={() => void start()}>
          {tr('Starten', 'Start')}
        </Button>
      </div>
    </div>
  );
}
