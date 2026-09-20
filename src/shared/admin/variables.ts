// SET statements for server variables (server monitor).

import type { VariableScope, VariableValueMode } from '../apis/admin';
import { quoteString } from '../sql/quote';

const KEYWORDS = new Set(['ON', 'OFF', 'TRUE', 'FALSE', 'DEFAULT', 'NULL']);

export function isValidVariableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.$]*$/.test(name);
}

/** Value as SQL: numbers and ON/OFF/DEFAULT … unquoted in 'auto' mode, strings quoted */
export function variableValueSql(value: string, mode: VariableValueMode): string {
  const v = value.trim();
  if (mode === 'expression') return v || "''";
  if (mode === 'string') return quoteString(value);
  if (/^-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(v)) return v;
  if (KEYWORDS.has(v.toUpperCase())) return v.toUpperCase();
  return quoteString(value);
}

export function setVariableSql(scope: VariableScope, name: string, value: string, mode: VariableValueMode): string {
  return `SET ${scope} ${name} = ${variableValueSql(value, mode)}`;
}
