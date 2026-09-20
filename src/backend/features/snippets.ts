// Code snippets: built-in templates + user snippets (<userData>/snippets.json).

import path from 'node:path';
import type { Snippet, SnippetsApi } from '@shared/apis/snippets';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { readJson, writeJson } from '../util/jsonFile';

function builtIns(): Snippet[] {
  const g = { dml: 'DML', ddl: 'DDL', prog: tr('Programmierung', 'Programming'), admin: tr('Verwaltung', 'Administration') };
  const s = (id: string, group: string, name: string, description: string, sql: string): Snippet => ({
    id: `builtin:${id}`,
    group,
    name,
    description,
    sql,
    builtIn: true
  });
  return [
    s('select', g.dml, 'SELECT', tr('Einfache Abfrage', 'Simple query'), 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition};'),
    s('select-join', g.dml, 'SELECT … JOIN', tr('Abfrage mit Verknüpfung', 'Query with join'), 'SELECT ${1:a}.*, ${2:b}.*\nFROM ${3:table_a} ${1:a}\nJOIN ${4:table_b} ${2:b} ON ${2:b}.${5:id} = ${1:a}.${6:b_id}\nWHERE ${7:1 = 1};'),
    s('select-group', g.dml, 'SELECT … GROUP BY', tr('Gruppierung mit HAVING', 'Grouping with HAVING'), 'SELECT ${1:column}, COUNT(*) AS cnt\nFROM ${2:table}\nGROUP BY ${1:column}\nHAVING COUNT(*) > ${3:1}\nORDER BY cnt DESC;'),
    s('cte', g.dml, 'WITH … (CTE)', tr('Allgemeiner Tabellenausdruck', 'Common table expression'), 'WITH ${1:cte} AS (\n    SELECT ${2:*}\n    FROM ${3:table}\n)\nSELECT *\nFROM ${1:cte};'),
    s('cte-rec', g.dml, 'WITH RECURSIVE', tr('Rekursive Abfrage (z. B. Hierarchie)', 'Recursive query (e.g. hierarchy)'), 'WITH RECURSIVE ${1:tree} AS (\n    SELECT ${2:id}, ${3:parent_id}, 0 AS depth\n    FROM ${4:table}\n    WHERE ${3:parent_id} IS NULL\n    UNION ALL\n    SELECT t.${2:id}, t.${3:parent_id}, r.depth + 1\n    FROM ${4:table} t\n    JOIN ${1:tree} r ON t.${3:parent_id} = r.${2:id}\n)\nSELECT * FROM ${1:tree};'),
    s('window', g.dml, 'ROW_NUMBER() OVER', tr('Fensterfunktion', 'Window function'), 'SELECT *,\n       ROW_NUMBER() OVER (PARTITION BY ${1:group_column} ORDER BY ${2:order_column} DESC) AS rn\nFROM ${3:table};'),
    s('insert', g.dml, 'INSERT', tr('Datensatz einfügen', 'Insert record'), 'INSERT INTO ${1:table} (${2:column1}, ${3:column2})\nVALUES (${4:value1}, ${5:value2});'),
    s('insert-select', g.dml, 'INSERT … SELECT', tr('Daten aus Abfrage einfügen', 'Insert from query'), 'INSERT INTO ${1:target} (${2:columns})\nSELECT ${2:columns}\nFROM ${3:source}\nWHERE ${4:condition};'),
    s('upsert', g.dml, 'INSERT … ON DUPLICATE KEY UPDATE', tr('Einfügen oder aktualisieren', 'Insert or update'), 'INSERT INTO ${1:table} (${2:id}, ${3:column})\nVALUES (${4:1}, ${5:value})\nON DUPLICATE KEY UPDATE ${3:column} = VALUES(${3:column});'),
    s('update', g.dml, 'UPDATE', tr('Datensätze ändern', 'Update records'), 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};'),
    s('delete', g.dml, 'DELETE', tr('Datensätze löschen', 'Delete records'), 'DELETE FROM ${1:table}\nWHERE ${2:condition};'),
    s('tx', g.dml, tr('Transaktion', 'Transaction'), 'START TRANSACTION … COMMIT', 'START TRANSACTION;\n\n${1:-- statements}\n\nCOMMIT;'),
    s('create-table', g.ddl, 'CREATE TABLE', tr('Neue Tabelle', 'New table'), 'CREATE TABLE ${1:table_name} (\n    id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n    ${2:name} VARCHAR(${3:100}) NOT NULL,\n    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    PRIMARY KEY (id)\n) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;'),
    s('add-column', g.ddl, 'ALTER TABLE … ADD COLUMN', tr('Spalte hinzufügen', 'Add column'), 'ALTER TABLE ${1:table}\n    ADD COLUMN ${2:column} ${3:VARCHAR(100)} NULL AFTER ${4:existing_column};'),
    s('create-index', g.ddl, 'CREATE INDEX', tr('Index anlegen', 'Create index'), 'CREATE INDEX ${1:idx_name} ON ${2:table} (${3:column});'),
    s('add-fk', g.ddl, 'ALTER TABLE … FOREIGN KEY', tr('Fremdschlüssel anlegen', 'Add foreign key'), 'ALTER TABLE ${1:child}\n    ADD CONSTRAINT ${2:fk_name} FOREIGN KEY (${3:parent_id})\n    REFERENCES ${4:parent} (${5:id}) ON DELETE ${6:RESTRICT} ON UPDATE ${7:CASCADE};'),
    s('create-view', g.ddl, 'CREATE VIEW', tr('Neue Ansicht', 'New view'), 'CREATE OR REPLACE VIEW ${1:view_name} AS\nSELECT ${2:*}\nFROM ${3:table};'),
    s('create-proc', g.prog, 'CREATE PROCEDURE', tr('Gespeicherte Prozedur', 'Stored procedure'), 'CREATE PROCEDURE ${1:proc_name}(IN ${2:p_id} INT)\nBEGIN\n    ${3:SELECT * FROM table WHERE id = p_id;}\nEND;'),
    s('create-func', g.prog, 'CREATE FUNCTION', tr('Gespeicherte Funktion', 'Stored function'), 'CREATE FUNCTION ${1:func_name}(${2:p_value} INT)\nRETURNS ${3:INT}\nDETERMINISTIC\nBEGIN\n    RETURN ${4:p_value * 2};\nEND;'),
    s('create-trigger', g.prog, 'CREATE TRIGGER', tr('Trigger', 'Trigger'), 'CREATE TRIGGER ${1:trg_name}\n${2|BEFORE,AFTER|} ${3|INSERT,UPDATE,DELETE|} ON ${4:table}\nFOR EACH ROW\nBEGIN\n    ${5:SET NEW.updated_at = NOW();}\nEND;'),
    s('create-event', g.prog, 'CREATE EVENT', tr('Geplantes Ereignis', 'Scheduled event'), 'CREATE EVENT ${1:ev_name}\nON SCHEDULE EVERY ${2:1} ${3|DAY,HOUR,MINUTE,WEEK,MONTH|}\nSTARTS CURRENT_TIMESTAMP\nDO\n    ${4:DELETE FROM log WHERE created_at < NOW() - INTERVAL 30 DAY};'),
    s('if', g.prog, 'IF … THEN', tr('Bedingung', 'Condition'), 'IF ${1:condition} THEN\n    ${2:-- ...}\nELSEIF ${3:condition} THEN\n    ${4:-- ...}\nELSE\n    ${5:-- ...}\nEND IF;'),
    s('case', g.prog, 'CASE', tr('Fallunterscheidung', 'Case expression'), 'CASE\n    WHEN ${1:condition} THEN ${2:result}\n    ELSE ${3:default}\nEND'),
    s('while', g.prog, 'WHILE', tr('Schleife', 'Loop'), 'WHILE ${1:i < 10} DO\n    ${2:SET i = i + 1;}\nEND WHILE;'),
    s('cursor', g.prog, tr('Cursor', 'Cursor'), tr('Cursor mit Handler', 'Cursor with handler'), 'DECLARE done INT DEFAULT FALSE;\nDECLARE ${1:v_id} INT;\nDECLARE cur CURSOR FOR SELECT ${2:id} FROM ${3:table};\nDECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;\n\nOPEN cur;\nread_loop: LOOP\n    FETCH cur INTO ${1:v_id};\n    IF done THEN\n        LEAVE read_loop;\n    END IF;\n    ${4:-- ...}\nEND LOOP;\nCLOSE cur;'),
    s('create-user', g.admin, 'CREATE USER + GRANT', tr('Benutzer mit Rechten anlegen', 'Create user with privileges'), "CREATE USER '${1:user}'@'${2:%}' IDENTIFIED BY '${3:password}';\nGRANT ${4:SELECT, INSERT, UPDATE, DELETE} ON ${5:database}.* TO '${1:user}'@'${2:%}';"),
    s('processlist', g.admin, 'SHOW PROCESSLIST', tr('Laufende Prozesse', 'Running processes'), 'SHOW FULL PROCESSLIST;'),
    s('variables', g.admin, 'SHOW VARIABLES LIKE', tr('Servervariablen', 'Server variables'), "SHOW VARIABLES LIKE '${1:%timeout%}';"),
    s('status', g.admin, 'SHOW STATUS LIKE', tr('Serverstatus', 'Server status'), "SHOW GLOBAL STATUS LIKE '${1:Threads%}';"),
    s('table-sizes', g.admin, tr('Tabellengrößen', 'Table sizes'), tr('Größte Tabellen einer Datenbank', 'Largest tables of a database'), "SELECT TABLE_NAME, TABLE_ROWS, ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS size_mb\nFROM information_schema.TABLES\nWHERE TABLE_SCHEMA = '${1:database}'\nORDER BY DATA_LENGTH + INDEX_LENGTH DESC;")
  ];
}

export function createSnippetsApi(userDataDir: string): SnippetsApi {
  const file = path.join(userDataDir, 'snippets.json');
  const loadUser = () => readJson<Snippet[]>(file, []);
  return {
    async list() {
      const user = await loadUser();
      return [...builtIns(), ...user.map((s) => ({ ...s, builtIn: false }))];
    },
    async save(snippet) {
      const user = await loadUser();
      const s: Snippet = { ...snippet, id: snippet.id && !snippet.id.startsWith('builtin:') ? snippet.id : newId('s'), builtIn: false };
      const idx = user.findIndex((x) => x.id === s.id);
      if (idx >= 0) user[idx] = s;
      else user.push(s);
      await writeJson(file, user);
      return s;
    },
    async remove(id) {
      const user = await loadUser();
      await writeJson(
        file,
        user.filter((x) => x.id !== id)
      );
    }
  };
}
