import type { FileFilter } from '@shared/api';
import { tr } from '@shared/i18n';
import { FolderOpen } from 'lucide-react';
import { pickDirectory, pickOpenFile, pickSaveFile } from '../../lib/files';
import { TextInput } from './controls';

export function PathInput({
  value,
  onChange,
  mode = 'open',
  filters,
  placeholder,
  title,
  disabled
}: {
  value: string;
  onChange: (v: string) => void;
  mode?: 'open' | 'save' | 'dir';
  filters?: FileFilter[];
  placeholder?: string;
  title?: string;
  disabled?: boolean;
}) {
  const browse = async () => {
    const p =
      mode === 'dir'
        ? await pickDirectory({ title, defaultPath: value || undefined })
        : mode === 'save'
          ? await pickSaveFile({ title, defaultPath: value || undefined, filters })
          : await pickOpenFile({ title, defaultPath: value || undefined, filters });
    if (p) onChange(p);
  };
  return (
    <div className="ks-path-input">
      <TextInput value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="ks-btn ks-btn-default icon-only" disabled={disabled} onClick={browse} title={tr('Durchsuchen …', 'Browse …')}>
        <FolderOpen size={15} />
      </button>
    </div>
  );
}
