// Object colors (tables, notes, layers, relations) and their menu / picker UI.

import clsx from 'clsx';
import { tr } from '@shared/i18n';
import { OBJECT_COLORS } from '@shared/model/util';
import { SEP, type MenuItem } from '../../components/ui/Menu';

export function colorName(c: string): string {
  const names = [
    tr('Blau', 'Blue'),
    tr('Violett', 'Violet'),
    tr('Pink', 'Pink'),
    tr('Rot', 'Red'),
    tr('Orange', 'Orange'),
    tr('Gelb', 'Yellow'),
    tr('Grün', 'Green'),
    tr('Petrol', 'Teal'),
    tr('Cyan', 'Cyan'),
    tr('Grau', 'Gray')
  ];
  const i = OBJECT_COLORS.indexOf(c);
  return i >= 0 ? names[i] : c;
}

export function colorMenuItems(current: string | null, apply: (c: string | null) => void): MenuItem[] {
  return [
    { label: tr('Standardfarbe', 'Default color'), checked: !current, onClick: () => apply(null) },
    SEP,
    ...OBJECT_COLORS.map<MenuItem>((c) => ({
      label: colorName(c),
      checked: current === c,
      icon: <span className="ks-color-dot" style={{ background: c }} />,
      onClick: () => apply(c)
    }))
  ];
}

export function ColorPicker({ value, onChange }: { value: string | null; onChange: (c: string | null) => void }) {
  return (
    <div className="ks-md-colors">
      <button type="button" className={clsx('ks-swatch none', !value && 'active')} title={tr('Standardfarbe', 'Default color')} onClick={() => onChange(null)} />
      {OBJECT_COLORS.map((c) => (
        <button key={c} type="button" className={clsx('ks-swatch', value === c && 'active')} style={{ background: c }} title={colorName(c)} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}
