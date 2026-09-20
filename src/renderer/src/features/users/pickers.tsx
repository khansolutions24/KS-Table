// Dialogs of the users feature: privilege object picker and account picker.

import { useMemo, useState } from 'react';
import type { PrivTarget } from '@shared/apis/users';
import { tr } from '@shared/i18n';
import { makeTarget } from '@shared/users/privileges';
import { ObjIcon } from '../../components/icons';
import { Button, Checkbox, Field, SearchInput, TextInput } from '../../components/ui/controls';
import { Dialog, openDialog } from '../../components/ui/Dialog';
import { ObjectTree } from './ObjectTree';

function TargetPicker({ connectionId, close }: { connectionId: string; close: (v?: PrivTarget[]) => void }) {
  const [sel, setSel] = useState<{ keys: string[]; targets: PrivTarget[] }>({ keys: [], targets: [] });
  const [pattern, setPattern] = useState('');
  const result = (): PrivTarget[] => [...sel.targets, ...(pattern.trim() ? [makeTarget('database', pattern.trim())] : [])];
  return (
    <Dialog
      title={tr('Rechte für Objekte hinzufügen', 'Add privileges for objects')}
      width={540}
      height={600}
      noPadding
      onClose={() => close()}
      onSubmit={() => result().length && close(result())}
      footer={
        <>
          <Button type="submit" variant="primary" disabled={!result().length}>
            {tr('Hinzufügen', 'Add')}
          </Button>
          <Button onClick={() => close()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-users-picker-hint">
        {tr(
          'Datenbank, Tabelle, Ansicht, Spalte oder Routine wählen (Strg+Klick für mehrere). Tabellen und Ansichten lassen sich für Spaltenrechte aufklappen.',
          'Choose a database, table, view, column or routine (Ctrl+click for several). Expand tables and views for column privileges.'
        )}
      </div>
      <ObjectTree
        connectionId={connectionId}
        showGlobal={false}
        multi
        selected={sel.keys}
        onSelect={(targets, keys) => setSel({ targets, keys })}
        onOpen={(t) => close([t])}
        className="ks-users-picker-tree"
      />
      <div className="ks-users-picker-pattern">
        <Field
          label={tr('Oder Datenbankmuster', 'Or database pattern')}
          labelWidth={160}
          hint={tr('% und _ sind Platzhalter; \\_ steht für einen echten Unterstrich, z. B. app\\_%', '% and _ are wildcards; \\_ stands for a literal underscore, e.g. app\\_%')}
        >
          <TextInput value={pattern} placeholder="app\_%" onChange={(e) => setPattern(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** Object picker for privilege targets (database, table/view, column, routine or a database pattern) */
export function pickPrivTargets(connectionId: string): Promise<PrivTarget[] | null> {
  return openDialog<PrivTarget[]>((close) => <TargetPicker connectionId={connectionId} close={close} />).then((v) => v ?? null);
}

export interface PickAccount {
  key: string;
  label: string;
  isRole: boolean;
  system: boolean;
}

function AccountPicker({ accounts, title, close }: { accounts: PickAccount[]; title: string; close: (v?: string[]) => void }) {
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? accounts.filter((a) => a.label.toLowerCase().includes(f)) : accounts;
  }, [accounts, filter]);
  return (
    <Dialog
      title={title}
      width={460}
      onClose={() => close()}
      onSubmit={() => chosen.length && close(chosen)}
      footer={
        <>
          <Button type="submit" variant="primary" disabled={!chosen.length}>
            {tr('Hinzufügen', 'Add')}
          </Button>
          <Button onClick={() => close()}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 8 }}>
        <SearchInput value={filter} onChange={setFilter} placeholder={tr('Konten filtern', 'Filter accounts')} autoFocus />
        <div className="ks-users-pick-list">
          {list.map((a) => (
            <Checkbox
              key={a.key}
              checked={chosen.includes(a.key)}
              onChange={(v) => setChosen((c) => (v ? [...c, a.key] : c.filter((k) => k !== a.key)))}
              label={
                <span className="row" style={{ gap: 6 }}>
                  <ObjIcon kind={a.isRole ? 'role' : 'user'} size={14} dim={a.system} />
                  {a.label}
                </span>
              }
            />
          ))}
          {!list.length && <div className="faint" style={{ padding: 8 }}>{tr('Keine Konten', 'No accounts')}</div>}
        </div>
      </div>
    </Dialog>
  );
}

export function pickAccounts(accounts: PickAccount[], title: string): Promise<string[] | null> {
  return openDialog<string[]>((close) => <AccountPicker accounts={accounts} title={title} close={close} />).then((v) => v ?? null);
}
