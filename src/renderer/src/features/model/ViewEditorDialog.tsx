// View editor of the model designer (name, options and SELECT statement).

import { useState } from 'react';
import { Glasses } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { ModelDoc, ModelView, ViewAlgorithm, ViewCheckOption, ViewSecurity } from '@shared/model/types';
import { SqlEditor } from '../../components/editor/SqlEditor';
import { Button, Field, Select, TextInput } from '../../components/ui/controls';
import { alertDialog, Dialog, openDialog } from '../../components/ui/Dialog';

export function openViewEditor(doc: ModelDoc, view: ModelView): Promise<ModelView | null> {
  return openDialog<ModelView | null>((close) => <ViewEditor doc={doc} initial={view} close={close} />).then((v) => v ?? null);
}

function ViewEditor({ doc, initial, close }: { doc: ModelDoc; initial: ModelView; close: (v?: ModelView | null) => void }) {
  const [v, setV] = useState<ModelView>(initial);
  const set = (p: Partial<ModelView>) => setV((x) => ({ ...x, ...p }));
  const submit = async () => {
    const name = v.name.trim();
    const lc = name.toLowerCase();
    let error = '';
    if (!name) error = tr('Bitte einen Namen eingeben.', 'Please enter a name.');
    else if (doc.views.some((x) => x.id !== v.id && x.name.toLowerCase() === lc) || doc.tables.some((t) => t.design.name.toLowerCase() === lc))
      error = tr('Ein Objekt namens „{n}“ existiert bereits im Modell.', 'An object named "{n}" already exists in the model.', { n: name });
    else if (!/^\s*(\(\s*)*(select|with|values|table)\b/i.test(v.definition)) error = tr('Die Definition muss eine SELECT-Anweisung sein.', 'The definition must be a SELECT statement.');
    if (error) {
      await alertDialog({ kind: 'warning', message: error });
      return;
    }
    close({ ...v, name, definition: v.definition.trim().replace(/;+$/, '') });
  };
  return (
    <Dialog
      title={tr('Ansicht im Modell bearbeiten – {n}', 'Edit Model View – {n}', { n: v.name || tr('Unbenannt', 'Untitled') })}
      icon={<Glasses size={16} />}
      width={860}
      height={600}
      resizable
      noPadding
      onClose={() => close(null)}
      footer={
        <>
          <Button variant="primary" onClick={() => void submit()}>
            OK
          </Button>
          <Button onClick={() => close(null)}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-te">
        <div className="ks-te-head">
          <label>{tr('Name', 'Name')}</label>
          <TextInput data-autofocus value={v.name} onChange={(e) => set({ name: e.target.value })} />
          <label>{tr('Kommentar', 'Comment')}</label>
          <TextInput value={v.comment} onChange={(e) => set({ comment: e.target.value })} />
          <label>{tr('Algorithmus', 'Algorithm')}</label>
          <div className="row">
            <Select<ViewAlgorithm> value={v.algorithm} onChange={(algorithm) => set({ algorithm })} options={[{ value: '', label: tr('(Standard)', '(default)') }, 'UNDEFINED', 'MERGE', 'TEMPTABLE']} />
            <Field label="SQL SECURITY" labelWidth={100}>
              <Select<ViewSecurity> value={v.security} onChange={(security) => set({ security })} options={[{ value: '', label: tr('(Standard)', '(default)') }, 'DEFINER', 'INVOKER']} />
            </Field>
          </div>
          <label>{tr('Prüfoption', 'Check option')}</label>
          <Select<ViewCheckOption> value={v.checkOption} onChange={(checkOption) => set({ checkOption })} options={[{ value: '', label: tr('(keine)', '(none)') }, 'CASCADED', 'LOCAL']} />
        </div>
        <div className="ks-te-page">
          <SqlEditor value={v.definition} onChange={(definition) => set({ definition })} />
        </div>
      </div>
    </Dialog>
  );
}
