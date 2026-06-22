-- Atualizações seguras para bases antigas do SmartFridge/Daniel Marques Market
-- Execute apenas se seu banco ainda não tiver alguma coluna/tabela usada pelo sistema.

ALTER TABLE condominiums ADD COLUMN IF NOT EXISTS fridge_id VARCHAR(255);
ALTER TABLE condominiums ADD COLUMN IF NOT EXISTS monthly_fixed_cost NUMERIC(10,2) DEFAULT 0;

ALTER TABLE users ADD COLUMN IF NOT EXISTS apartment VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(10,2) DEFAULT 0;

ALTER TABLE products ADD COLUMN IF NOT EXISTS promotional_price NUMERIC(10,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS promotion_start_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS promotion_end_date TIMESTAMP WITH TIME ZONE;

ALTER TABLE inventory ADD COLUMN IF NOT EXISTS nearest_expiration_date DATE;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fridge_id VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS door_opened_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_gateway_id VARCHAR(255);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cost_at_purchase NUMERIC(10,2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS unlock_commands (
    id SERIAL PRIMARY KEY,
    fridge_id VARCHAR(255) NOT NULL,
    order_id INTEGER NULL,
    is_processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS operating_expenses (
    id SERIAL PRIMARY KEY,
    condo_id INTEGER REFERENCES condominiums(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    due_date DATE,
    status VARCHAR(30) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_action_logs (
    id SERIAL PRIMARY KEY,
    admin_identifier VARCHAR(255),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100),
    entity_id VARCHAR(100),
    reason TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
