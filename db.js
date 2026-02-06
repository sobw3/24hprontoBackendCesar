// ARQUIVO: db.js (VERSÃO FINAL HÍBRIDA - LOCAL E PRODUÇÃO)

const { Pool } = require('pg');
require('dotenv').config();

let config;

// Verifica se a DATABASE_URL está disponível (para ambientes de produção como o Render)
if (process.env.DATABASE_URL) {
    console.log('A conectar à base de dados de produção...');
    config = {
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false // Exigido pelo Render
        }
    };
} else {
    // Caso contrário, usa a configuração para a base de dados local
    console.log('A conectar à base de dados local...');
    config = {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_DATABASE,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
    };
}

const pool = new Pool(config);

// Testa a conexão ao iniciar
pool.connect()
    .then(() => console.log('Conexão com a base de dados estabelecida com sucesso.'))
    .catch(err => console.error('ERRO AO CONECTAR À BASE DE DADOS:', err));

module.exports = pool;
