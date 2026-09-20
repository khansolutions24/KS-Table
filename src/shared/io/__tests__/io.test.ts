import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../sql/splitter';
import { SqlStreamSplitter, type StreamStatement } from '../sqlStream';
import { DelimitedParser, FIELD_NULL, FIELD_QUOTED, parseDelimited, type DelimitedOptions, type DelimitedRecord } from '../delimited';
import { JsonRecordScanner, parseJsonRecord, scanJsonRecords } from '../jsonStream';
import { decodeXmlName, encodeXmlName, readXmlRecords, XmlRecordReader, type XmlRecord } from '../xmlStream';
import { formatNumberText, formatTemporalText, normalizeNumber, parseUserTemporal } from '../datetime';

function feedChunks(text: string, sizes: (i: number) => number): StreamStatement[] {
  const s = new SqlStreamSplitter();
  const out: StreamStatement[] = [];
  let p = 0;
  let k = 0;
  while (p < text.length) {
    const n = Math.max(1, sizes(k++));
    out.push(...s.feed(text.slice(p, p + n)));
    p += n;
  }
  out.push(...s.end());
  return out;
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

const SCRIPTS: string[] = [
  'SELECT 1; SELECT 2;\nSELECT 3',
  "INSERT INTO t VALUES ('a;b', \"c;d\", `e;f`), ('it''s', 'x\\'y', 'back\\\\');\nSELECT 'end'",
  '-- comment ; here\n# hash ; comment\n/* block ; */ SELECT 1 /* inner ; */ ;\n/*!40101 SET NAMES utf8mb4 */;\n/*+ hint */ SELECT 2;',
  `CREATE PROCEDURE p(IN x INT)
BEGIN
  DECLARE v INT DEFAULT 0;
  IF x > 0 THEN
    SET v = IF(x > 10, 1, 2);
  ELSEIF x < 0 THEN
    SET v = -1;
  END IF;
  WHILE v < 3 DO SET v = v + 1; END WHILE;
  CASE v WHEN 1 THEN SELECT 'one'; ELSE SELECT 'other'; END CASE;
  lbl: LOOP LEAVE lbl; END LOOP lbl;
  REPEAT SET v = v - 1; UNTIL v <= 0 END REPEAT;
END;
SELECT 'after';`,
  `DELIMITER ;;
CREATE TRIGGER t1 BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END ;;
DELIMITER ;
SELECT 1;
DELIMITER $$
CREATE FUNCTION f() RETURNS INT BEGIN RETURN 1; END$$
DELIMITER ;
SELECT 2;`,
  'BEGIN NOT ATOMIC\n  SELECT 1;\n  SELECT 2;\nEND;\nSELECT 3;',
  'BEGIN;\nUPDATE t SET a = 1;\nCOMMIT;',
  `INSERT INTO b VALUES (0x${'AB'.repeat(300)}, X'${'cd'.repeat(200)}');\r\nSELECT 'crlf';\r\n`,
  'CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN\n  DELETE FROM a WHERE x < NOW() - INTERVAL 90 DAY;\n  END;\nSELECT 1',
  'SELECT 1;;; ;SELECT 2\n;\n  \n-- trailing comment',
  'SELECT "unterminated ; string',
  'SELECT 1 -- ok\n; SELECT 2 --\n;SELECT 3 #x\n;',
  `CREATE DEFINER=\`root\`@\`localhost\` TRIGGER \`trg\` AFTER UPDATE ON \`products\` FOR EACH ROW BEGIN
  IF NOT (OLD.price <=> NEW.price) THEN
    INSERT INTO audit_log (a) VALUES (JSON_OBJECT('old', OLD.price));
  END IF;
END;
DROP TABLE IF EXISTS x;`,
  'delimiter //\nSELECT 1//\nSELECT 2 //\ndelimiter ;\nSELECT 3;'
];

describe('SqlStreamSplitter', () => {
  it('matches splitStatements for every script and chunking', () => {
    for (const text of SCRIPTS) {
      const expected = splitStatements(text).map((s) => ({ sql: s.sql, delimiter: s.delimiter, offset: s.start, line: lineOf(text, s.start) }));
      const check = (got: StreamStatement[], label: string) => {
        expect(got.map((s) => ({ sql: s.sql, delimiter: s.delimiter, offset: s.offset, line: s.line })), `${label}: ${text.slice(0, 40)}`).toEqual(expected);
      };
      check(feedChunks(text, () => text.length), 'whole');
      check(feedChunks(text, () => 1), 'single chars');
      for (const size of [2, 3, 5, 7, 13]) check(feedChunks(text, () => size), `size ${size}`);
      let seed = 7;
      const rnd = () => {
        seed = (seed * 16807) % 2147483647;
        return seed;
      };
      for (let r = 0; r < 20; r++) check(feedChunks(text, () => (rnd() % 17) + 1), `random ${r}`);
      // every two-chunk split position
      for (let cut = 1; cut < text.length; cut++) {
        const s = new SqlStreamSplitter();
        const got = [...s.feed(text.slice(0, cut)), ...s.feed(text.slice(cut)), ...s.end()];
        check(got, `cut ${cut}`);
      }
    }
  });
});

const CSV: DelimitedOptions = { fieldDelimiter: ',', recordDelimiter: 'auto', qualifier: '"', escapeChar: '' };

function chunked(text: string, o: DelimitedOptions, size: number): DelimitedRecord[] {
  const out: DelimitedRecord[] = [];
  const p = new DelimitedParser(o);
  for (let i = 0; i < text.length; i += size) p.feed(text.slice(i, i + size), (r) => void out.push(r));
  p.end((r) => void out.push(r));
  return out;
}

describe('DelimitedParser', () => {
  const text = 'id,name,note\r\n1,"Müller, Hans","He said ""hi""\nnext line"\r\n2,,""\r\n\r\n3, "quoted after blank" ,x\n4,😀,end';
  it('parses quotes, quoted newlines, empty values', () => {
    const r = parseDelimited(text, CSV);
    expect(r.map((x) => x.values)).toEqual([
      ['id', 'name', 'note'],
      ['1', 'Müller, Hans', 'He said "hi"\nnext line'],
      ['2', '', ''],
      ['3', 'quoted after blank', 'x'],
      ['4', '😀', 'end']
    ]);
    expect(r[2].kinds).toEqual([0, 0, FIELD_QUOTED]);
    expect(r.map((x) => x.no)).toEqual([1, 2, 3, 5, 6]);
  });
  it('gives the same result for any chunk size', () => {
    const whole = parseDelimited(text, CSV);
    for (const size of [1, 2, 3, 4, 7]) expect(chunked(text, CSV, size)).toEqual(whole);
  });
  it('supports multi character delimiters, escapes and \\N', () => {
    const o: DelimitedOptions = { fieldDelimiter: '||', recordDelimiter: 'lf', qualifier: '', escapeChar: '\\' };
    const t = 'a||b\\|||c||\\N\nx\\ny||\\\\||z\r';
    for (const size of [1, 2, 3, 50]) {
      const r = chunked(t, o, size);
      expect(r[0].values).toEqual(['a', 'b|', 'c', 'N']);
      expect(r[0].kinds[3]).toBe(FIELD_NULL);
      expect(r[1].values).toEqual(['x\ny', '\\', 'z\r']);
    }
  });
});

describe('JSON records', () => {
  it('reads arrays, JSON lines and wrapped arrays in any chunking', () => {
    const arr = '[{"a":1,"b":"x"},{"a":2.50,"b":null,"c":{"n":[1,2]}}, [1,"z"], "s"]';
    const lines = '{"a":1}\n{"a":2,"items":[{"x":1}]}\n';
    const wrapped = '{"meta":{"v":1},"RECORDS":[{"a":1},{"a":2}],"after":[{"no":1}]}';
    const cases: [string, string[]][] = [
      [arr, ['{"a":1,"b":"x"}', '{"a":2.50,"b":null,"c":{"n":[1,2]}}', '[1,"z"]', '"s"']],
      [lines, ['{"a":1}', '{"a":2,"items":[{"x":1}]}']],
      [wrapped, ['{"a":1}', '{"a":2}']]
    ];
    for (const [text, expected] of cases) {
      expect(scanJsonRecords(text)).toEqual(expected);
      for (const size of [1, 2, 5]) {
        const out: string[] = [];
        const s = new JsonRecordScanner();
        for (let i = 0; i < text.length; i += size) s.feed(text.slice(i, i + size), (r) => void out.push(r));
        s.end((r) => void out.push(r));
        expect(out).toEqual(expected);
      }
    }
  });
  it('parses record values keeping raw numbers and nested JSON', () => {
    const r = parseJsonRecord('{"id": 12345678901234567890, "p": 1.10, "t": true, "s": "a\\"b\\u00e4\\ud83d\\ude00", "n": null, "o": {"x": [1, {"y": "}"}]}}');
    expect(r.names).toEqual(['id', 'p', 't', 's', 'n', 'o']);
    expect(r.values).toEqual([{ raw: '12345678901234567890' }, { raw: '1.10' }, { raw: 'true' }, 'a"bä😀', null, { raw: '{"x": [1, {"y": "}"}]}' }]);
  });
});

describe('XML records', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE records [ <!ELEMENT records ANY> ]>
<!-- comment <record> -->
<records xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <record id="1"><name>M&amp;üller &#x1F600;</name><note xsi:nil="true"/><empty></empty><addr><city>Köln</city><zip>50667</zip></addr><_x0031_col>v</_x0031_col></record>
  <record id="2"><name><![CDATA[a < b & c]]></name><tag>x</tag><tag>y</tag><line>a\r\nb</line></record>
  <record id="3" note="multi&#10;line"/>
</records>`;
  it('extracts fields, NULLs and nested elements', () => {
    const r = readXmlRecords(xml, { rowTag: 'record', attributes: true });
    expect(r.length).toBe(3);
    expect(r[0]).toEqual({ names: ['id', 'name', 'note', 'empty', 'addr.city', 'addr.zip', '1col'], values: ['1', 'M&üller 😀', null, '', 'Köln', '50667', 'v'] });
    expect(r[1]).toEqual({ names: ['id', 'name', 'tag', 'line'], values: ['2', 'a < b & c', 'x, y', 'a\nb'] });
    expect(r[2]).toEqual({ names: ['id', 'note'], values: ['3', 'multi\nline'] });
  });
  it('is independent of chunking', () => {
    const whole = readXmlRecords(xml, { rowTag: 'record', attributes: true });
    for (const size of [1, 2, 3, 8]) {
      const out: XmlRecord[] = [];
      const rd = new XmlRecordReader({ rowTag: 'record', attributes: true });
      for (let i = 0; i < xml.length; i += size) rd.feed(xml.slice(i, i + size), (x) => void out.push(x));
      rd.end((x) => void out.push(x));
      expect(out).toEqual(whole);
    }
  });
  it('round-trips encoded element names', () => {
    for (const n of ['id', 'first name', '1st', 'a:b', 'ü_x0020_y', 'xmlns', '😀']) expect(decodeXmlName(encodeXmlName(n))).toBe(n);
  });
});

describe('dates and numbers', () => {
  const o = { dateOrder: 'DMY' as const, dateSeparator: '.', timeSeparator: ':' };
  it('parses user dates', () => {
    expect(parseUserTemporal('05.01.2024', 'date', o)).toBe('2024-01-05');
    expect(parseUserTemporal('5.1.24 7:03', 'datetime', o)).toBe('2024-01-05 07:03:00');
    expect(parseUserTemporal('2024-01-05T10:20:30.123Z', 'datetime', o)).toBe('2024-01-05 10:20:30.123');
    expect(parseUserTemporal('05.01.2024 10:20:30', 'time', o)).toBe('10:20:30');
    expect(parseUserTemporal('3. März 2023', 'date', o)).toBe('2023-03-03');
    expect(parseUserTemporal('01/05/2024 1:30 PM', 'datetime', { dateOrder: 'MDY', dateSeparator: '/', timeSeparator: ':' })).toBe('2024-01-05 13:30:00');
    expect(parseUserTemporal('20240105', 'date', { dateOrder: 'YMD', dateSeparator: '-', timeSeparator: ':' })).toBe('2024-01-05');
    expect(parseUserTemporal('31.13.2024', 'date', o)).toBeNull();
    expect(parseUserTemporal('abc', 'date', o)).toBeNull();
  });
  it('formats MySQL values', () => {
    expect(formatTemporalText('2024-01-05 07:03:09.500000', 'datetime', 'DD.MM.YYYY', 'HH:mm:ss')).toBe('05.01.2024 07:03:09.500000');
    expect(formatTemporalText('2024-01-05 17:03:09', 'datetime', 'M/D/YY', 'h:mm A')).toBe('1/5/24 5:03 PM');
    expect(formatTemporalText('-838:59:59', 'time', 'YYYY', 'HH:mm:ss')).toBe('-838:59:59');
    expect(formatTemporalText('0000-00-00', 'date', 'DD.MM.YYYY', '')).toBe('00.00.0000');
  });
  it('normalises and formats numbers', () => {
    expect(normalizeNumber('1.234,56', ',')).toBe('1234.56');
    expect(normalizeNumber('-0,5', ',')).toBe('-0.5');
    expect(normalizeNumber('1,234.5', '.')).toBe('1234.5');
    expect(normalizeNumber('1e-7', '.')).toBe('1e-7');
    expect(normalizeNumber('12a', '.')).toBeNull();
    expect(formatNumberText('-1234567.50', ',', '.')).toBe('-1.234.567,50');
    expect(formatNumberText('1e+30', ',', '')).toBe('1e+30');
  });
});
