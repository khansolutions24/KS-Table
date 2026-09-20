import { describe, expect, it } from 'vitest';
import {
  createdObjectName,
  definerOf,
  identText,
  needsDelimiter,
  normalizeDdlText,
  qualifiedRefs,
  renameCreate,
  requalify,
  scriptStatement,
  stripDefiner,
  tokenizeSqlText,
  withOrReplace
} from '../sqlText';

const VIEW =
  "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `ks_shop`.`v_active_products` AS select `ks_shop`.`products`.`id` AS `id` from `ks_shop`.`products` where (`ks_shop`.`products`.`status` = 'active') WITH CASCADED CHECK OPTION";
const FUNC =
  "CREATE DEFINER=`root`@`localhost` FUNCTION `fn_full_name`(p_first VARCHAR(50), p_last VARCHAR(50)) RETURNS varchar(101) CHARSET utf8mb4\n    NO SQL\n    DETERMINISTIC\nRETURN CONCAT_WS(' ', p_first, p_last)";
const TRIG = 'CREATE DEFINER=`root`@`localhost` TRIGGER `trg_customers_bi` BEFORE INSERT ON `customers` FOR EACH ROW SET NEW.country = UPPER(NEW.country)';
const EVENT =
  "CREATE DEFINER=`root`@`localhost` EVENT `ev_purge_audit_log` ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 03:00:00' ON COMPLETION PRESERVE ENABLE COMMENT 'Alte Audit-Einträge löschen' DO DELETE FROM audit_log WHERE changed_at < NOW() - INTERVAL 90 DAY";

describe('tokenizeSqlText', () => {
  it('keeps quoted identifiers, strings and comments intact', () => {
    const toks = tokenizeSqlText("SELECT `a``b`, 'it''s \\' x', \"q\" -- c\n/* d */ Grün");
    const types = toks.filter((t) => t.type !== 'ws').map((t) => t.type);
    expect(types).toEqual(['word', 'qid', 'punct', 'string', 'punct', 'string', 'comment', 'comment', 'word']);
    expect(identText(toks.find((t) => t.type === 'qid')!)).toBe('a`b');
    expect(toks[toks.length - 1].text).toBe('Grün');
  });
});

describe('stripDefiner / definerOf', () => {
  it('removes backtick quoted definers of all object kinds', () => {
    expect(stripDefiner(VIEW)).toBe(
      "CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `ks_shop`.`v_active_products` AS select `ks_shop`.`products`.`id` AS `id` from `ks_shop`.`products` where (`ks_shop`.`products`.`status` = 'active') WITH CASCADED CHECK OPTION"
    );
    expect(stripDefiner(FUNC).startsWith('CREATE FUNCTION `fn_full_name`(')).toBe(true);
    expect(stripDefiner(TRIG).startsWith('CREATE TRIGGER `trg_customers_bi` BEFORE')).toBe(true);
    expect(stripDefiner(EVENT).startsWith('CREATE EVENT `ev_purge_audit_log` ON SCHEDULE')).toBe(true);
    expect(definerOf(FUNC)).toBe('`root`@`localhost`');
  });
  it('handles other account notations', () => {
    expect(stripDefiner("CREATE DEFINER='app'@'%' PROCEDURE p() SELECT 1")).toBe('CREATE PROCEDURE p() SELECT 1');
    expect(stripDefiner('CREATE DEFINER = CURRENT_USER() FUNCTION f() RETURNS INT RETURN 1')).toBe('CREATE FUNCTION f() RETURNS INT RETURN 1');
    expect(stripDefiner('CREATE DEFINER=root@localhost EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1')).toBe(
      'CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1'
    );
    expect(stripDefiner('CREATE `x` AS SELECT 1')).toBe('CREATE `x` AS SELECT 1');
  });
});

describe('renameCreate', () => {
  it('qualifies routines, events and views', () => {
    expect(renameCreate(stripDefiner(FUNC), 'ks_t', 'fn_full_name').startsWith('CREATE FUNCTION `ks_t`.`fn_full_name`(p_first')).toBe(true);
    expect(renameCreate(EVENT, 'ks_t', 'EV').includes('EVENT `ks_t`.`EV` ON SCHEDULE')).toBe(true);
    expect(renameCreate(VIEW, 'tgt', 'v2').includes('VIEW `tgt`.`v2` AS select')).toBe(true);
    expect(renameCreate(VIEW, '', 'v2').includes('VIEW `v2` AS select')).toBe(true);
  });
  it('renames trigger and its table', () => {
    expect(renameCreate(TRIG, 'ks_t', 'trg', 'kunden')).toBe(
      'CREATE DEFINER=`root`@`localhost` TRIGGER `ks_t`.`trg` BEFORE INSERT ON `ks_t`.`kunden` FOR EACH ROW SET NEW.country = UPPER(NEW.country)'
    );
    expect(createdObjectName(TRIG)).toEqual(['trg_customers_bi']);
    expect(createdObjectName(VIEW)).toEqual(['ks_shop', 'v_active_products']);
  });
});

describe('requalify', () => {
  it('replaces schema qualifiers but not strings', () => {
    const sql = "select `ks_shop`.`products`.`id` from `ks_shop`.`products` where x = 'ks_shop.products' and ks_shop.orders.id = 1";
    expect(requalify(sql, 'ks_shop', 'ks_t')).toBe(
      "select `ks_t`.`products`.`id` from `ks_t`.`products` where x = 'ks_shop.products' and `ks_t`.orders.id = 1"
    );
  });
  it('removes qualifiers and maps names', () => {
    const sql = 'select `ks_shop`.`Products`.`id` from `ks_shop`.`Products`';
    expect(requalify(sql, 'ks_shop', '')).toBe('select `Products`.`id` from `Products`');
    expect(requalify(sql, 'KS_SHOP', 'tgt', { mapName: (n) => n.toLowerCase() })).toBe('select `tgt`.`products`.`id` from `tgt`.`products`');
    expect(requalify(sql, 'KS_SHOP', 'tgt', { caseInsensitive: false })).toBe(sql);
  });
  it('collects referenced names', () => {
    expect([...qualifiedRefs(VIEW, 'ks_shop')]).toEqual(['v_active_products', 'products']);
  });
});

describe('script helpers', () => {
  it('adds OR REPLACE once', () => {
    expect(withOrReplace('CREATE VIEW v AS SELECT 1')).toBe('CREATE OR REPLACE VIEW v AS SELECT 1');
    expect(withOrReplace('CREATE OR REPLACE VIEW v AS SELECT 1')).toBe('CREATE OR REPLACE VIEW v AS SELECT 1');
  });
  it('wraps stored programs in DELIMITER blocks', () => {
    expect(needsDelimiter(FUNC)).toBe(true);
    expect(needsDelimiter(TRIG)).toBe(true);
    expect(needsDelimiter(VIEW)).toBe(false);
    expect(needsDelimiter('CREATE TABLE t (id INT)')).toBe(false);
    expect(scriptStatement('DROP TABLE t;')).toBe('DROP TABLE t;\n');
    expect(scriptStatement(TRIG)).toBe(`DELIMITER ;;\n${TRIG};;\nDELIMITER ;\n`);
  });
  it('normalizes line endings and trailing blanks', () => {
    expect(normalizeDdlText('a  \r\nb\t\r\n\r\n')).toBe('a\nb');
  });
});
