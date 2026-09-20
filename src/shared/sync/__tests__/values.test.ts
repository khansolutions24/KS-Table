import { describe, expect, it } from 'vitest';
import {
  canonicalDecimal,
  canonicalTemporal,
  canonicalValue,
  compareDecimal,
  compareMergeKeys,
  compareMergeValue,
  keyPartNormalizer,
  keyString,
  mergeClass,
  sqlLiteral,
  valueClass,
  valuesEqual
} from '../values';

describe('decimal helpers', () => {
  it('canonicalizes', () => {
    expect(canonicalDecimal('0012.3400')).toBe('12.34');
    expect(canonicalDecimal('-0.000')).toBe('0');
    expect(canonicalDecimal('.5')).toBe('0.5');
    expect(canonicalDecimal('+7.')).toBe('7');
    expect(canonicalDecimal('-0.000001')).toBe('-0.000001');
  });
  it('compares', () => {
    expect(compareDecimal('12.5', '12.50')).toBe(0);
    expect(compareDecimal('9.99', '10')).toBe(-1);
    expect(compareDecimal('-1', '-2')).toBe(1);
    expect(compareDecimal('-0.5', '0.1')).toBe(-1);
    expect(compareDecimal('12345678901234.123456', '12345678901234.123457')).toBe(-1);
  });
});

describe('canonical values', () => {
  it('handles temporal fractions', () => {
    expect(canonicalTemporal('2026-09-13 17:45:12.123000')).toBe('2026-09-13 17:45:12.123');
    expect(canonicalTemporal('1000-01-01 00:00:00.000000')).toBe('1000-01-01 00:00:00');
    expect(canonicalTemporal('-838:59:59.000')).toBe('-838:59:59');
    expect(canonicalTemporal('2026-09-13')).toBe('2026-09-13');
  });
  it('treats equal numbers of different representation as equal', () => {
    expect(valuesEqual('5', '5.00', 'int', 'dec')).toBe(true);
    expect(valuesEqual(3.14159, '3.14159', 'float')).toBe(true);
    expect(valuesEqual('18446744073709551615', '18446744073709551615', 'int')).toBe(true);
    expect(valuesEqual('abc', 'ABC', 'str')).toBe(false);
    expect(valuesEqual(null, null, 'str')).toBe(true);
    expect(valuesEqual(null, '', 'str')).toBe(false);
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]), 'bin')).toBe(true);
    expect(valuesEqual(new Uint8Array([0, 1]), new Uint8Array([1]), 'bit')).toBe(true);
    expect(canonicalValue(new Uint8Array([0xaa]), 'geo')).toBe('x:AA');
  });
});

describe('merge ordering', () => {
  it('classifies key types', () => {
    expect(mergeClass('bigint')).toBe('int');
    expect(mergeClass('varchar')).toBeNull();
    expect(mergeClass('enum')).toBeNull();
    expect(mergeClass('float')).toBeNull();
    expect(mergeClass('varbinary')).toBe('bin');
    expect(valueClass('timestamp')).toBe('datetime');
  });
  it('orders like the server', () => {
    expect(compareMergeValue('9', 10, 'int')).toBe(-1);
    expect(compareMergeValue('18446744073709551615', '18446744073709551614', 'int')).toBe(1);
    expect(compareMergeValue('2024-01-01 10:00:00', '2024-01-01 10:00:00.5', 'datetime')).toBe(-1);
    expect(compareMergeValue('-838:59:59.000', '00:00:00', 'time')).toBe(-1);
    expect(compareMergeValue('100:00:00', '99:59:59', 'time')).toBe(1);
    expect(compareMergeValue(new Uint8Array([1]), new Uint8Array([1, 0]), 'bin')).toBe(-1);
    expect(compareMergeKeys([1, 2], [1, 3], ['int', 'int'])).toBe(-1);
    expect(compareMergeKeys([2, 1], [1, 3], ['int', 'int'])).toBe(1);
  });
});

describe('key normalization', () => {
  it('follows collation rules', () => {
    const ai = keyPartNormalizer('varchar', 'utf8mb4_0900_ai_ci');
    expect(ai('Müller')).toBe(ai('MULLER'));
    expect(ai('a ')).not.toBe(ai('a'));
    const general = keyPartNormalizer('varchar', 'utf8mb4_general_ci');
    expect(general('a ')).toBe(general('A'));
    const bin = keyPartNormalizer('varchar', 'utf8mb4_bin');
    expect(bin('a')).not.toBe(bin('A'));
    const asci = keyPartNormalizer('varchar', 'utf8mb4_0900_as_ci');
    expect(asci('ä')).not.toBe(asci('a'));
    expect(asci('Ä')).toBe(asci('ä'));
    const num = keyPartNormalizer('decimal', null);
    expect(num('1.50')).toBe(num('1.5'));
  });
  it('builds stable key strings', () => {
    expect(keyString(['1', null, new Uint8Array([255])])).toBe('["1",null,{"x":"FF"}]');
  });
});

describe('sqlLiteral', () => {
  it('formats values', () => {
    expect(sqlLiteral(null, 'str')).toBe('NULL');
    expect(sqlLiteral('12.50', 'dec')).toBe('12.50');
    expect(sqlLiteral('12a', 'dec')).toBe("'12a'");
    expect(sqlLiteral("it's", 'str')).toBe("'it\\'s'");
    expect(sqlLiteral(new Uint8Array([1, 171]), 'bin')).toBe("X'01AB'");
    expect(sqlLiteral(1e300, 'float')).toBe('1e+300');
    expect(sqlLiteral('42', 'str')).toBe("'42'");
  });
});
