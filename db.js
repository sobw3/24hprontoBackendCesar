const { Pool } = require('pg');
require('dotenv').config();

const isProduction = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}`,
  ssl: isProduction 
    ? { rejectUnauthorized: false } 
    : false
});

// Teste imediato de conexão
pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ ERRO DE CONEXÃO NO DB.JS:', err.stack);
  }
  console.log('✅ Conectado ao banco de dados com sucesso!');
  release();
});

module.exports = pool;
