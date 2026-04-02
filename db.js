const { Pool } = require('pg');
require('dotenv').config();

// Configuração de conexão
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? {
    rejectUnauthorized: false // <--- ESSA LINHA MATA O ERRO "SELF-SIGNED CERTIFICATE"
  } : false
});

// Log de monitoramento no terminal da Render
pool.on('connect', () => {
  console.log('✅ Banco de Dados: Conexão estabelecida com sucesso!');
});

pool.on('error', (err) => {
  console.error('❌ Banco de Dados: Erro inesperado!', err);
});

module.exports = pool;
