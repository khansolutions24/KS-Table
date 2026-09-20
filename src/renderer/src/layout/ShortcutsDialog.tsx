import { tr } from '@shared/i18n';
import { Dialog, openDialog } from '../components/ui/Dialog';
import { Button } from '../components/ui/controls';

const GROUPS: { title: () => string; items: [string, () => string][] }[] = [
  {
    title: () => tr('Allgemein', 'General'),
    items: [
      ['Ctrl+Q', () => tr('Neue Abfrage', 'New query')],
      ['Ctrl+W', () => tr('Tab schließen', 'Close tab')],
      ['Ctrl+Tab', () => tr('Nächster Tab', 'Next tab')],
      ['Ctrl+Shift+Tab', () => tr('Vorheriger Tab', 'Previous tab')],
      ['F5', () => tr('Aktualisieren', 'Refresh')],
      ['F2', () => tr('Objekt umbenennen', 'Rename object')],
      ['Del', () => tr('Objekt löschen', 'Delete object')],
      ['F12', () => tr('Entwicklertools', 'Developer tools')]
    ]
  },
  {
    title: () => tr('Abfrage-Editor', 'Query editor'),
    items: [
      ['Ctrl+R / F9', () => tr('Ausführen', 'Run')],
      ['Ctrl+Shift+R', () => tr('Markierung / aktuelle Anweisung ausführen', 'Run selected / current statement')],
      ['Ctrl+T', () => tr('Ausführung stoppen', 'Stop execution')],
      ['Ctrl+E', () => tr('Erklären (EXPLAIN)', 'Explain')],
      ['Ctrl+S / Ctrl+Shift+S', () => tr('Speichern / Speichern unter', 'Save / Save as')],
      ['Alt+1 … 9', () => tr('Ergebnis-Tab wechseln', 'Switch result tab')],
      ['Ctrl+Shift+F', () => tr('SQL formatieren', 'Beautify SQL')],
      ['Ctrl+/', () => tr('Kommentar umschalten', 'Toggle comment')],
      ['Ctrl+Space', () => tr('Autovervollständigung', 'Code completion')],
      ['Ctrl+F / Ctrl+H', () => tr('Suchen / Ersetzen', 'Find / replace')]
    ]
  },
  {
    title: () => tr('Tabellenansicht', 'Table viewer'),
    items: [
      ['Insert / Ctrl+N', () => tr('Neuer Datensatz', 'New record')],
      ['Ctrl+Delete', () => tr('Datensatz löschen', 'Delete record')],
      ['Ctrl+S', () => tr('Änderungen übernehmen', 'Apply changes')],
      ['Esc', () => tr('Änderungen des Datensatzes verwerfen', 'Discard record changes')],
      ['Ctrl+Enter', () => tr('Zelleditor (Datum, Fremdschlüssel, BLOB …)', 'Cell editor (date, foreign key, BLOB …)')],
      ['Ctrl+Shift+N', () => tr('Auf NULL setzen', 'Set to NULL')],
      ['Ctrl+F / Ctrl+G', () => tr('Suchen / Gehe zu Zeile', 'Find / Go to row')],
      ['Ctrl+T', () => tr('Laden abbrechen', 'Stop loading')],
      ['Ctrl+D / Ctrl+Q', () => tr('Objekt entwerfen / abfragen', 'Design / query object')]
    ]
  }
];

export function showShortcuts(): Promise<void> {
  return openDialog<void>((close) => (
    <Dialog
      title={tr('Tastenkürzel', 'Keyboard Shortcuts')}
      width={620}
      onClose={() => close()}
      onSubmit={() => close()}
      footer={<Button type="submit" variant="primary">OK</Button>}
    >
      <div className="ks-shortcuts">
        {GROUPS.map((g) => (
          <div key={g.title()} className="ks-shortcuts-group">
            <h4>{g.title()}</h4>
            {g.items.map(([k, label]) => (
              <div key={k} className="ks-shortcut-row">
                <kbd>{k}</kbd>
                <span>{label()}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  )).then(() => undefined);
}
