// Lightweight SQL syntax highlighting for read-only display (DDL preview, history, messages).

import { useMemo } from 'react';

const KEYWORDS = new Set(
  (
    'ADD ALL ALTER ALGORITHM AND ANY AS ASC AUTO_INCREMENT BEFORE AFTER BEGIN BETWEEN BINARY BY CALL CASCADE CASE CHANGE CHARACTER CHARSET CHECK ' +
    'COLLATE COLUMN COMMENT COMMIT COMPLETION CONSTRAINT CREATE CROSS CURRENT_TIMESTAMP DATABASE DECLARE DEFAULT DEFINER DELETE DELIMITER DESC ' +
    'DETERMINISTIC DISABLE DISTINCT DO DROP EACH ELSE ELSEIF ENABLE END ENGINE ENFORCED EVENT EVERY EXISTS FOR FOREIGN FROM FULL FULLTEXT FUNCTION ' +
    'GENERATED GRANT GROUP HAVING IF IGNORE IN INDEX INNER INSERT INTERVAL INTO INVOKER IS JOIN KEY KEYS LEFT LIKE LIMIT LOOP MODIFIES NO NOT NULL ' +
    'ON OR ORDER OUTER PARTITION PRESERVE PRIMARY PROCEDURE READS REFERENCES RENAME REPEAT REPLACE RESTRICT RETURN RETURNS REVOKE RIGHT ROLLBACK ' +
    'ROW_FORMAT SCHEDULE SECURITY SELECT SET SIGNAL SPATIAL SQL SQLSTATE STARTS STORED TABLE TEMPORARY THEN TO TRIGGER TRUNCATE UNION UNIQUE UNSIGNED ' +
    'UPDATE USE USING VALUES VIEW VIRTUAL WHEN WHERE WHILE WITH ZEROFILL CASCADED LOCAL OPTION MERGE TEMPTABLE UNDEFINED DATA CONTAINS ' +
    'READ WRITE LOCK UNLOCK SHOW DESCRIBE EXPLAIN ANALYZE OPTIMIZE REPAIR ENDS AT ON UPDATE NOW'
  ).split(' ')
);

const TYPES = new Set(
  (
    'TINYINT SMALLINT MEDIUMINT INT INTEGER BIGINT DECIMAL NUMERIC FLOAT DOUBLE REAL BIT BOOL BOOLEAN DATE DATETIME TIMESTAMP TIME YEAR CHAR VARCHAR ' +
    'BINARY VARBINARY TINYTEXT TEXT MEDIUMTEXT LONGTEXT TINYBLOB BLOB MEDIUMBLOB LONGBLOB ENUM JSON GEOMETRY POINT LINESTRING POLYGON MULTIPOINT ' +
    'MULTILINESTRING MULTIPOLYGON GEOMETRYCOLLECTION GEOMCOLLECTION SERIAL'
  ).split(' ')
);

type Tok = { t: 'kw' | 'type' | 'str' | 'num' | 'cmt' | 'id' | 'txt' | 'var'; v: string };

export function tokenizeSql(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-' || c === '#') {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? n : e;
      out.push({ t: 'cmt', v: sql.slice(i, end) });
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      out.push({ t: 'cmt', v: sql.slice(i, end) });
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && sql[j] !== c) {
        if (sql[j] === '\\') j++;
        j++;
      }
      out.push({ t: 'str', v: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '`') {
      const e = sql.indexOf('`', i + 1);
      const end = e < 0 ? n : e + 1;
      out.push({ t: 'id', v: sql.slice(i, end) });
      i = end;
    } else if (c === '@') {
      let j = i + 1;
      while (j < n && /[\w@.$]/.test(sql[j])) j++;
      out.push({ t: 'var', v: sql.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.eExXa-fA-F]/.test(sql[j])) j++;
      out.push({ t: 'num', v: sql.slice(i, j) });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(sql[j])) j++;
      const w = sql.slice(i, j);
      const up = w.toUpperCase();
      out.push({ t: KEYWORDS.has(up) ? 'kw' : TYPES.has(up) ? 'type' : 'txt', v: w });
      i = j;
    } else {
      let j = i + 1;
      while (j < n && !/[A-Za-z0-9_'"`#@\-/]/.test(sql[j])) j++;
      out.push({ t: 'txt', v: sql.slice(i, j) });
      i = j;
    }
  }
  return out;
}

export function SqlHighlight({ sql, className }: { sql: string; className?: string }) {
  const toks = useMemo(() => tokenizeSql(sql), [sql]);
  return (
    <pre className={`ks-sql ${className ?? ''}`}>
      {toks.map((t, i) => (t.t === 'txt' ? t.v : <span key={i} className={`sql-${t.t}`}>{t.v}</span>))}
    </pre>
  );
}
