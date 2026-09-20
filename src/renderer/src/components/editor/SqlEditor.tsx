// Monaco based SQL editor component (used by query editor, designers, console, …).

import { useEffect, useRef, type CSSProperties } from 'react';
import clsx from 'clsx';
import { useResolvedTheme } from '../../lib/theme';
import { useSettings } from '../../store/settings';
import { registerSqlCompletion, setCompletionContext, type CompletionContext } from './completion';
import { monaco } from './monaco';

export type MonacoEditor = monaco.editor.IStandaloneCodeEditor;

export interface SqlEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: 'mysql' | 'json' | 'plaintext' | 'xml' | 'html';
  readOnly?: boolean;
  /** Connection / database used for code completion */
  completion?: CompletionContext | null;
  onMount?: (editor: MonacoEditor, m: typeof monaco) => void;
  options?: monaco.editor.IStandaloneEditorConstructionOptions;
  className?: string;
  style?: CSSProperties;
}

export function SqlEditor({ value, onChange, language = 'mysql', readOnly, completion, onMount, options, className, style }: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const theme = useResolvedTheme();
  const es = useSettings((s) => s.settings.editor);

  useEffect(() => {
    registerSqlCompletion();
    const ed = monaco.editor.create(host.current!, {
      value,
      language,
      theme: theme === 'dark' ? 'ks-dark' : 'ks-light',
      automaticLayout: true,
      fixedOverflowWidgets: true,
      scrollBeyondLastLine: false,
      readOnly,
      fontFamily: es.fontFamily,
      fontSize: es.fontSize,
      tabSize: es.tabSize,
      insertSpaces: es.insertSpaces,
      wordWrap: es.wordWrap ? 'on' : 'off',
      lineNumbers: es.lineNumbers ? 'on' : 'off',
      minimap: { enabled: es.minimap },
      folding: es.folding,
      renderLineHighlight: es.highlightLine ? 'line' : 'none',
      quickSuggestions: es.autoComplete ? { other: true, comments: false, strings: false } : false,
      suggestOnTriggerCharacters: es.autoComplete,
      autoClosingBrackets: es.autoCloseBrackets ? 'always' : 'never',
      autoClosingQuotes: es.autoCloseBrackets ? 'always' : 'never',
      padding: { top: 6, bottom: 6 },
      smoothScrolling: true,
      mouseWheelZoom: true,
      contextmenu: true,
      scrollbar: { verticalScrollbarSize: 11, horizontalScrollbarSize: 11 },
      ...options
    });
    editorRef.current = ed;
    const sub = ed.onDidChangeModelContent(() => onChangeRef.current?.(ed.getValue()));
    onMount?.(ed, monaco);
    return () => {
      const uri = ed.getModel()?.uri.toString();
      if (uri) setCompletionContext(uri, null);
      sub.dispose();
      ed.getModel()?.dispose();
      ed.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'ks-dark' : 'ks-light');
  }, [theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: es.fontFamily,
      fontSize: es.fontSize,
      tabSize: es.tabSize,
      insertSpaces: es.insertSpaces,
      wordWrap: es.wordWrap ? 'on' : 'off',
      lineNumbers: es.lineNumbers ? 'on' : 'off',
      minimap: { enabled: es.minimap },
      folding: es.folding,
      renderLineHighlight: es.highlightLine ? 'line' : 'none',
      quickSuggestions: es.autoComplete ? { other: true, comments: false, strings: false } : false
    });
  }, [es]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  // external value changes (keeps undo history)
  useEffect(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model || model.getValue() === value) return;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
  }, [value]);

  useEffect(() => {
    const uri = editorRef.current?.getModel()?.uri.toString();
    if (uri) setCompletionContext(uri, completion ?? null);
  }, [completion?.connectionId, completion?.database]);

  return <div ref={host} className={clsx('ks-sql-editor', className)} style={style} />;
}

/** Insert text at the cursor (replacing the selection) */
export function insertAtCursor(ed: MonacoEditor, text: string): void {
  const sel = ed.getSelection();
  if (!sel) return;
  ed.executeEdits('ks', [{ range: sel, text, forceMoveMarkers: true }]);
  ed.focus();
}

export { monaco };
