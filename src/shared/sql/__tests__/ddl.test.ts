import { describe, expect, it } from 'vitest';
import { defaultTableOptions, newField } from '@shared/defaults';
import type { CheckDef, FieldDef, ForeignKeyDef, IndexDef, TableDesign, TriggerDef } from '@shared/types';
import {
  alterEventSql,
  alterTableSql,
  alterTableSteps,
  asExisting,
  columnDefinition,
  createEventSql,
  createRoutineSql,
  createTableSql,
  createViewSql,
  eventDefFromInfo,
  eventScheduleSql,
  exprIdentifiers,
  parseCreateRoutine,
  refineDesignFromDdl,
  routineCallScript,
  fkDefinition,
  formatDefiner,
  indexDefinition,
  parseCreateView,
  parsePartitionClause,
  parseRoutineHeader,
  partitionClauseSql,
  plainDefiner,
  renameColumnInExpr,
  splitTopLevel,
  syncTableSql,
  type EventDef,
  type RoutineDef,
  type ViewDef
} from '../ddl';

// ───────────── helpers ─────────────

function table(p: Partial<TableDesign> = {}): TableDesign {
  return {
    schema: 'db',
    name: 't',
    fields: [],
    primaryKey: [],
    indexes: [],
    foreignKeys: [],
    checks: [],
    triggers: [],
    options: { ...defaultTableOptions(), engine: 'InnoDB' },
    comment: '',
    partition: '',
    ...p
  };
}

const fld = (name: string, p: Partial<FieldDef> = {}): FieldDef => newField({ name, origName: name, ...p });
const int = (name: string, p: Partial<FieldDef> = {}) => fld(name, { type: 'INT', length: '', ...p });
const vc = (name: string, len = '50', p: Partial<FieldDef> = {}) => fld(name, { type: 'VARCHAR', length: len, ...p });

const ix = (name: string, cols: string[], p: Partial<IndexDef> = {}): IndexDef => ({
  id: `i_${name}`,
  origName: name,
  name,
  fields: cols.map((c) => ({ name: c, subPart: '', order: '' })),
  type: 'NORMAL',
  method: '',
  comment: '',
  invisible: false,
  parser: '',
  keyBlockSize: '',
  ...p
});

const fk = (name: string, cols: string[], refTable: string, refCols: string[], p: Partial<ForeignKeyDef> = {}): ForeignKeyDef => ({
  id: `r_${name}`,
  origName: name,
  name,
  fields: cols,
  refSchema: 'db',
  refTable,
  refFields: refCols,
  onDelete: '',
  onUpdate: '',
  ...p
});

const chk = (name: string, expr: string, p: Partial<CheckDef> = {}): CheckDef => ({ id: `k_${name}`, origName: name, name, expr, enforced: true, ...p });

const trg = (name: string, body: string, p: Partial<TriggerDef> = {}): TriggerDef => ({
  id: `t_${name}`,
  origName: name,
  name,
  timing: 'BEFORE',
  event: 'INSERT',
  body,
  definer: '',
  orderType: '',
  orderOther: '',
  ...p
});

/** Base table used by the ALTER scenarios */
function base(): TableDesign {
  return table({
    fields: [int('id', { notNull: true, autoIncrement: true, unsigned: true }), vc('name'), int('qty', { notNull: true, defaultKind: 'value', defaultValue: '0' }), vc('note', '200')],
    primaryKey: ['id'],
    indexes: [ix('idx_name', ['name']), ix('uq_note', ['note'], { type: 'UNIQUE' })],
    foreignKeys: [fk('fk_t_qty', ['qty'], 'other', ['id'])],
    checks: [chk('chk_qty', '`qty` >= 0')],
    triggers: [trg('trg_bi', 'SET NEW.name = UPPER(NEW.name)')],
    comment: 'Basis'
  });
}

const clone = <T>(x: T): T => structuredClone(x);

// ───────────── CREATE TABLE ─────────────

describe('createTableSql', () => {
  it('generates a complete table with keys, constraints, options and triggers', () => {
    const d = table({
      fields: [
        int('id', { notNull: true, autoIncrement: true, unsigned: true }),
        vc('name', '100', { notNull: true, comment: "Kunde's Name" }),
        fld('price', { type: 'DECIMAL', length: '10', decimals: '2', notNull: true, defaultKind: 'value', defaultValue: '0.00' }),
        fld('created', { type: 'DATETIME', length: '3', notNull: true, defaultKind: 'expression', defaultValue: 'CURRENT_TIMESTAMP(3)' }),
        fld('status', { type: 'ENUM', length: '', values: ['new', "it's"], defaultKind: 'value', defaultValue: 'new' })
      ],
      primaryKey: ['id'],
      indexes: [ix('uq_name', ['name'], { type: 'UNIQUE', comment: 'eindeutig' })],
      foreignKeys: [fk('fk_t_other', ['id'], 'other', ['id'], { onDelete: 'CASCADE' })],
      checks: [chk('chk_price', '`price` >= 0')],
      triggers: [trg('trg_t_bi', 'SET NEW.name = TRIM(NEW.name)')],
      options: { ...defaultTableOptions(), engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_bin', rowFormat: 'DYNAMIC' },
      comment: 'Test'
    });
    expect(createTableSql(d, { serverType: 'mysql' })).toEqual([
      'CREATE TABLE `db`.`t` (\n' +
        '  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,\n' +
        "  `name` VARCHAR(100) NOT NULL COMMENT 'Kunde\\'s Name',\n" +
        '  `price` DECIMAL(10,2) NOT NULL DEFAULT 0.00,\n' +
        '  `created` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n' +
        "  `status` ENUM('new','it\\'s') NULL DEFAULT 'new',\n" +
        '  PRIMARY KEY (`id`),\n' +
        "  UNIQUE INDEX `uq_name` (`name`) COMMENT 'eindeutig',\n" +
        '  CONSTRAINT `fk_t_other` FOREIGN KEY (`id`) REFERENCES `other` (`id`) ON DELETE CASCADE,\n' +
        '  CONSTRAINT `chk_price` CHECK (`price` >= 0)\n' +
        ") ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin ROW_FORMAT = DYNAMIC COMMENT = 'Test'",
      'CREATE TRIGGER `db`.`trg_t_bi` BEFORE INSERT ON `db`.`t` FOR EACH ROW SET NEW.name = TRIM(NEW.name)'
    ]);
  });

  it('quotes identifiers and escapes literals', () => {
    const d = table({
      name: 'we`ird',
      fields: [vc('a`b', '10', { comment: 'back\\slash "q"' })],
      indexes: [ix('i`x', ['a`b'])]
    });
    const [sql] = createTableSql(d);
    expect(sql).toContain('CREATE TABLE `db`.`we``ird`');
    expect(sql).toContain('`a``b` VARCHAR(10) NULL COMMENT \'back\\\\slash \\"q\\"\'');
    expect(sql).toContain('INDEX `i``x` (`a``b`)');
  });

  it('omits empty constraint names so the server generates them', () => {
    const d = table({
      fields: [int('id'), int('p')],
      indexes: [ix('', ['p'])],
      foreignKeys: [fk('', ['p'], 'other', ['id'])],
      checks: [chk('', '`p` > 0')]
    });
    const [sql] = createTableSql(d);
    expect(sql).toContain('  INDEX (`p`)');
    expect(sql).toContain('  FOREIGN KEY (`p`) REFERENCES `other` (`id`)');
    expect(sql).toContain('  CHECK (`p` > 0)');
    expect(sql).not.toContain('``');
  });

  it('handles spatial, fulltext, functional and descending index parts', () => {
    expect(indexDefinition(ix('sp', ['g'], { type: 'SPATIAL', fields: [{ name: 'g', subPart: '32', order: '' }] }))).toBe('SPATIAL INDEX `sp` (`g`)');
    expect(indexDefinition(ix('ft', ['t'], { type: 'FULLTEXT', parser: 'ngram', method: 'BTREE' }))).toBe('FULLTEXT INDEX `ft` (`t`) WITH PARSER `ngram`');
    expect(
      indexDefinition(
        ix('fx', [], {
          fields: [
            { name: 'a', subPart: '10', order: 'DESC' },
            { name: '', subPart: '', order: 'DESC', expr: 'lower(`b`)' }
          ],
          method: 'BTREE',
          keyBlockSize: '8',
          invisible: true
        })
      )
    ).toBe('INDEX `fx` (`a`(10) DESC, (lower(`b`)) DESC) USING BTREE KEY_BLOCK_SIZE = 8 INVISIBLE');
    expect(indexDefinition(ix('iv', ['a'], { invisible: true }), { serverType: 'mariadb' })).toBe('INDEX `iv` (`a`) IGNORED');
  });

  it('generates column definitions for defaults, generated and special columns', () => {
    const gen = fld('g', { type: 'INT', length: '', generated: true, generatedExpr: '`a` + 1', generatedStored: true, notNull: true });
    expect(columnDefinition(gen)).toBe('`g` INT GENERATED ALWAYS AS (`a` + 1) STORED NOT NULL');
    expect(columnDefinition(gen, { serverType: 'mariadb' })).toBe('`g` INT GENERATED ALWAYS AS (`a` + 1) STORED');
    expect(columnDefinition(fld('t', { type: 'TEXT', length: '', defaultKind: 'value', defaultValue: "it's" }))).toBe("`t` TEXT NULL DEFAULT ('it\\'s')");
    expect(columnDefinition(fld('t', { type: 'TEXT', length: '', defaultKind: 'value', defaultValue: 'x' }), { serverType: 'mariadb' })).toBe("`t` TEXT NULL DEFAULT 'x'");
    expect(columnDefinition(fld('e', { type: 'VARCHAR', length: '5', defaultKind: 'empty' }))).toBe("`e` VARCHAR(5) NULL DEFAULT ''");
    expect(columnDefinition(fld('b', { type: 'BIT', length: '1', notNull: true, defaultKind: 'value', defaultValue: '1' }))).toBe("`b` BIT(1) NOT NULL DEFAULT b'1'");
    expect(columnDefinition(fld('x', { type: 'VARCHAR', length: '20', defaultKind: 'expression', defaultValue: "concat('a','b')" }))).toBe(
      "`x` VARCHAR(20) NULL DEFAULT (concat('a','b'))"
    );
    expect(columnDefinition(fld('n', { type: 'INT', length: '', defaultKind: 'null' }))).toBe('`n` INT NULL DEFAULT NULL');
    expect(
      columnDefinition(fld('u', { type: 'TIMESTAMP', length: '6', defaultKind: 'expression', defaultValue: 'CURRENT_TIMESTAMP(6)', onUpdateCurrentTimestamp: true }))
    ).toBe('`u` TIMESTAMP(6) NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)');
    expect(columnDefinition(fld('p', { type: 'POINT', length: '', notNull: true, srid: '4326', invisible: true }))).toBe('`p` POINT NOT NULL SRID 4326 INVISIBLE');
    expect(columnDefinition(fld('c', { type: 'VARCHAR', length: '10', charset: 'latin1', collation: 'latin1_german2_ci' }))).toBe(
      '`c` VARCHAR(10) CHARACTER SET latin1 COLLATE latin1_german2_ci NULL'
    );
    expect(columnDefinition(fld('z', { type: 'INT', length: '5', unsigned: true, zerofill: true }))).toBe('`z` INT(5) UNSIGNED ZEROFILL NULL');
  });

  it('references other schemas only when needed and orders triggers by FOLLOWS / PRECEDES', () => {
    expect(fkDefinition(fk('f', ['a'], 'p', ['id'], { refSchema: 'other_db', onUpdate: 'SET NULL' }), 'db')).toBe(
      'CONSTRAINT `f` FOREIGN KEY (`a`) REFERENCES `other_db`.`p` (`id`) ON UPDATE SET NULL'
    );
    const d = table({
      fields: [int('id')],
      triggers: [trg('second', 'SET @a = 2', { orderType: 'FOLLOWS', orderOther: 'first' }), trg('first', 'SET @a = 1')]
    });
    const out = createTableSql(d);
    expect(out[1]).toContain('TRIGGER `db`.`first`');
    expect(out[2]).toBe('CREATE TRIGGER `db`.`second` BEFORE INSERT ON `db`.`t` FOR EACH ROW FOLLOWS `first` SET @a = 2');
  });

  it('appends the partition clause', () => {
    const d = table({ fields: [int('id', { notNull: true })], primaryKey: ['id'], partition: 'PARTITION BY HASH (`id`)\nPARTITIONS 4' });
    expect(createTableSql(d)[0].endsWith(') ENGINE = InnoDB\nPARTITION BY HASH (`id`)\nPARTITIONS 4')).toBe(true);
  });
});

// ───────────── ALTER TABLE ─────────────

describe('alterTableSql', () => {
  it('returns nothing for an unchanged table', () => {
    const d = base();
    expect(alterTableSql(d, clone(d))).toEqual([]);
    expect(syncTableSql(d, d)).toEqual([]);
  });

  it('renames a column without touching indexes or foreign keys that follow it', () => {
    const from = base();
    const to = clone(from);
    to.fields[1].name = 'full_name';
    to.indexes[0].fields[0].name = 'full_name';
    expect(alterTableSql(from, to)).toEqual(['ALTER TABLE `db`.`t`\n  CHANGE COLUMN `name` `full_name` VARCHAR(50) NULL']);
    const to2 = clone(from);
    to2.fields[2].name = 'quantity';
    to2.foreignKeys[0].fields = ['quantity'];
    to2.checks[0].expr = renameColumnInExpr(to2.checks[0].expr, 'qty', 'quantity');
    expect(alterTableSql(from, to2)).toEqual([
      'ALTER TABLE `db`.`t`\n  DROP CHECK `chk_qty`,\n  CHANGE COLUMN `qty` `quantity` INT NOT NULL DEFAULT 0,\n  ADD CONSTRAINT `chk_qty` CHECK (`quantity` >= 0)'
    ]);
  });

  it('moves, adds, drops and modifies columns with correct positions', () => {
    const from = base();
    const to = clone(from);
    const [id, name, qty, note] = to.fields;
    to.fields = [id, qty, name, note];
    expect(alterTableSql(from, to)).toEqual(['ALTER TABLE `db`.`t`\n  MODIFY COLUMN `qty` INT NOT NULL DEFAULT 0 AFTER `id`']);

    const to2 = clone(from);
    to2.fields.splice(1, 0, newField({ name: 'code', type: 'CHAR', length: '3', notNull: true }));
    to2.fields.splice(0, 0, newField({ name: 'first', type: 'INT', length: '' }));
    to2.fields = to2.fields.filter((f) => f.name !== 'note');
    to2.indexes = to2.indexes.filter((i) => i.name !== 'uq_note');
    to2.fields.find((f) => f.name === 'name')!.length = '80';
    expect(alterTableSql(from, to2)).toEqual([
      'ALTER TABLE `db`.`t`\n' +
        '  DROP INDEX `uq_note`,\n' +
        '  DROP COLUMN `note`,\n' +
        '  ADD COLUMN `first` INT NULL FIRST,\n' +
        '  ADD COLUMN `code` CHAR(3) NOT NULL AFTER `id`,\n' +
        '  MODIFY COLUMN `name` VARCHAR(80) NULL'
    ]);
  });

  it('keeps the order right for swapped columns', () => {
    const from = table({ fields: [int('a'), int('b'), int('c'), int('d')] });
    const to = clone(from);
    to.fields = [to.fields[1], to.fields[0], to.fields[3], to.fields[2]];
    expect(alterTableSql(from, to)).toEqual(['ALTER TABLE `db`.`t`\n  MODIFY COLUMN `b` INT NULL FIRST,\n  MODIFY COLUMN `d` INT NULL AFTER `a`']);
  });

  it('changes the primary key only when its columns change', () => {
    const from = base();
    const renamed = clone(from);
    renamed.fields[0].name = 'pk_id';
    renamed.primaryKey = ['pk_id'];
    expect(alterTableSql(from, renamed)).toEqual(['ALTER TABLE `db`.`t`\n  CHANGE COLUMN `id` `pk_id` INT UNSIGNED NOT NULL AUTO_INCREMENT']);
    const composite = clone(from);
    composite.primaryKey = ['id', 'qty'];
    expect(alterTableSql(from, composite)).toEqual(['ALTER TABLE `db`.`t`\n  DROP PRIMARY KEY,\n  ADD PRIMARY KEY (`id`, `qty`)']);
    const none = clone(from);
    none.primaryKey = [];
    none.fields[0].autoIncrement = false;
    expect(alterTableSql(from, none)).toEqual(['ALTER TABLE `db`.`t`\n  DROP PRIMARY KEY,\n  MODIFY COLUMN `id` INT UNSIGNED NOT NULL']);
  });

  it('renames, redefines and hides indexes', () => {
    const from = base();
    const to = clone(from);
    to.indexes[0].name = 'idx_name2';
    to.indexes[1].invisible = true;
    expect(alterTableSql(from, to)).toEqual(['ALTER TABLE `db`.`t`\n  RENAME INDEX `idx_name` TO `idx_name2`,\n  ALTER INDEX `uq_note` INVISIBLE']);
    expect(alterTableSql(from, to, { serverType: 'mariadb', serverVersion: 101106 })).toEqual([
      'ALTER TABLE `db`.`t`\n  RENAME INDEX `idx_name` TO `idx_name2`,\n  ALTER INDEX `uq_note` IGNORED'
    ]);
    const to2 = clone(from);
    to2.indexes[0].fields.push({ name: 'qty', subPart: '', order: 'DESC' });
    to2.indexes.push({ ...ix('idx_new', ['note']), origName: undefined, fields: [{ name: 'note', subPart: '20', order: '' }] });
    expect(alterTableSql(from, to2)).toEqual([
      'ALTER TABLE `db`.`t`\n  DROP INDEX `idx_name`,\n  ADD INDEX `idx_name` (`name`, `qty` DESC),\n  ADD INDEX `idx_new` (`note`(20))'
    ]);
  });

  it('drops and re-adds changed foreign keys in separate statements', () => {
    const from = base();
    const to = clone(from);
    to.foreignKeys[0].onDelete = 'CASCADE';
    to.foreignKeys.push({ ...fk('fk_t_name', ['name'], 'names', ['name']), origName: undefined, refSchema: 'lookup' });
    expect(alterTableSteps(from, to).map((s) => [s.kind, s.sql])).toEqual([
      ['dropForeignKeys', 'ALTER TABLE `db`.`t`\n  DROP FOREIGN KEY `fk_t_qty`'],
      [
        'addForeignKeys',
        'ALTER TABLE `db`.`t`\n  ADD CONSTRAINT `fk_t_qty` FOREIGN KEY (`qty`) REFERENCES `other` (`id`) ON DELETE CASCADE,\n  ADD CONSTRAINT `fk_t_name` FOREIGN KEY (`name`) REFERENCES `lookup`.`names` (`name`)'
      ]
    ]);
  });

  it('treats an unspecified referential action like the one the server reports', () => {
    const from = base();
    from.foreignKeys[0].onDelete = 'NO ACTION';
    from.foreignKeys[0].onUpdate = 'NO ACTION';
    const model = clone(from);
    model.foreignKeys[0].onDelete = '';
    model.foreignKeys[0].onUpdate = '';
    expect(alterTableSql(from, model, { serverType: 'mysql' })).toEqual([]);
    const restrict = clone(from);
    restrict.foreignKeys[0].onDelete = 'RESTRICT';
    expect(alterTableSql(from, restrict).length).toBe(2);
    const maria = clone(model);
    maria.foreignKeys[0].onDelete = 'RESTRICT';
    maria.foreignKeys[0].onUpdate = 'RESTRICT';
    expect(alterTableSql(maria, model, { serverType: 'mariadb' })).toEqual([]);
  });

  it('keeps a self referencing foreign key when its columns are renamed', () => {
    const from = table({ name: 'emp', fields: [int('id', { notNull: true }), int('boss')], primaryKey: ['id'], foreignKeys: [fk('fk_boss', ['boss'], 'emp', ['id'])] });
    const to = clone(from);
    to.fields[0].name = 'emp_id';
    to.primaryKey = ['emp_id'];
    to.foreignKeys[0].refFields = ['emp_id'];
    expect(alterTableSql(from, to)).toEqual(['ALTER TABLE `db`.`emp`\n  CHANGE COLUMN `id` `emp_id` INT NOT NULL']);
  });

  it('drops and re-adds foreign keys that block a primary key or column type change', () => {
    const from = table({ name: 'emp', fields: [int('id', { notNull: true }), int('boss'), vc('code', '5')], primaryKey: ['id'], foreignKeys: [fk('fk_boss', ['boss'], 'emp', ['id'])] });
    const pk = clone(from);
    pk.fields[2].notNull = true;
    pk.primaryKey = ['id', 'code'];
    expect(alterTableSteps(from, pk).map((s) => s.kind)).toEqual(['dropForeignKeys', 'alterTable', 'addForeignKeys']);
    const retype = clone(from);
    retype.fields[1].type = 'BIGINT';
    expect(alterTableSteps(from, retype).map((s) => s.kind)).toEqual(['dropForeignKeys', 'alterTable', 'addForeignKeys']);
    const comment = clone(from);
    comment.fields[1].comment = 'Chef';
    expect(alterTableSteps(from, comment).map((s) => s.kind)).toEqual(['alterTable']);
  });

  it('changes checks (MySQL ALTER CHECK for enforcement, MariaDB DROP CONSTRAINT)', () => {
    const from = base();
    const enforced = clone(from);
    enforced.checks[0].enforced = false;
    expect(alterTableSql(from, enforced)).toEqual(['ALTER TABLE `db`.`t`\n  ALTER CHECK `chk_qty` NOT ENFORCED']);
    const expr = clone(from);
    expr.checks[0].expr = '`qty` > 0';
    expr.checks.push({ ...chk('', '`note` <> \'\''), origName: undefined });
    expect(alterTableSql(from, expr)).toEqual(["ALTER TABLE `db`.`t`\n  DROP CHECK `chk_qty`,\n  ADD CONSTRAINT `chk_qty` CHECK (`qty` > 0),\n  ADD CHECK (`note` <> '')"]);
    expect(alterTableSql(from, expr, { serverType: 'mariadb' })[0]).toContain('DROP CONSTRAINT `chk_qty`');
    const removed = clone(from);
    removed.checks = [];
    expect(alterTableSql(from, removed)).toEqual(['ALTER TABLE `db`.`t`\n  DROP CHECK `chk_qty`']);
  });

  it('re-creates changed triggers after the table change', () => {
    const from = base();
    const to = clone(from);
    to.triggers[0].body = 'SET NEW.name = LOWER(NEW.name)';
    to.triggers.push({ ...trg('trg_bu', 'SET NEW.qty = ABS(NEW.qty)', { event: 'UPDATE', definer: 'app@%' }), origName: undefined });
    to.comment = 'Neu';
    const steps = alterTableSteps(from, to, { includeDefiner: true });
    expect(steps.map((s) => s.kind)).toEqual(['dropTrigger', 'alterTable', 'createTrigger', 'createTrigger']);
    expect(steps[0].sql).toBe('DROP TRIGGER `db`.`trg_bi`');
    expect(steps[1].sql).toBe("ALTER TABLE `db`.`t`\n  COMMENT = 'Neu'");
    expect(steps[2].sql).toBe('CREATE TRIGGER `db`.`trg_bi` BEFORE INSERT ON `db`.`t` FOR EACH ROW SET NEW.name = LOWER(NEW.name)');
    expect(steps[3].sql).toBe('CREATE DEFINER = `app`@`%` TRIGGER `db`.`trg_bu` BEFORE UPDATE ON `db`.`t` FOR EACH ROW SET NEW.qty = ABS(NEW.qty)');
    const definerOnly = clone(from);
    definerOnly.triggers[0].definer = 'root@localhost';
    expect(alterTableSql(from, definerOnly)).toEqual([]);
    expect(alterTableSteps(from, definerOnly, { includeDefiner: true }).map((s) => s.kind)).toEqual(['dropTrigger', 'createTrigger']);
  });

  it('changes and resets table options', () => {
    const from = base();
    from.options = { ...from.options, rowFormat: 'COMPACT', packKeys: '1', statsSamplePages: '20', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci', autoIncrement: '13' };
    const to = clone(from);
    to.options = { ...to.options, engine: 'MyISAM', rowFormat: '', packKeys: '', statsSamplePages: '', checksum: true, autoIncrement: '100', charset: 'latin1', collation: 'latin1_german1_ci' };
    expect(alterTableSql(from, to)).toEqual([
      'ALTER TABLE `db`.`t`\n' +
        '  ENGINE = MyISAM,\n' +
        '  AUTO_INCREMENT = 100,\n' +
        '  ROW_FORMAT = DEFAULT,\n' +
        '  CHECKSUM = 1,\n' +
        '  PACK_KEYS = DEFAULT,\n' +
        '  STATS_SAMPLE_PAGES = DEFAULT,\n' +
        '  CHARACTER SET = latin1 COLLATE = latin1_german1_ci'
    ]);
    const merge = table({ options: { ...defaultTableOptions(), engine: 'MRG_MyISAM', insertMethod: 'LAST', union: '`a`,`b`' } });
    const merge2 = clone(merge);
    merge2.options.insertMethod = '';
    merge2.options.union = '';
    expect(alterTableSql(merge, merge2)).toEqual(['ALTER TABLE `db`.`t`\n  INSERT_METHOD = NO,\n  UNION = ()']);
  });

  it('adds, changes and removes partitioning but ignores formatting differences', () => {
    const from = table({ fields: [int('id', { notNull: true })], primaryKey: ['id'] });
    const to = clone(from);
    to.partition = 'PARTITION BY HASH (`id`) PARTITIONS 4';
    expect(alterTableSteps(from, to).map((s) => [s.kind, s.sql])).toEqual([['partition', 'ALTER TABLE `db`.`t`\nPARTITION BY HASH (`id`) PARTITIONS 4']]);
    const reformatted = clone(to);
    reformatted.partition = 'PARTITION BY HASH(`id`)\nPARTITIONS 4';
    expect(alterTableSql(to, reformatted)).toEqual([]);
    const valueCase = table({ partition: "PARTITION BY LIST COLUMNS(c) (PARTITION p VALUES IN ('DE'))" });
    const valueCase2 = clone(valueCase);
    valueCase2.partition = "PARTITION BY LIST COLUMNS(c) (PARTITION p VALUES IN ('de'))";
    expect(alterTableSql(valueCase, valueCase2).length).toBe(1);
    expect(alterTableSql(to, from)).toEqual(['ALTER TABLE `db`.`t` REMOVE PARTITIONING']);
  });

  it('drops and adds a column whose generated kind involves VIRTUAL, rebuilding its indexes', () => {
    const from = table({
      fields: [int('id', { notNull: true }), int('a'), fld('v', { type: 'INT', length: '', generated: true, generatedExpr: '`a` + 1' }), int('z')],
      primaryKey: ['id'],
      indexes: [ix('idx_v', ['v'])]
    });
    const to = clone(from);
    to.fields[2].generatedStored = true;
    expect(alterTableSql(from, to)).toEqual([
      'ALTER TABLE `db`.`t`\n' +
        '  DROP INDEX `idx_v`,\n' +
        '  DROP COLUMN `v`,\n' +
        '  ADD COLUMN `v` INT GENERATED ALWAYS AS (`a` + 1) STORED NULL AFTER `a`,\n' +
        '  ADD INDEX `idx_v` (`v`)'
    ]);
    const stored = clone(to);
    const normal = clone(to);
    normal.fields[2].generated = false;
    // STORED -> normal works with MODIFY
    expect(alterTableSql(stored, normal)).toEqual(['ALTER TABLE `db`.`t`\n  MODIFY COLUMN `v` INT NULL']);
  });

  it('renames the table and keeps triggers attached', () => {
    const from = base();
    const to = clone(from);
    to.name = 't2';
    expect(alterTableSql(from, to)).toEqual(['ALTER TABLE `db`.`t`\n  RENAME TO `db`.`t2`']);
  });

  it('treats a missing default of a nullable column like DEFAULT NULL', () => {
    const from = base();
    from.fields[1].defaultKind = 'null';
    const to = clone(from);
    to.fields[1].defaultKind = 'none';
    expect(alterTableSql(from, to)).toEqual([]);
    to.fields[1].notNull = true;
    expect(alterTableSql(from, to)).toEqual(['ALTER TABLE `db`.`t`\n  MODIFY COLUMN `name` VARCHAR(50) NOT NULL']);
  });

  it('treats objects without origName as new', () => {
    const from = base();
    const to = asExisting(from);
    to.fields.push(newField({ name: 'extra', type: 'JSON', length: '' }));
    expect(alterTableSql(from, to)).toEqual(['ALTER TABLE `db`.`t`\n  ADD COLUMN `extra` JSON NULL AFTER `note`']);
  });
});

// ───────────── expression helpers ─────────────

describe('expression helpers', () => {
  it('renames column references but leaves strings, functions and qualified names alone', () => {
    expect(renameColumnInExpr("`qty` > 0 AND qty < 10 AND name <> 'qty' AND qty(1) AND t.qty = 1", 'qty', 'menge')).toBe(
      "`menge` > 0 AND `menge` < 10 AND name <> 'qty' AND qty(1) AND t.qty = 1"
    );
    expect(renameColumnInExpr('`Price` * 2', 'price', 'p`x')).toBe('`p``x` * 2');
  });

  it('collects identifiers', () => {
    expect([...exprIdentifiers("`a` + b - 'c'")].sort()).toEqual(['a', 'b']);
  });

  it('splits at top level only', () => {
    expect(splitTopLevel("a INT, b DECIMAL(10,2), c ENUM('x,y','z')")).toEqual(['a INT', 'b DECIMAL(10,2)', "c ENUM('x,y','z')"]);
  });

  it('formats definers', () => {
    expect(formatDefiner('root@localhost')).toBe('`root`@`localhost`');
    expect(formatDefiner("'app'@'%'")).toBe('`app`@`%`');
    expect(formatDefiner('`we``ird`@`h`')).toBe('`we``ird`@`h`');
    expect(formatDefiner('CURRENT_USER()')).toBe('CURRENT_USER');
    expect(plainDefiner('`root`@`localhost`')).toBe('root@localhost');
  });
});

// ───────────── partitions ─────────────

const PARTS = {
  range: "PARTITION BY RANGE (year(`d`))\n(PARTITION p0 VALUES LESS THAN (2000) COMMENT = 'alt' ENGINE = InnoDB,\n PARTITION p1 VALUES LESS THAN (2020) ENGINE = InnoDB,\n PARTITION pmax VALUES LESS THAN MAXVALUE ENGINE = InnoDB)",
  list: 'PARTITION BY LIST (`r`)\n(PARTITION pn VALUES IN (1,2,3) ENGINE = InnoDB,\n PARTITION ps VALUES IN (NULL,4,5) ENGINE = InnoDB)',
  hash: 'PARTITION BY LINEAR HASH (`id`)\nPARTITIONS 4',
  key: 'PARTITION BY KEY ()\nPARTITIONS 3',
  rangeColumns: "PARTITION BY RANGE  COLUMNS(a,b)\n(PARTITION p0 VALUES LESS THAN (10,'m') ENGINE = InnoDB,\n PARTITION p1 VALUES LESS THAN (MAXVALUE,MAXVALUE) ENGINE = InnoDB)",
  listColumns: "PARTITION BY LIST  COLUMNS(c)\n(PARTITION pde VALUES IN ('DE','AT') ENGINE = InnoDB,\n PARTITION pother VALUES IN ('CH') ENGINE = InnoDB)",
  sub: 'PARTITION BY RANGE (year(`d`))\nSUBPARTITION BY HASH (to_days(`d`))\nSUBPARTITIONS 2\n(PARTITION p0 VALUES LESS THAN (1990) ENGINE = InnoDB,\n PARTITION p1 VALUES LESS THAN MAXVALUE ENGINE = InnoDB)',
  subExplicit:
    "PARTITION BY RANGE (year(`d`))\nSUBPARTITION BY KEY (id)\n(PARTITION p0 VALUES LESS THAN (1990)\n (SUBPARTITION s0 ENGINE = InnoDB,\n  SUBPARTITION s1 COMMENT = 'x' ENGINE = InnoDB),\n PARTITION p1 VALUES LESS THAN MAXVALUE\n (SUBPARTITION s2 ENGINE = InnoDB,\n  SUBPARTITION `s3` ENGINE = InnoDB))"
};

describe('partition clauses', () => {
  it('parses SHOW CREATE TABLE partition clauses', () => {
    const r = parsePartitionClause(PARTS.range)!;
    expect(r).toMatchObject({ method: 'RANGE', columns: false, expr: 'year(`d`)' });
    expect(r.partitions.map((p) => [p.name, p.values, p.comment, p.engine])).toEqual([
      ['p0', '2000', 'alt', 'InnoDB'],
      ['p1', '2020', '', 'InnoDB'],
      ['pmax', 'MAXVALUE', '', 'InnoDB']
    ]);
    expect(parsePartitionClause(PARTS.list)!.partitions[1].values).toBe('NULL,4,5');
    expect(parsePartitionClause(PARTS.hash)).toMatchObject({ method: 'HASH', linear: true, expr: '`id`', count: '4', partitions: [] });
    expect(parsePartitionClause(PARTS.key)).toMatchObject({ method: 'KEY', expr: '', count: '3' });
    expect(parsePartitionClause(PARTS.rangeColumns)).toMatchObject({ method: 'RANGE', columns: true, expr: 'a,b' });
    expect(parsePartitionClause(PARTS.listColumns)!.partitions[0].values).toBe("'DE','AT'");
    expect(parsePartitionClause(PARTS.sub)).toMatchObject({ subMethod: 'HASH', subExpr: 'to_days(`d`)', subCount: '2' });
    const se = parsePartitionClause(PARTS.subExplicit)!;
    expect(se.subMethod).toBe('KEY');
    expect(se.subCount).toBe('2');
    expect(se.partitions[0].subpartitions.map((s) => [s.name, s.comment])).toEqual([
      ['s0', ''],
      ['s1', 'x']
    ]);
    expect(se.partitions[1].subpartitions[1].name).toBe('s3');
    expect(parsePartitionClause('/*!50100 PARTITION BY HASH (`id`) PARTITIONS 2 */')).toMatchObject({ method: 'HASH', count: '2' });
    expect(parsePartitionClause('PARTITION BY RANGE (a) (PARTITION p0 VALUES LESS THAN (1) NODEGROUP = 2)')).toBeNull();
    expect(parsePartitionClause('garbage')).toBeNull();
  });

  it('generates clauses that parse back to the same structure', () => {
    for (const [k, text] of Object.entries(PARTS)) {
      const p = parsePartitionClause(text);
      expect(p, k).not.toBeNull();
      const again = parsePartitionClause(partitionClauseSql(p!));
      expect(again, k).toEqual(p);
    }
    expect(partitionClauseSql(parsePartitionClause(PARTS.range)!)).toBe(
      "PARTITION BY RANGE (year(`d`))\n(PARTITION `p0` VALUES LESS THAN (2000) ENGINE = InnoDB COMMENT = 'alt',\n PARTITION `p1` VALUES LESS THAN (2020) ENGINE = InnoDB,\n PARTITION `pmax` VALUES LESS THAN MAXVALUE ENGINE = InnoDB)"
    );
    expect(partitionClauseSql(parsePartitionClause(PARTS.rangeColumns)!)).toContain('VALUES LESS THAN (MAXVALUE,MAXVALUE)');
  });
});

// ───────────── views ─────────────

describe('views', () => {
  it('parses SHOW CREATE VIEW output', () => {
    const v = parseCreateView(
      'CREATE ALGORITHM=MERGE DEFINER=`root`@`localhost` SQL SECURITY INVOKER VIEW `ks_t_design`.`v1` (`vid`,`vname`) AS select `ks_t_design`.`base`.`id` AS `id` from `ks_t_design`.`base` where (`ks_t_design`.`base`.`qty` > 0) WITH LOCAL CHECK OPTION'
    )!;
    expect(v).toEqual({
      name: 'v1',
      definition: 'select `ks_t_design`.`base`.`id` AS `id` from `ks_t_design`.`base` where (`ks_t_design`.`base`.`qty` > 0)',
      algorithm: 'MERGE',
      definer: 'root@localhost',
      security: 'INVOKER',
      checkOption: 'LOCAL',
      columns: ['vid', 'vname']
    });
    const w = parseCreateView("CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v 2` AS select 'it\\'s' AS `a``b`")!;
    expect(w.name).toBe('v 2');
    expect(w.definition).toBe("select 'it\\'s' AS `a``b`");
    expect(w.checkOption).toBe('');
  });

  it('generates CREATE [OR REPLACE] VIEW', () => {
    const v: ViewDef = {
      schema: 'db',
      name: 'v',
      definition: 'SELECT id FROM t -- Kommentar\n;',
      algorithm: 'TEMPTABLE',
      definer: 'root@localhost',
      security: 'INVOKER',
      checkOption: 'CASCADED',
      columns: ['x']
    };
    expect(createViewSql(v, { orReplace: true })).toBe(
      'CREATE OR REPLACE ALGORITHM = TEMPTABLE DEFINER = `root`@`localhost` SQL SECURITY INVOKER VIEW `db`.`v` (`x`) AS\nSELECT id FROM t -- Kommentar\nWITH CASCADED CHECK OPTION'
    );
    expect(createViewSql({ ...v, algorithm: '', definer: '', security: '', checkOption: '', columns: [] })).toBe('CREATE VIEW `db`.`v` AS\nSELECT id FROM t -- Kommentar');
  });
});

// ───────────── routines ─────────────

describe('stored routines', () => {
  it('parses parameters and return type from SHOW CREATE output', () => {
    const create =
      "CREATE DEFINER=`root`@`localhost` FUNCTION `f1`(`p a` VARCHAR(20) CHARSET latin1, p2 DECIMAL(10,2)) RETURNS varchar(50) CHARSET utf8mb4 COLLATE utf8mb4_bin\n    NO SQL\n    DETERMINISTIC\n    SQL SECURITY INVOKER\n    COMMENT 'it''s a test'\nRETURN CONCAT(`p a`, p2)";
    expect(parseRoutineHeader(create, 'FUNCTION', 'RETURN CONCAT(`p a`, p2)')).toEqual({
      name: 'f1',
      params: [
        { mode: '', name: 'p a', type: 'VARCHAR(20) CHARSET latin1' },
        { mode: '', name: 'p2', type: 'DECIMAL(10,2)' }
      ],
      returns: 'varchar(50) CHARSET utf8mb4 COLLATE utf8mb4_bin'
    });
    const proc = 'CREATE DEFINER=`root`@`localhost` PROCEDURE `p1`(IN a INT, OUT b INT, INOUT c VARCHAR(10))\n    MODIFIES SQL DATA\nBEGIN\n  SELECT a;\nEND';
    expect(parseRoutineHeader(proc, 'PROCEDURE', 'BEGIN\n  SELECT a;\nEND')!.params).toEqual([
      { mode: 'IN', name: 'a', type: 'INT' },
      { mode: 'OUT', name: 'b', type: 'INT' },
      { mode: 'INOUT', name: 'c', type: 'VARCHAR(10)' }
    ]);
    expect(parseRoutineHeader('CREATE DEFINER=`root`@`localhost` PROCEDURE `p2`()\nSELECT 1', 'PROCEDURE', 'SELECT 1')).toEqual({ name: 'p2', params: [], returns: '' });
    expect(parseRoutineHeader('CREATE FUNCTION f() RETURNS INT DETERMINISTIC RETURN 1', 'FUNCTION')!.returns).toBe('INT');
  });

  it('generates CREATE FUNCTION / PROCEDURE', () => {
    const f: RoutineDef = {
      schema: 'db',
      name: 'f',
      type: 'FUNCTION',
      params: [{ mode: 'IN', name: 'p a', type: 'INT' }],
      returns: 'VARCHAR(10)',
      body: 'RETURN CONCAT(`p a`, "x")',
      definer: 'root@localhost',
      security: 'INVOKER',
      dataAccess: 'NO SQL',
      deterministic: true,
      comment: "it's"
    };
    expect(createRoutineSql(f)).toBe(
      "CREATE DEFINER = `root`@`localhost` FUNCTION `db`.`f`(`p a` INT) RETURNS VARCHAR(10)\n    COMMENT 'it\\'s'\n    DETERMINISTIC\n    NO SQL\n    SQL SECURITY INVOKER\nRETURN CONCAT(`p a`, \"x\")"
    );
    const p: RoutineDef = { ...f, type: 'PROCEDURE', name: 'p', params: [{ mode: 'OUT', name: 'r', type: 'INT' }], returns: '', body: 'BEGIN\n  SET r = 1;\nEND', definer: '', security: '', dataAccess: '', deterministic: false, comment: '' };
    expect(createRoutineSql(p)).toBe('CREATE PROCEDURE `db`.`p`(OUT `r` INT)\nBEGIN\n  SET r = 1;\nEND');
  });
});

// ───────────── events ─────────────

describe('events', () => {
  const ev: EventDef = {
    schema: 'db',
    name: 'e',
    scheduleType: 'EVERY',
    at: '',
    atIntervals: [],
    every: { value: '1:30', unit: 'HOUR_MINUTE' },
    starts: '2030-01-01 00:00:00',
    startsIntervals: [{ value: '1', unit: 'DAY' }],
    ends: '',
    endsIntervals: [],
    status: 'ENABLE',
    preserve: false,
    definer: '',
    comment: '',
    body: 'DELETE FROM log WHERE ts < NOW() - INTERVAL 7 DAY'
  };

  it('builds schedules', () => {
    expect(eventScheduleSql(ev)).toBe("EVERY '1:30' HOUR_MINUTE STARTS '2030-01-01 00:00:00' + INTERVAL 1 DAY");
    expect(eventScheduleSql({ ...ev, scheduleType: 'AT', at: 'current_timestamp', atIntervals: [{ value: '2', unit: 'HOUR' }] })).toBe(
      'AT CURRENT_TIMESTAMP + INTERVAL 2 HOUR'
    );
    expect(eventScheduleSql({ ...ev, every: { value: '5', unit: 'MINUTE' }, starts: '', ends: "2031-01-01 00:00:00'" })).toBe(
      "EVERY 5 MINUTE ENDS '2031-01-01 00:00:00\\''"
    );
  });

  it('generates CREATE EVENT with version specific status keywords', () => {
    expect(createEventSql({ ...ev, comment: "it's", definer: 'root@localhost' })).toBe(
      "CREATE DEFINER = `root`@`localhost` EVENT `db`.`e`\nON SCHEDULE EVERY '1:30' HOUR_MINUTE STARTS '2030-01-01 00:00:00' + INTERVAL 1 DAY\nON COMPLETION NOT PRESERVE\nENABLE\nCOMMENT 'it\\'s'\nDO DELETE FROM log WHERE ts < NOW() - INTERVAL 7 DAY"
    );
    expect(createEventSql({ ...ev, status: 'DISABLE ON SLAVE' }, { serverType: 'mysql', serverVersion: 80411 })).toContain('\nDISABLE ON REPLICA\n');
    expect(createEventSql({ ...ev, status: 'DISABLE ON SLAVE' }, { serverType: 'mysql', serverVersion: 80021 })).toContain('\nDISABLE ON SLAVE\n');
    expect(createEventSql({ ...ev, status: 'DISABLE ON SLAVE' }, { serverType: 'mariadb', serverVersion: 101106 })).toContain('\nDISABLE ON SLAVE\n');
  });

  it('alters only changed clauses in the order MySQL requires', () => {
    expect(alterEventSql(ev, { ...ev })).toBeNull();
    expect(alterEventSql(ev, { ...ev, name: 'e2', status: 'DISABLE', comment: 'x', body: 'SELECT 1' })).toBe(
      "ALTER EVENT `db`.`e`\nRENAME TO `db`.`e2`\nDISABLE\nCOMMENT 'x'\nDO SELECT 1"
    );
    expect(alterEventSql(ev, { ...ev, every: { value: '2', unit: 'DAY' }, starts: '', preserve: true })).toBe(
      'ALTER EVENT `db`.`e`\nON SCHEDULE EVERY 2 DAY\nON COMPLETION PRESERVE'
    );
    expect(alterEventSql({ ...ev, definer: 'root@localhost' }, { ...ev, definer: 'app@%' })).toBe('ALTER DEFINER = `app`@`%` EVENT `db`.`e`\nON COMPLETION NOT PRESERVE');
  });

  it('maps information_schema rows', () => {
    const e = eventDefFromInfo('db', {
      name: 'e2',
      eventType: 'RECURRING',
      executeAt: null,
      intervalValue: "'1:30'",
      intervalField: 'HOUR_MINUTE',
      starts: '2030-01-02 00:00:00',
      ends: null,
      status: 'REPLICA_SIDE_DISABLED',
      onCompletion: 'NOT PRESERVE',
      definer: 'root@localhost',
      comment: '',
      body: 'SELECT 1'
    });
    expect(e).toMatchObject({ scheduleType: 'EVERY', every: { value: '1:30', unit: 'HOUR_MINUTE' }, starts: '2030-01-02 00:00:00', ends: '', status: 'DISABLE ON SLAVE', preserve: false });
    expect(eventScheduleSql(e)).toBe("EVERY '1:30' HOUR_MINUTE STARTS '2030-01-02 00:00:00'");
  });
});

describe('routine loading and execution', () => {
  it('parses complete SHOW CREATE output', () => {
    const f = parseCreateRoutine(
      "CREATE DEFINER=`root`@`localhost` FUNCTION `f1`(`p a` VARCHAR(20) CHARSET latin1, p2 DECIMAL(10,2)) RETURNS varchar(50) CHARSET utf8mb4 COLLATE utf8mb4_bin\n    NO SQL\n    DETERMINISTIC\n    SQL SECURITY INVOKER\n    COMMENT 'it''s a test'\nRETURN CONCAT(`p a`, p2)",
      'FUNCTION'
    );
    expect(f).toEqual({
      name: 'f1',
      type: 'FUNCTION',
      params: [
        { mode: '', name: 'p a', type: 'VARCHAR(20) CHARSET latin1' },
        { mode: '', name: 'p2', type: 'DECIMAL(10,2)' }
      ],
      returns: 'varchar(50) CHARSET utf8mb4 COLLATE utf8mb4_bin',
      body: 'RETURN CONCAT(`p a`, p2)',
      definer: 'root@localhost',
      security: 'INVOKER',
      dataAccess: 'NO SQL',
      deterministic: true,
      comment: "it's a test"
    });
    const p = parseCreateRoutine('CREATE DEFINER=`root`@`localhost` PROCEDURE `p2`()\nSELECT 1', 'PROCEDURE');
    expect(p).toMatchObject({ name: 'p2', params: [], body: 'SELECT 1', dataAccess: '', security: '' });
    const r: RoutineDef = { ...f!, schema: 'db' };
    expect(parseCreateRoutine(createRoutineSql(r), 'FUNCTION')).toEqual(f);
  });

  it('builds call scripts with typed literals and output variables', () => {
    const params = [
      { mode: 'IN' as const, name: 'a', type: 'INT UNSIGNED' },
      { mode: 'OUT' as const, name: 'b', type: 'INT' },
      { mode: 'INOUT' as const, name: 'c', type: 'VARCHAR(10)' },
      { mode: 'IN' as const, name: 'd', type: 'DATE' }
    ];
    expect(
      routineCallScript({ schema: 'db', name: 'p', type: 'PROCEDURE', params }, [
        { value: '21', isNull: false, raw: false },
        { value: '', isNull: false, raw: false },
        { value: "it's", isNull: false, raw: false },
        { value: 'CURDATE()', isNull: false, raw: true }
      ])
    ).toEqual(['SET @_ks_p2 = NULL', "SET @_ks_p3 = 'it\\'s'", 'CALL `db`.`p`(21, @_ks_p2, @_ks_p3, CURDATE())', 'SELECT @_ks_p2 AS `b`, @_ks_p3 AS `c`']);
    expect(
      routineCallScript({ schema: 'db', name: 'f', type: 'FUNCTION', params: [{ mode: '', name: 'x', type: 'DECIMAL(5,2)' }, { mode: '', name: 'y', type: 'TEXT' }] }, [
        { value: '1.5', isNull: false, raw: false },
        { value: '', isNull: true, raw: false }
      ])
    ).toEqual(['SELECT `db`.`f`(1.5, NULL) AS `f`']);
  });
});

describe('refineDesignFromDdl', () => {
  it('takes expressions from SHOW CREATE TABLE and fixes loader artefacts', () => {
    const create =
      'CREATE TABLE `e1` (\n' +
      '  `id` int NOT NULL,\n' +
      "  `c` varchar(20) DEFAULT (concat(_utf8mb4'a',_utf8mb4'b')),\n" +
      "  `d` varchar(40) GENERATED ALWAYS AS (concat(`c`,_utf8mb4'x\\'y')) VIRTUAL,\n" +
      '  `ts` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n' +
      '  `g` point NOT NULL /*!80003 SRID 4326 */,\n' +
      '  PRIMARY KEY (`id`),\n' +
      "  KEY `fx` ((concat(`c`,_utf8mb4'it\\'s'))),\n" +
      '  KEY `fy` (`c`,(length(`c`)) DESC),\n' +
      '  SPATIAL KEY `sp` (`g`)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    const d = table({
      fields: [
        int('id', { notNull: true }),
        vc('c', '20', { defaultKind: 'expression', defaultValue: "concat(_utf8mb4\\'a\\',_utf8mb4\\'b\\')", generated: true }),
        vc('d', '40', { generated: true, generatedExpr: "concat(`c`,_utf8mb4\\'x\\\\\\'y\\')" }),
        fld('ts', { type: 'DATETIME', length: '', notNull: true, defaultKind: 'expression', defaultValue: 'CURRENT_TIMESTAMP', generated: true }),
        fld('g', { type: 'POINT', length: '', notNull: true, srid: '4326' })
      ],
      primaryKey: ['id'],
      indexes: [
        ix('fx', [], { fields: [{ name: '', subPart: '', order: '', expr: "concat(`c`,_utf8mb4\\'it\\\\\\'s\\')" }] }),
        ix('fy', [], { fields: [{ name: 'c', subPart: '', order: '' }, { name: '', subPart: '', order: 'DESC', expr: 'length(`c`)' }] }),
        ix('sp', ['g'], { type: 'SPATIAL', fields: [{ name: 'g', subPart: '32', order: '' }] })
      ]
    });
    const r = refineDesignFromDdl(d, create);
    expect(r.fields[1]).toMatchObject({ defaultValue: "concat(_utf8mb4'a',_utf8mb4'b')", generated: false });
    expect(r.fields[2]).toMatchObject({ generatedExpr: "concat(`c`,_utf8mb4'x\\'y')", generated: true });
    expect(r.fields[3]).toMatchObject({ defaultValue: 'CURRENT_TIMESTAMP', generated: false });
    expect(r.indexes[0].fields[0].expr).toBe("concat(`c`,_utf8mb4'it\\'s')");
    expect(r.indexes[1].fields[1].expr).toBe('length(`c`)');
    expect(r.indexes[2].fields[0].subPart).toBe('');
    expect(columnDefinition(r.fields[1])).toBe("`c` VARCHAR(20) NULL DEFAULT (concat(_utf8mb4'a',_utf8mb4'b'))");
  });
});
