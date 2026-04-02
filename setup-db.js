const { Client } = require('pg');

const connectionString = "postgresql://bancoown_user:XS6MaSiilRsUzGp7tSeihw5kpf2ESVhr@dpg-d76ulg0ule4c7396n1a0-a/bancoown";

const client = new Client({ 
    connectionString,
    ssl: {
        rejectUnauthorized: false // <--- ESSA É A CHAVE MÁGICA
    }
});

const sql = `
-- 1. Tabelas Base
CREATE TABLE IF NOT EXISTS condominiums (id SERIAL PRIMARY KEY, name VARCHAR(255), address VARCHAR(255));
CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, name VARCHAR(255), sale_price DECIMAL(10,2));
CREATE TABLE IF NOT EXISTS inventory (id SERIAL PRIMARY KEY, product_id INTEGER);
CREATE TABLE IF NOT EXISTS order_items (id SERIAL PRIMARY KEY, sale_price DECIMAL(10,2));

-- 2. Injeção de Colunas Faltantes
ALTER TABLE condominiums ADD COLUMN IF NOT EXISTS fridge_id VARCHAR(50);
ALTER TABLE condominiums ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 0;

ALTER TABLE inventory ADD COLUMN IF NOT EXISTS nearest_expiration_date DATE;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 0;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS fridge_id VARCHAR(50);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS price_at_purchase DECIMAL(10,2);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cost_at_purchase DECIMAL(10,2);
`;

async function executar() {
    try {
        console.log("🚀 Iniciando conexão hacker (com bypass de SSL)...");
        await client.connect();
        console.log("✅ Conectado! Rodando as queries...");
        await client.query(sql);
        console.log("💎 SUCESSO! O banco foi atualizado com todas as colunas.");
    } catch (err) {
        console.error("❌ ERRO NO PROCESSO:", err.message);
    } finally {
        await client.end();
        process.exit();
    }
}

executar();
