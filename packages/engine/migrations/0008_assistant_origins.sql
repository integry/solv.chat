-- One row per allowed Origin, so a CORS preflight (which carries no key) is
-- answered from an index inside one org instead of a json_each scan over
-- every assistant. `assistants.allowed_origins` stays the value the admin
-- reads and writes; the triggers below keep this table in step with it on
-- every write path, so no caller can forget to.
CREATE TABLE assistant_origins (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  assistant_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  PRIMARY KEY (org_id, origin, assistant_id),
  FOREIGN KEY (org_id, assistant_id) REFERENCES assistants(org_id, id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO assistant_origins (org_id, assistant_id, origin)
SELECT a.org_id, a.id, allowed.value
  FROM assistants AS a, json_each(a.allowed_origins) AS allowed
 WHERE json_valid(a.allowed_origins) AND allowed.type = 'text';

CREATE TRIGGER assistant_origins_after_insert AFTER INSERT ON assistants
WHEN json_valid(NEW.allowed_origins)
BEGIN
  INSERT OR IGNORE INTO assistant_origins (org_id, assistant_id, origin)
  SELECT NEW.org_id, NEW.id, allowed.value
    FROM json_each(NEW.allowed_origins) AS allowed
   WHERE allowed.type = 'text';
END;

CREATE TRIGGER assistant_origins_after_update AFTER UPDATE OF allowed_origins ON assistants
BEGIN
  DELETE FROM assistant_origins WHERE org_id = OLD.org_id AND assistant_id = OLD.id;
  INSERT OR IGNORE INTO assistant_origins (org_id, assistant_id, origin)
  SELECT NEW.org_id, NEW.id, allowed.value
    FROM json_each(CASE WHEN json_valid(NEW.allowed_origins) THEN NEW.allowed_origins ELSE '[]' END) AS allowed
   WHERE allowed.type = 'text';
END;
