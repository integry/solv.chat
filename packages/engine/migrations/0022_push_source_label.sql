-- Named push sources: `solv push --source <label>` writes to, and prunes, its
-- own push source, so two repositories pushing into one assistant never
-- delete each other's documents. At most one per label per assistant, so two
-- first pushes racing each other converge on one row. The default push source
-- (is_default = 1, used when a push names no source) is unaffected.
CREATE UNIQUE INDEX sources_push_label
  ON sources(org_id, assistant_id, label)
  WHERE kind = 'push' AND is_default = 0;
