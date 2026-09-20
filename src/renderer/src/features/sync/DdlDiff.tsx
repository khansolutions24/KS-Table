// Side by side DDL comparison (Monaco diff editor, read-only).

import { useEffect, useRef } from 'react';
import { monaco } from '../../components/editor/monaco';
import { useResolvedTheme } from '../../lib/theme';
import { useSettings } from '../../store/settings';

export function DdlDiff({ original, modified }: { original: string; modified: string }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const models = useRef<{ a: monaco.editor.ITextModel; b: monaco.editor.ITextModel } | null>(null);
  const theme = useResolvedTheme();
  const es = useSettings((s) => s.settings.editor);

  useEffect(() => {
    const ed = monaco.editor.createDiffEditor(host.current!, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
      ignoreTrimWhitespace: false,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      fontFamily: es.fontFamily,
      fontSize: es.fontSize,
      wordWrap: 'on',
      diffWordWrap: 'on',
      renderOverviewRuler: false,
      theme: theme === 'dark' ? 'ks-dark' : 'ks-light'
    });
    const a = monaco.editor.createModel(original, 'mysql');
    const b = monaco.editor.createModel(modified, 'mysql');
    ed.setModel({ original: a, modified: b });
    editor.current = ed;
    models.current = { a, b };
    return () => {
      ed.dispose();
      a.dispose();
      b.dispose();
      editor.current = null;
      models.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = models.current;
    if (!m) return;
    if (m.a.getValue() !== original) m.a.setValue(original);
    if (m.b.getValue() !== modified) m.b.setValue(modified);
  }, [original, modified]);

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'ks-dark' : 'ks-light');
  }, [theme]);

  useEffect(() => {
    editor.current?.updateOptions({ fontFamily: es.fontFamily, fontSize: es.fontSize });
  }, [es.fontFamily, es.fontSize]);

  return <div ref={host} className="ks-sync-diff" />;
}
