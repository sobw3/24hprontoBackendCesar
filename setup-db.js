// setup-db.js
// Rode scripts SQL manualmente no painel do PostgreSQL/Render ou use este runner com DATABASE_URL.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

const file = process.argv[2];
if (!file) {
  console.error('Uso: node setup-db.js migrations/2026_06_29_cielo_unlock.sql');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não configurada.');
  process.exit(1);
}

const sqlPath = path.resolve(file);
const sql = fs.readFileSync(sqlPath, 'utf8');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    await client.connect();
    await client.query(sql);
    console.log(`Migração executada com sucesso: ${sqlPath}`);
  } catch (error) {
    console.error('Erro ao executar migração:', error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
