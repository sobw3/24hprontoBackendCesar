const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false 
  }
});

// Log para você ver no terminal da Render se ele tentou conectar
console.log("🛠️ Tentando conectar com rejectUnauthorized: false...");

module.exports = pool;
