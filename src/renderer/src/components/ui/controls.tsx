// Basic form controls and toolbar pieces.

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from 'react';
import clsx from 'clsx';
import { ChevronDown, Search, X } from 'lucide-react';
import { tr } from '@shared/i18n';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'link';
  size?: 'sm' | 'md';
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, className, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx('ks-btn', `ks-btn-${variant}`, size === 'sm' && 'ks-btn-sm', !children && 'icon-only', className)}
      {...rest}
    >
      {icon}
      {children !== undefined && children !== null && children !== false && <span>{children}</span>}
    </button>
  );
});

export function IconButton({
  icon,
  title,
  active,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: ReactNode; active?: boolean }) {
  return (
    <button type="button" title={title} className={clsx('ks-icon-btn', active && 'active', className)} {...rest}>
      {icon}
    </button>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function TextInput({ className, invalid, ...rest }, ref) {
    return <input ref={ref} className={clsx('ks-input', invalid && 'invalid', className)} spellCheck={false} {...rest} />;
  }
);

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  className,
  style,
  disabled
}: {
  value: number | '';
  onChange: (v: number | '') => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      className={clsx('ks-input', className)}
      style={style}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
    />
  );
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...rest },
  ref
) {
  return <textarea ref={ref} className={clsx('ks-input ks-textarea', className)} spellCheck={false} {...rest} />;
});

export type SelectOption<T extends string> = T | { value: T; label: string; disabled?: boolean };

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  style,
  disabled,
  title
}: {
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <select
      className={clsx('ks-input ks-select', className)}
      style={style}
      value={value}
      disabled={disabled}
      title={title}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) =>
        typeof o === 'string' ? (
          <option key={o} value={o}>
            {o}
          </option>
        ) : (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        )
      )}
    </select>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  indeterminate,
  title,
  className
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <label className={clsx('ks-check', disabled && 'disabled', className)} title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = !!indeterminate;
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label !== undefined && <span>{label}</span>}
    </label>
  );
}

export function RadioGroup<T extends string>({
  value,
  onChange,
  options,
  disabled,
  inline
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  disabled?: boolean;
  inline?: boolean;
}) {
  return (
    <div className={clsx('ks-radio-group', inline && 'inline')}>
      {options.map((o) => (
        <label key={o.value} className={clsx('ks-check', (disabled || o.disabled) && 'disabled')}>
          <input
            type="radio"
            checked={value === o.value}
            disabled={disabled || o.disabled}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** Label + control row (label column width via --label-w). */
export function Field({
  label,
  children,
  hint,
  labelWidth,
  className,
  alignTop
}: {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  labelWidth?: number;
  className?: string;
  alignTop?: boolean;
}) {
  return (
    <div
      className={clsx('ks-field', alignTop && 'align-top', className)}
      style={labelWidth ? ({ '--label-w': `${labelWidth}px` } as CSSProperties) : undefined}
    >
      <label className="ks-field-label">{label}</label>
      <div className="ks-field-control">
        {children}
        {hint && <div className="ks-field-hint">{hint}</div>}
      </div>
    </div>
  );
}

/** Titled group box */
export function Section({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <fieldset className={clsx('ks-section', className)}>
      {title && <legend>{title}</legend>}
      {children}
    </fieldset>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  hidden?: boolean;
}

export function TabStrip<T extends string>({
  tabs,
  value,
  onChange,
  className,
  right
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <div className={clsx('ks-tabstrip', className)} role="tablist">
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className={clsx('ks-tab', value === t.id && 'active')}
            onClick={() => onChange(t.id)}
          >
            {t.icon}
            <span>{t.label}</span>
            {t.badge !== undefined && <span className="ks-tab-badge">{t.badge}</span>}
          </button>
        ))}
      {right && <div className="ks-tabstrip-right">{right}</div>}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="ks-spinner" style={{ width: size, height: size }} />;
}

export function ProgressBar({ value, className }: { value: number | null; className?: string }) {
  return (
    <div className={clsx('ks-progress', value === null && 'indeterminate', className)}>
      <div className="ks-progress-bar" style={value === null ? undefined : { width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('ks-toolbar', className)}>{children}</div>;
}

export function ToolbarButton({
  icon,
  label,
  onClick,
  disabled,
  active,
  title,
  dropdown,
  stacked,
  className,
  onDropdown
}: {
  icon?: ReactNode;
  label?: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
  dropdown?: boolean;
  stacked?: boolean;
  className?: string;
  onDropdown?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={clsx('ks-tb-btn', stacked ? 'stacked' : 'inline', active && 'active', className)}
      disabled={disabled}
      onClick={(e) => {
        if (onDropdown && (e.target as HTMLElement).closest('.ks-tb-caret')) onDropdown(e);
        else onClick?.(e);
      }}
      title={title ?? (typeof label === 'string' ? label : undefined)}
    >
      {icon}
      {label !== undefined && <span className="ks-tb-label">{label}</span>}
      {(dropdown || onDropdown) && <ChevronDown size={12} className="ks-tb-caret" />}
    </button>
  );
}

export function ToolbarSep() {
  return <div className="ks-tb-sep" />;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
  onKeyDown
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className={clsx('ks-search', className)}>
      <Search size={14} className="ks-search-icon" />
      <input
        value={value}
        placeholder={placeholder ?? tr('Suchen', 'Search')}
        spellCheck={false}
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
          onKeyDown?.(e);
        }}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button type="button" className="ks-search-clear" onClick={() => onChange('')} title={tr('Leeren', 'Clear')}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="ks-empty">
      {icon && <div className="ks-empty-icon">{icon}</div>}
      <div className="ks-empty-title">{title}</div>
      {children && <div className="ks-empty-body">{children}</div>}
    </div>
  );
}

export const CONNECTION_COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#8d8d8d'];

export function ColorSwatches({ value, onChange }: { value: string | null; onChange: (c: string | null) => void }) {
  return (
    <div className="ks-swatches">
      <button
        type="button"
        className={clsx('ks-swatch none', !value && 'active')}
        title={tr('Keine Farbe', 'No color')}
        onClick={() => onChange(null)}
      />
      {CONNECTION_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={clsx('ks-swatch', value === c && 'active')}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}
