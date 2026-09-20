// Monaco setup: web workers, KS themes, SQL formatter. Import `monaco` from here.

import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import { format as formatSqlText } from 'sql-formatter';
import { getSettings } from '../../store/settings';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker();
    return new EditorWorker();
  }
};

monaco.editor.defineTheme('ks-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '1d4ed8', fontStyle: 'bold' },
    { token: 'operator', foreground: '374151' },
    { token: 'predefined', foreground: '7c3aed' },
    { token: 'string', foreground: '15803d' },
    { token: 'number', foreground: 'b45309' },
    { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
    { token: 'identifier.quote', foreground: '7e22ce' }
  ],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#fafbfc',
    'editorLineNumber.foreground': '#a0a7b1',
    'editorLineNumber.activeForeground': '#374151',
    'editor.lineHighlightBackground': '#f4f7fc',
    'editor.selectionBackground': '#cfe0ff',
    'editorIndentGuide.background1': '#eceff3'
  }
});

monaco.editor.defineTheme('ks-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '7aa2f7', fontStyle: 'bold' },
    { token: 'predefined', foreground: 'c099ff' },
    { token: 'string', foreground: '9ece6a' },
    { token: 'number', foreground: 'ff9e64' },
    { token: 'comment', foreground: '6b7389', fontStyle: 'italic' },
    { token: 'identifier.quote', foreground: 'bb9af7' }
  ],
  colors: {
    'editor.background': '#1d2025',
    'editorGutter.background': '#1d2025',
    'editorLineNumber.foreground': '#555b66',
    'editorLineNumber.activeForeground': '#c3c8d0',
    'editor.lineHighlightBackground': '#23272e',
    'editor.selectionBackground': '#2f4470'
  }
});

/** Formats SQL (keyword case / indentation from the editor options). Returns the input on parse errors. */
export function beautifySql(sql: string): string {
  const s = getSettings().editor;
  try {
    return formatSqlText(sql, {
      language: 'mysql',
      keywordCase: s.uppercaseKeywords ? 'upper' : 'preserve',
      tabWidth: s.tabSize,
      useTabs: !s.insertSpaces,
      linesBetweenQueries: 1
    });
  } catch {
    return sql;
  }
}

/** Removes comments and collapses whitespace outside of strings / identifiers. */
export function minifySql(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  let pendingSpace = false;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && sql[j] !== c) {
        if (sql[j] === '\\' && c !== '`') j++;
        j++;
      }
      if (pendingSpace && out) out += ' ';
      pendingSpace = false;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if ((c === '-' && sql[i + 1] === '-') || c === '#') {
      while (i < n && sql[i] !== '\n') i++;
      pendingSpace = true;
    } else if (c === '/' && sql[i + 1] === '*' && sql[i + 2] !== '!') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      pendingSpace = true;
    } else if (/\s/.test(c)) {
      pendingSpace = true;
      i++;
    } else {
      if (pendingSpace && out && !/[(,;]$/.test(out) && !/[),;]/.test(c)) out += ' ';
      pendingSpace = false;
      out += c;
      i++;
    }
  }
  return out.trim();
}

monaco.languages.registerDocumentFormattingEditProvider('mysql', {
  provideDocumentFormattingEdits: (model) => [{ range: model.getFullModelRange(), text: beautifySql(model.getValue()) }]
});

monaco.languages.registerDocumentRangeFormattingEditProvider('mysql', {
  provideDocumentRangeFormattingEdits: (model, range) => [{ range, text: beautifySql(model.getValueInRange(range)) }]
});

export { monaco };
