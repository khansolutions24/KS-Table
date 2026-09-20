// Read-only, highlighted SQL preview of the statements a designer will execute.

import type { ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { tr } from '@shared/i18n';
import { SqlHighlight } from '../../../components/SqlHighlight';
import { toast } from '../../../components/Toast';
import { IconButton } from '../../../components/ui/controls';
import './designer.css';

/** Statements joined into a script (each terminated with ;) */
export function statementsText(statements: string[]): string {
  return statements.map((s) => `${s.trim()};`).join('\n\n');
}

export function SqlPreview({ statements, empty, header }: { statements: string[]; empty?: ReactNode; header?: ReactNode }) {
  const text = statementsText(statements);
  return (
    <div className="ks-dsg-preview">
      {header && <div className="ks-dsg-preview-head">{header}</div>}
      <div className="ks-dsg-preview-body">
        {statements.length ? (
          <>
            <IconButton
              className="ks-dsg-preview-copy"
              icon={<Copy size={14} />}
              title={tr('SQL kopieren', 'Copy SQL')}
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => toast(tr('SQL kopiert', 'SQL copied')));
              }}
            />
            <SqlHighlight sql={text} className="selectable" />
          </>
        ) : (
          <div className="ks-dsg-preview-empty">{empty ?? tr('Keine Änderungen', 'No changes')}</div>
        )}
      </div>
    </div>
  );
}
