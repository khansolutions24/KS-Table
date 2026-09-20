// Options: general, editor, records, queries, history, file locations. Changes apply immediately.

import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Code, FolderOpen, History, Keyboard, Settings, TableProperties, Terminal } from 'lucide-react';
import type { DeepPartial, AppInfo } from '@shared/api';
import type { AppSettings } from '@shared/types';
import { tr } from '@shared/i18n';
import { api, isElectron } from '../../api/client';
import { SqlEditor } from '../../components/editor/SqlEditor';
import { confirmDialog } from '../../components/ui/Dialog';
import { Button, Checkbox, Field, NumberInput, Section, Select, TextInput } from '../../components/ui/controls';
import { PathInput } from '../../components/ui/PathInput';
import { toast } from '../../components/Toast';
import { applyTheme } from '../../lib/theme';
import { showShortcuts } from '../../layout/ShortcutsDialog';
import { useSettings } from '../../store/settings';
import { useWorkspace } from '../../store/workspace';
import type { TabProps } from '../../store/tabs';
import './options.css';

type Page = 'general' | 'editor' | 'records' | 'query' | 'history' | 'files';

const PAGES: { id: Page; label: () => string; icon: ReactNode }[] = [
  { id: 'general', label: () => tr('Allgemein', 'General'), icon: <Settings size={16} /> },
  { id: 'editor', label: () => tr('Editor', 'Editor'), icon: <Code size={16} /> },
  { id: 'records', label: () => tr('Datensätze', 'Records'), icon: <TableProperties size={16} /> },
  { id: 'query', label: () => tr('Abfragen', 'Queries'), icon: <Terminal size={16} /> },
  { id: 'history', label: () => tr('Verlauf', 'History'), icon: <History size={16} /> },
  { id: 'files', label: () => tr('Dateipfade', 'File locations'), icon: <FolderOpen size={16} /> }
];

const FONTS = [
  "'Cascadia Mono', Consolas, 'Courier New', monospace",
  "Consolas, 'Courier New', monospace",
  "'JetBrains Mono', Consolas, monospace",
  "'Fira Code', Consolas, monospace",
  "'Source Code Pro', Consolas, monospace",
  "'Courier New', monospace"
];

const SAMPLE = `-- ${tr('Beispiel', 'Sample')}\nSELECT c.id, CONCAT(c.first_name, ' ', c.last_name) AS name, COUNT(o.id) AS orders\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nWHERE c.country = 'DE' AND c.created_at >= '2025-01-01'\nGROUP BY c.id\nORDER BY orders DESC\nLIMIT 10;`;

const LW = 230;

export default function OptionsTab(_props: TabProps) {
  const s = useSettings((x) => x.settings);
  const update = useSettings((x) => x.update);
  const [page, setPage] = useState<Page>('general');
  const [info, setInfo] = useState<AppInfo | null>(null);
  const initialLanguage = useState(s.language)[0];

  useEffect(() => {
    void api.app.info().then(setInfo);
  }, []);

  const set = (patch: DeepPartial<AppSettings>) => void update(patch);
  const setEditor = (patch: Partial<AppSettings['editor']>) => set({ editor: patch });
  const setGrid = (patch: Partial<AppSettings['grid']>) => set({ grid: patch });
  const setQuery = (patch: Partial<AppSettings['query']>) => set({ query: patch });

  const restart = () => {
    if (isElectron) void api.app.relaunch();
    else location.reload();
  };

  return (
    <div className="ks-opt">
      <nav className="ks-opt-nav">
        {PAGES.map((p) => (
          <button key={p.id} type="button" className={clsx('ks-opt-nav-item', page === p.id && 'active')} onClick={() => setPage(p.id)}>
            {p.icon}
            <span>{p.label()}</span>
          </button>
        ))}
      </nav>
      <div className="ks-opt-body">
        {page === 'general' && (
          <div className="ks-form">
            <h2>{tr('Allgemein', 'General')}</h2>
            <Section title={tr('Darstellung', 'Appearance')}>
              <Field label={tr('Sprache', 'Language')} labelWidth={LW} hint={s.language !== initialLanguage ? tr('Wird nach einem Neustart wirksam.', 'Takes effect after a restart.') : undefined}>
                <div className="row">
                  <Select
                    value={s.language}
                    onChange={(language) => set({ language })}
                    options={[
                      { value: 'de', label: 'Deutsch' },
                      { value: 'en', label: 'English' }
                    ]}
                    style={{ width: 200 }}
                  />
                  {s.language !== initialLanguage && (
                    <Button size="sm" onClick={restart}>
                      {tr('Jetzt neu starten', 'Restart now')}
                    </Button>
                  )}
                </div>
              </Field>
              <Field label={tr('Farbschema', 'Theme')} labelWidth={LW}>
                <Select
                  value={s.theme}
                  onChange={(theme) => {
                    set({ theme });
                    applyTheme(theme);
                  }}
                  options={[
                    { value: 'light', label: tr('Hell', 'Light') },
                    { value: 'dark', label: tr('Dunkel', 'Dark') },
                    { value: 'system', label: tr('Wie Windows', 'Follow system') }
                  ]}
                  style={{ width: 200 }}
                />
              </Field>
              <Field label={tr('Schriftgröße der Oberfläche', 'Interface font size')} labelWidth={LW}>
                <NumberInput
                  value={s.uiFontSize}
                  min={11}
                  max={18}
                  style={{ width: 90 }}
                  onChange={(v) => {
                    if (v === '' || v < 11 || v > 18) return;
                    set({ uiFontSize: v });
                    document.documentElement.style.setProperty('--fs', `${v}px`);
                  }}
                />
              </Field>
            </Section>
            <Section title={tr('Fenster', 'Window')}>
              <Checkbox checked={s.showNavigator} onChange={(showNavigator) => set({ showNavigator })} label={tr('Navigationsbereich anzeigen', 'Show navigation pane')} />
              <Checkbox checked={s.showInfoPane} onChange={(showInfoPane) => set({ showInfoPane })} label={tr('Informationsbereich anzeigen', 'Show information pane')} />
              <Checkbox
                checked={s.navigatorShowObjects}
                onChange={(navigatorShowObjects) => set({ navigatorShowObjects })}
                label={tr('Objekte (Tabellen, Ansichten …) im Navigationsbereich anzeigen', 'Show objects (tables, views …) in the navigation pane')}
              />
              <Checkbox checked={s.confirmOnExit} onChange={(confirmOnExit) => set({ confirmOnExit })} label={tr('Beim Beenden nachfragen', 'Ask before exiting')} />
            </Section>
            <Section title={tr('Tastatur', 'Keyboard')}>
              <div>
                <Button icon={<Keyboard size={15} />} onClick={() => void showShortcuts()}>
                  {tr('Tastenkürzel anzeigen …', 'Show keyboard shortcuts …')}
                </Button>
              </div>
            </Section>
          </div>
        )}

        {page === 'editor' && (
          <div className="ks-form">
            <h2>{tr('SQL-Editor', 'SQL editor')}</h2>
            <Section title={tr('Schrift', 'Font')}>
              <Field label={tr('Schriftart', 'Font family')} labelWidth={LW}>
                <Select
                  value={FONTS.includes(s.editor.fontFamily) ? s.editor.fontFamily : FONTS[0]}
                  onChange={(fontFamily) => setEditor({ fontFamily })}
                  options={FONTS.map((f) => ({ value: f, label: f.split(',')[0].replace(/'/g, '') }))}
                  style={{ width: 260 }}
                />
              </Field>
              <Field label={tr('Schriftgröße', 'Font size')} labelWidth={LW}>
                <NumberInput value={s.editor.fontSize} min={9} max={28} style={{ width: 90 }} onChange={(v) => v !== '' && v >= 9 && v <= 28 && setEditor({ fontSize: v })} />
              </Field>
            </Section>
            <Section title={tr('Bearbeiten', 'Editing')}>
              <Field label={tr('Tabulatorbreite', 'Tab size')} labelWidth={LW}>
                <NumberInput value={s.editor.tabSize} min={1} max={8} style={{ width: 90 }} onChange={(v) => v !== '' && v >= 1 && v <= 8 && setEditor({ tabSize: v })} />
              </Field>
              <Checkbox checked={s.editor.insertSpaces} onChange={(insertSpaces) => setEditor({ insertSpaces })} label={tr('Leerzeichen statt Tabulatoren einfügen', 'Insert spaces instead of tabs')} />
              <Checkbox checked={s.editor.autoCloseBrackets} onChange={(autoCloseBrackets) => setEditor({ autoCloseBrackets })} label={tr('Klammern und Anführungszeichen automatisch schließen', 'Auto close brackets and quotes')} />
              <Checkbox checked={s.editor.wordWrap} onChange={(wordWrap) => setEditor({ wordWrap })} label={tr('Zeilenumbruch', 'Word wrap')} />
            </Section>
            <Section title={tr('Anzeige', 'Display')}>
              <Checkbox checked={s.editor.lineNumbers} onChange={(lineNumbers) => setEditor({ lineNumbers })} label={tr('Zeilennummern', 'Line numbers')} />
              <Checkbox checked={s.editor.highlightLine} onChange={(highlightLine) => setEditor({ highlightLine })} label={tr('Aktuelle Zeile hervorheben', 'Highlight current line')} />
              <Checkbox checked={s.editor.folding} onChange={(folding) => setEditor({ folding })} label={tr('Code-Faltung', 'Code folding')} />
              <Checkbox checked={s.editor.minimap} onChange={(minimap) => setEditor({ minimap })} label={tr('Minimap', 'Minimap')} />
            </Section>
            <Section title={tr('Autovervollständigung', 'Code completion')}>
              <Checkbox checked={s.editor.autoComplete} onChange={(autoComplete) => setEditor({ autoComplete })} label={tr('Vorschläge beim Tippen anzeigen', 'Show suggestions while typing')} />
              <Checkbox
                checked={s.editor.uppercaseKeywords}
                onChange={(uppercaseKeywords) => setEditor({ uppercaseKeywords })}
                label={tr('Schlüsselwörter in Großbuchstaben (Vervollständigung und Formatierung)', 'Upper-case keywords (completion and formatting)')}
              />
            </Section>
            <div className="ks-opt-preview">
              <SqlEditor value={SAMPLE} readOnly />
            </div>
          </div>
        )}

        {page === 'records' && (
          <div className="ks-form">
            <h2>{tr('Datensätze', 'Records')}</h2>
            <Section title={tr('Laden', 'Loading')}>
              <Checkbox checked={s.grid.limitRecords} onChange={(limitRecords) => setGrid({ limitRecords })} label={tr('Datensätze seitenweise laden', 'Load records page by page')} />
              <Field label={tr('Datensätze pro Seite', 'Records per page')} labelWidth={LW}>
                <NumberInput value={s.grid.recordsPerPage} min={10} step={100} style={{ width: 120 }} disabled={!s.grid.limitRecords} onChange={(v) => v !== '' && v >= 10 && setGrid({ recordsPerPage: v })} />
              </Field>
              <Field label={tr('Datensätze zählen', 'Count records')} labelWidth={LW}>
                <Select
                  value={s.grid.countMode}
                  onChange={(countMode) => setGrid({ countMode })}
                  options={[
                    { value: 'exact', label: tr('Exakt (COUNT(*))', 'Exact (COUNT(*))') },
                    { value: 'estimate', label: tr('Schätzung aus Statistik (schneller)', 'Estimate from statistics (faster)') }
                  ]}
                  style={{ width: 280 }}
                />
              </Field>
            </Section>
            <Section title={tr('Bearbeiten', 'Editing')}>
              <Checkbox
                checked={s.grid.autoApply}
                onChange={(autoApply) => setGrid({ autoApply })}
                label={tr('Änderungen beim Verlassen eines Datensatzes automatisch übernehmen', 'Apply changes automatically when leaving a record')}
              />
            </Section>
            <Section title={tr('Darstellung', 'Display')}>
              <Field label={tr('Anzeige für NULL', 'NULL display text')} labelWidth={LW}>
                <TextInput value={s.grid.nullText} style={{ width: 160 }} onChange={(e) => setGrid({ nullText: e.target.value })} />
              </Field>
              <Field label={tr('Schriftgröße', 'Font size')} labelWidth={LW}>
                <NumberInput value={s.grid.fontSize} min={10} max={20} style={{ width: 90 }} onChange={(v) => v !== '' && v >= 10 && v <= 20 && setGrid({ fontSize: v })} />
              </Field>
              <Field label={tr('Zeilenhöhe', 'Row height')} labelWidth={LW}>
                <NumberInput value={s.grid.rowHeight} min={20} max={48} style={{ width: 90 }} onChange={(v) => v !== '' && v >= 20 && v <= 48 && setGrid({ rowHeight: v })} />
              </Field>
              <Checkbox checked={s.grid.showRowNumbers} onChange={(showRowNumbers) => setGrid({ showRowNumbers })} label={tr('Zeilennummern anzeigen', 'Show row numbers')} />
              <Checkbox checked={s.grid.alternateRows} onChange={(alternateRows) => setGrid({ alternateRows })} label={tr('Abwechselnde Zeilenfarben', 'Alternating row colors')} />
            </Section>
          </div>
        )}

        {page === 'query' && (
          <div className="ks-form">
            <h2>{tr('Abfragen', 'Queries')}</h2>
            <Section title={tr('Ausführung', 'Execution')}>
              <Field label={tr('Max. Zeilen pro Ergebnis', 'Max rows per result')} labelWidth={LW} hint={tr('0 = unbegrenzt', '0 = unlimited')}>
                <NumberInput value={s.query.maxRows} min={0} step={1000} style={{ width: 140 }} onChange={(v) => v !== '' && v >= 0 && setQuery({ maxRows: v })} />
              </Field>
              <Checkbox checked={s.query.stopOnError} onChange={(stopOnError) => setQuery({ stopOnError })} label={tr('Beim ersten Fehler anhalten', 'Stop at the first error')} />
              <Checkbox checked={s.query.autoCommit} onChange={(autoCommit) => setQuery({ autoCommit })} label={tr('Auto-Commit für neue Abfragen', 'Auto commit for new queries')} />
              <Checkbox
                checked={s.query.confirmUnsafe}
                onChange={(confirmUnsafe) => setQuery({ confirmUnsafe })}
                label={tr('UPDATE / DELETE ohne WHERE bestätigen lassen', 'Confirm UPDATE / DELETE without WHERE')}
              />
            </Section>
          </div>
        )}

        {page === 'history' && (
          <div className="ks-form">
            <h2>{tr('Verlaufsprotokoll', 'History log')}</h2>
            <Section title={tr('Protokoll', 'Log')}>
              <Checkbox checked={s.historyEnabled} onChange={(historyEnabled) => set({ historyEnabled })} label={tr('Ausgeführte SQL-Anweisungen protokollieren', 'Log executed SQL statements')} />
              <Field label={tr('Maximale Einträge', 'Maximum entries')} labelWidth={LW}>
                <NumberInput value={s.historyMaxEntries} min={100} step={1000} style={{ width: 140 }} onChange={(v) => v !== '' && v >= 100 && set({ historyMaxEntries: v })} />
              </Field>
              <div>
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (!(await confirmDialog({ title: tr('Verlauf leeren', 'Clear history'), message: tr('Das gesamte Verlaufsprotokoll löschen?', 'Delete the complete history log?'), danger: true, okLabel: tr('Leeren', 'Clear') }))) return;
                    await api.history.clear();
                    toast(tr('Verlauf geleert', 'History cleared'), 'success');
                  }}
                >
                  {tr('Verlauf leeren', 'Clear history')}
                </Button>
              </div>
            </Section>
          </div>
        )}

        {page === 'files' && (
          <div className="ks-form">
            <h2>{tr('Dateipfade', 'File locations')}</h2>
            <Section title={tr('Profile, Abfragen, Sicherungen, Modelle', 'Profiles, queries, backups, models')}>
              <Field
                label={tr('Speicherort', 'Location')}
                labelWidth={LW}
                hint={tr('Leer = Standard ({p})', 'Empty = default ({p})', { p: info ? `${info.documentsDir}\\KS Table` : '…' })}
              >
                <PathInput
                  mode="dir"
                  value={s.profilesDir}
                  onChange={(profilesDir) => {
                    set({ profilesDir });
                    window.setTimeout(() => void useWorkspace.getState().load(), 300);
                  }}
                />
              </Field>
              {info && (
                <div>
                  <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void api.app.showItemInFolder(info.profilesDir)}>
                    {tr('Im Explorer öffnen', 'Open in Explorer')}
                  </Button>
                </div>
              )}
            </Section>
            <Section title={tr('Programmdaten', 'Application data')}>
              <Field label={tr('Einstellungen und Verbindungen', 'Settings and connections')} labelWidth={LW}>
                <TextInput value={info?.userDataDir ?? ''} readOnly />
              </Field>
              {info && (
                <div>
                  <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void api.app.showItemInFolder(info.userDataDir)}>
                    {tr('Im Explorer öffnen', 'Open in Explorer')}
                  </Button>
                </div>
              )}
            </Section>
            <Section title={tr('Version', 'Version')}>
              <div className="muted selectable">
                KS Table {info?.version} · Electron {info?.electronVersion || '–'} · Node {info?.nodeVersion}
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
