-- The Conversations search folds final sigma "ς" to "σ" on both sides, so an
-- uppercase prefix such as "ΚΌΣ" (which lowercases to "κός") still finds
-- "κόσμος". Text folded before that keeps "ς"; fold it the same way. Rows
-- 0019 folded in SQL are ASCII and have none. One statement, reading the
-- table once. It writes only `search_text`, so 0019's trigger does not fire.
UPDATE messages SET search_text = replace(search_text, 'ς', 'σ')
WHERE instr(search_text, 'ς') > 0;
