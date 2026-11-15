-- The header name an owner's MCP server expects its credential in
-- (`Authorization`, `x-api-key`, ...). The value itself lives encrypted in
-- secret_ciphertext; the name is not a secret and is shown back on the screen.
ALTER TABLE mcp_servers ADD COLUMN header_name TEXT;
