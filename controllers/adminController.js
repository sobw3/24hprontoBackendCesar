// controllers/adminController.js

const pool = require('../db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createSystemTicket } = require('./ticketController'); 

// --- LOGIN ADMIN ---
exports.loginAdmin = async (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
        const payload = { id: 'admin', username: username, isAdmin: true };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
        res.json({ message: 'Login de admin bem-sucedido!', token });
    } else {
        res.status(401).json({ message: 'Credenciais de admin inválidas' });
    }
};

// --- GESTÃO DE CONDOMÍNIOS ---
exports.createCondominium = async (req, res) => {
    const { name, address, syndic_name, syndic_contact, syndic_profit_percentage, initial_investment, monthly_fixed_cost, fridge_id } = req.body;
    try {
        const newCondo = await pool.query(
            "INSERT INTO condominiums (name, address, syndic_name, syndic_contact, syndic_profit_percentage, initial_investment, monthly_fixed_cost, fridge_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
            [name, address, syndic_name, syndic_contact, syndic_profit_percentage, initial_investment, monthly_fixed_cost, fridge_id]
        );
        res.status(201).json(newCondo.rows[0]);
    } catch (error) { res.status(500).json({ message: error.message }); }
};

exports.getCondominiums = async (req, res) => {
    try {
        const query = `
            SELECT 
                c.*, 
                COUNT(u.id)::int AS user_count,
                COALESCE(SUM(i.quantity), 0)::int AS item_count
            FROM condominiums c
            LEFT JOIN users u ON c.id = u.condo_id
            LEFT JOIN inventory i ON c.id = i.condo_id
            GROUP BY c.id
            ORDER BY c.name ASC;
        `;
        const allCondos = await pool.query(query);
        res.status(200).json(allCondos.rows);
    } catch (error) { res.status(500).json({ message: error.message }); }
};

exports.updateCondominium = async (req, res) => {
    const { id } = req.params;
    const { name, address, syndic_name, syndic_contact, syndic_profit_percentage, initial_investment, monthly_fixed_cost, fridge_id } = req.body;
    try {
        const updatedCondo = await pool.query(
            "UPDATE condominiums SET name = $1, address = $2, syndic_name = $3, syndic_contact = $4, syndic_profit_percentage = $5, initial_investment = $6, monthly_fixed_cost = $7, fridge_id = $8 WHERE id = $9 RETURNING *",
            [name, address, syndic_name, syndic_contact, syndic_profit_percentage, initial_investment, monthly_fixed_cost, fridge_id, id]
        );
        res.status(200).json(updatedCondo.rows[0]);
    } catch (error) { res.status(500).json({ message: error.message }); }
};

// controllers/adminController.js -> SUBSTITUA esta função

exports.deleteCondominium = async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // --- CORREÇÃO DE LÓGICA ---
        // A sua regra de negócios é: "quero conseguir apagar as coisas".
        
        // Passo 1: Encontrar todos os pedidos (orders) associados a esta máquina.
        const ordersResult = await client.query(
            "SELECT id FROM orders WHERE condo_id = $1",
            [id]
        );
        const orderIds = ordersResult.rows.map(o => o.id);

        if (orderIds.length > 0) {
            console.log(`[Delete Condo] Encontrados ${orderIds.length} pedidos. Apagando histórico de vendas...`);
            
            // Passo 2: Apagar os 'order_items' (filhos) primeiro.
            await client.query(
                "DELETE FROM order_items WHERE order_id = ANY($1::int[])",
                [orderIds]
            );

            // Passo 3: Apagar os 'orders' (pais).
            // (A sua tabela 'wallet_transactions' tem 'ON DELETE SET NULL' para 'related_order_id',
            // então o histórico financeiro será mantido, mas perderá o link para o pedido.)
            await client.query(
                "DELETE FROM orders WHERE id = ANY($1::int[])",
                [orderIds]
            );
        }
        
        // Passo 4: Desvincular os usuários (como o usuário não é mais "associado",
        // definimos como NULL para permitir a exclusão do condomínio)
        await client.query('UPDATE users SET condo_id = NULL WHERE condo_id = $1', [id]);
        
        // Passo 5: Limpar o inventário
        await client.query('DELETE FROM inventory WHERE condo_id = $1', [id]);
        
        // Passo 6: Limpar as despesas
        await client.query('DELETE FROM operating_expenses WHERE condo_id = $1', [id]);

        // Passo 7: Apagar o condomínio (Máquina)
        await client.query("DELETE FROM condominiums WHERE id = $1", [id]);

        // --- FIM DA CORREÇÃO ---

        await client.query('COMMIT');
        res.status(200).json({ 
            message: `Máquina (Condomínio) apagada com sucesso. ${orderIds.length} pedidos históricos foram permanentemente removidos.` 
        });
    } catch (error) { 
        await client.query('ROLLBACK');
        console.error("Erro ao apagar condomínio:", error);
        // Retorna o erro real (se houver)
        res.status(400).json({ message: error.message }); 
    } finally {
        client.release();
    }
};

exports.getProducts = async (req, res) => {
    try {
        const { condoId } = req.query;
        let query = '';
        let values = [];

        if (condoId && condoId !== 'all') {
            // Busca produtos para uma máquina específica (com validade e stock exato)
            query = `
                SELECT 
                    p.*, 
                    COALESCE(i.quantity, 0)::int AS global_stock,
                    i.nearest_expiration_date
                FROM products p
                LEFT JOIN inventory i ON p.id = i.product_id AND i.condo_id = $1
                WHERE p.is_archived = false
                ORDER BY p.name ASC;
            `;
            values.push(condoId);
        } else {
            // Busca Geral (Soma todos os stocks e pega a validade mais próxima)
            query = `
                SELECT 
                    p.*, 
                    COALESCE(SUM(i.quantity), 0)::int AS global_stock,
                    MIN(i.nearest_expiration_date) AS nearest_expiration_date
                FROM products p
                LEFT JOIN inventory i ON p.id = i.product_id
                WHERE p.is_archived = false
                GROUP BY p.id
                ORDER BY p.name ASC;
            `;
        }

        const allProducts = await pool.query(query, values);
        res.status(200).json(allProducts.rows);
    } catch (error) { 
        console.error("Erro em getProducts:", error);
        res.status(500).json({ message: error.message }); 
    }
};

exports.createProduct = async (req, res) => {
    // Adicionada 'promotional_price'
    const { name, description, image_url, purchase_price, sale_price, critical_stock_level, promotional_price, promotion_start_date, promotion_end_date, category } = req.body;
    try {
        // --- LÓGICA DE PREÇO AUTOMÁTICO REMOVIDA ---
        const calculatedPromoPrice = promotional_price || null;

        const newProduct = await pool.query(
            `INSERT INTO products (name, description, image_url, purchase_price, sale_price, critical_stock_level, promotional_price, promotion_start_date, promotion_end_date, category) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [name, description, image_url, purchase_price, sale_price, critical_stock_level, calculatedPromoPrice, promotion_start_date || null, promotion_end_date || null, category]
        );
        res.status(201).json(newProduct.rows[0]);
    } catch (error) {
        console.error("Erro ao criar produto:", error);
        res.status(500).json({ message: error.message });
    }
};

exports.updateProduct = async (req, res) => {
    const { id } = req.params;
    // Adicionada 'promotional_price'
    const { name, description, image_url, purchase_price, sale_price, critical_stock_level, promotional_price, promotion_start_date, promotion_end_date, category } = req.body;
    try {
        // --- LÓGICA DE PREÇO AUTOMÁTICO REMOVIDA ---
        const calculatedPromoPrice = promotional_price || null;

        const updatedProduct = await pool.query(
            `UPDATE products SET 
                name = $1, description = $2, image_url = $3, purchase_price = $4, sale_price = $5, 
                critical_stock_level = $6, promotional_price = $7, promotion_start_date = $8, promotion_end_date = $9, category = $10
             WHERE id = $11 RETURNING *`,
            [name, description, image_url, purchase_price, sale_price, critical_stock_level, calculatedPromoPrice, promotion_start_date || null, promotion_end_date || null, category, id]
        );
        res.status(200).json(updatedProduct.rows[0]);
    } catch (error) {
        console.error(`Erro ao atualizar produto ${id}:`, error);
        res.status(500).json({ message: error.message });
    }
};

exports.deleteProduct = async (req, res) => {
    const { id } = req.params;
    try {
        // --- CORREÇÃO: MUDAMOS DE 'DELETE' PARA 'UPDATE' (Arquivamento) ---
        await pool.query(
            "UPDATE products SET is_archived = true WHERE id = $1", 
            [id]
        );
        res.status(200).json({ message: 'Produto arquivado com sucesso. Ele não aparecerá mais na loja ou inventário.' });
    } catch (error) { 
        console.error("Erro ao arquivar produto:", error);
        res.status(500).json({ message: error.message }); 
    }
};

exports.getInventoryByCondo = async (req, res) => {
    const { condoId } = req.query;
    if (!condoId) return res.status(400).json({ message: 'O ID do condomínio é obrigatório.' });

    try {
        const query = `
            SELECT 
                p.id, p.name, p.image_url, p.category, p.critical_stock_level,
                i.quantity, i.nearest_expiration_date
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            WHERE i.condo_id = $1
            ORDER BY p.name ASC
        `;
        const result = await pool.query(query, [condoId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error("Erro ao buscar estoque:", error);
        res.status(500).json({ message: 'Erro ao buscar estoque.' });
    }
};

exports.bulkUpdateInventory = async (req, res) => {
    const { condo_id, items } = req.body;
    if (!condo_id || !items || !Array.isArray(items)) return res.status(400).json({ message: 'Dados inválidos.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const upsertQuery = `
            INSERT INTO inventory (condo_id, product_id, quantity, nearest_expiration_date, last_updated)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (condo_id, product_id) 
            DO UPDATE SET quantity = EXCLUDED.quantity, nearest_expiration_date = EXCLUDED.nearest_expiration_date, last_updated = NOW();
        `;

        for (const item of items) {
            const validDate = item.nearest_expiration_date ? item.nearest_expiration_date : null;
            await client.query(upsertQuery, [condo_id, item.product_id, item.quantity, validDate]);
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Estoque atualizado com sucesso!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Erro no salvamento em massa:", error);
        res.status(500).json({ message: 'Erro ao salvar estoque.' });
    } finally {
        client.release();
    }
};

exports.removeProductFromInventory = async (req, res) => {
    // Usamos req.query para um DELETE simples
    const { condo_id, product_id } = req.query;

    if (!condo_id || !product_id) {
        return res.status(400).json({ message: 'Condo ID e Product ID são obrigatórios.' });
    }

    try {
        // Deleta a linha específica do inventário
        // Isso não afeta o produto global, apenas o remove deste condomínio
        const result = await pool.query(
            "DELETE FROM inventory WHERE condo_id = $1 AND product_id = $2",
            [condo_id, product_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Item do inventário não encontrado para este condomínio.' });
        }

        res.status(200).json({ message: 'Produto removido do inventário deste condomínio com sucesso.' });
    } catch (error) {
        console.error("Erro ao remover produto do inventário:", error);
        res.status(500).json({ message: error.message });
    }
};

exports.updateInventory = async (req, res) => {
    const { condo_id, product_id, quantity } = req.body;
    try {
        const upsertQuery = `
            INSERT INTO inventory (condo_id, product_id, quantity)
            VALUES ($1, $2, $3)
            ON CONFLICT (condo_id, product_id)
            DO UPDATE SET quantity = EXCLUDED.quantity;
        `;
        await pool.query(upsertQuery, [condo_id, product_id, quantity]);
        res.status(200).json({ message: 'Inventário atualizado com sucesso.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
};

exports.bulkUpdateInventory = async (req, res) => {
    const { condo_id, items } = req.body;
    
    if (!condo_id || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: 'Dados de inventário inválidos.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 

        // --- INÍCIO DA ALTERAÇÃO ---
        // A lógica de "DO UPDATE" foi simplificada.
        // Ela agora salva EXATAMENTE o que o frontend manda (seja uma data ou NULL).
        const upsertQuery = `
            INSERT INTO inventory (condo_id, product_id, quantity, nearest_expiration_date, last_updated)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (condo_id, product_id)
            DO UPDATE SET 
                quantity = EXCLUDED.quantity, 
                nearest_expiration_date = EXCLUDED.nearest_expiration_date,
                last_updated = CURRENT_TIMESTAMP;
        `;
        // --- FIM DA ALTERAÇÃO ---

        for (const item of items) {
            const { product_id, quantity, nearest_expiration_date } = item;
            if (product_id === undefined || quantity === undefined || isNaN(parseInt(quantity))) {
                throw new Error('Item inválido na lista: ' + JSON.stringify(item));
            }
            const expirationDate = nearest_expiration_date || null; 
            await client.query(upsertQuery, [condo_id, product_id, parseInt(quantity), expirationDate]);
        }

        await client.query('COMMIT'); 
        res.status(200).json({ message: 'Estoque atualizado com sucesso!' });
        
    } catch (error) {
        await client.query('ROLLBACK'); 
        console.error("Erro no bulk update de inventário:", error);
        res.status(500).json({ message: error.message || 'Erro interno ao atualizar inventário.' });
    } finally {
        client.release();
    }
};

exports.getCriticalStockPage = async (req, res) => {
    const { condoId } = req.query;

    if (!condoId) {
        return res.status(200).json({ criticalStock: [], expiringSoon: [] }); // Retorna objeto vazio
    }

    try {
        // --- QUERY 1: Itens com ESTOQUE CRÍTICO ---
        // (A mesma lógica de antes)
        const criticalStockQuery = `
            SELECT 
                p.id AS product_id,
                p.name AS product_name, 
                i.quantity, 
                c.id AS condo_id,
                c.name AS condo_name, 
                p.critical_stock_level,
                p.purchase_price,
                GREATEST(0, (p.critical_stock_level * 2) - i.quantity) AS suggested_reorder_quantity,
                GREATEST(0, (p.critical_stock_level * 2) - i.quantity) * p.purchase_price AS reorder_cost
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            JOIN condominiums c ON i.condo_id = c.id
            WHERE 
                i.quantity <= p.critical_stock_level
                AND i.condo_id = $1
            ORDER BY p.name;
        `;
        const criticalStockResult = await pool.query(criticalStockQuery, [condoId]);

        // --- QUERY 2: Itens PRÓXIMOS DO VENCIMENTO ---
        // (Busca produtos que vencem nos próximos 30 dias)
        const expiringSoonQuery = `
            SELECT 
                p.id AS product_id,
                p.name AS product_name,
                i.quantity,
                i.nearest_expiration_date
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            WHERE 
                i.condo_id = $1
                AND i.nearest_expiration_date IS NOT NULL
                AND i.nearest_expiration_date BETWEEN NOW() AND (NOW() + INTERVAL '30 days')
            ORDER BY i.nearest_expiration_date ASC;
        `;
        const expiringSoonResult = await pool.query(expiringSoonQuery, [condoId]);

        // --- Retorna os dois resultados separados ---
        res.status(200).json({
            criticalStock: criticalStockResult.rows,
            expiringSoon: expiringSoonResult.rows
        });
        
    } catch (error) {
        console.error("Erro ao buscar estoque crítico e vencimentos:", error);
        res.status(500).json({ message: 'Erro ao buscar estoque crítico e vencimentos.' });
    }
};

exports.getFinancialReport = async (req, res) => {
    const { condoId, startDate, endDate } = req.query;

    try {
        let profitFilter = "";
        let expenseFilter = "";
        const queryParams = [];
        let paramCounter = 1; // 1. Contador de parâmetros

        // Filtro de Condomínio
        if (condoId && condoId !== 'all') {
            queryParams.push(condoId);
            profitFilter += ` WHERE c.id = $${paramCounter}`;
            expenseFilter += ` WHERE o.condo_id = $${paramCounter}`;
            paramCounter++;
        }

        // Filtro de Data (Corrigido para usar o contador)
        if (startDate && endDate) {
            queryParams.push(startDate, endDate);
            const dateStartIndex = paramCounter;
            
            profitFilter += (paramCounter > 1 ? ' AND' : ' WHERE') + ` (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $${dateStartIndex} AND $${dateStartIndex + 1}`;
            expenseFilter += (paramCounter > 1 ? ' AND' : ' WHERE') + ` (o.paid_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $${dateStartIndex} AND $${dateStartIndex + 1}`;
            
            paramCounter += 2;
        }


        // 1. Busca os lucros (baseado nas vendas)
        const profitQuery = `
            SELECT
                c.id, c.name, c.initial_investment, c.syndic_profit_percentage, c.monthly_fixed_cost,
                COALESCE(SUM(oi.price_at_purchase * oi.quantity), 0) AS gross_revenue,
                COALESCE(SUM(oi.cost_at_purchase * oi.quantity), 0) AS cost_of_goods_sold,
                COALESCE(SUM((oi.price_at_purchase - oi.cost_at_purchase) * oi.quantity), 0) AS net_revenue,
                COALESCE(SUM(((oi.price_at_purchase - oi.cost_at_purchase) * oi.quantity) * (c.syndic_profit_percentage / 100.0)), 0) AS syndic_commission
            FROM condominiums c
            LEFT JOIN orders o ON c.id = o.condo_id AND o.status = 'paid'
            LEFT JOIN order_items oi ON o.id = oi.order_id
            ${profitFilter}
            GROUP BY c.id
            ORDER BY c.name;
        `;
        // --- CORREÇÃO: Removido o .filter() ---
        const profitResult = await pool.query(profitQuery, queryParams);

        // 2. Busca as despesas operacionais (PAGAS no período)
        const expenseStatusFilter = (expenseFilter ? ' AND' : ' WHERE') + " o.status = 'paid'";
        
        const expensesQuery = `
            SELECT 
                o.condo_id, 
                COALESCE(SUM(o.amount), 0)::float AS total_expenses
            FROM operating_expenses o
            ${expenseFilter} ${expenseStatusFilter}
            GROUP BY o.condo_id;
        `;
        // --- CORREÇÃO: Removido o .filter() ---
        const expensesResult = await pool.query(expensesQuery, queryParams);
        
        // (Lógica de Despesas Gerais - mantida)
        let generalExpenses = 0; 
        const expensesMap = expensesResult.rows.reduce((map, item) => {
            if (item.condo_id === null) {
                generalExpenses = parseFloat(item.total_expenses);
            } else {
                map[item.condo_id] = parseFloat(item.total_expenses);
            }
            return map;
        }, {});

        // 4. Combina os resultados
        const finalReport = profitResult.rows.map(condo => {
            const expenses = expensesMap[condo.id] || 0;
            const netRevenue = parseFloat(condo.net_revenue);
            const syndicCommission = parseFloat(condo.syndic_commission);
            const finalNetProfit = netRevenue - syndicCommission - expenses;

            return {
                ...condo,
                total_expenses: expenses,
                final_net_profit: finalNetProfit
            };
        });
        
        // Adiciona a linha "Geral" (mantida)
        if (condoId === 'all' && generalExpenses > 0) {
            finalReport.push({
                id: 'general_expenses',
                name: 'Despesas Gerais (Administrativo)',
                initial_investment: 0,
                syndic_profit_percentage: 0,
                monthly_fixed_cost: 0,
                gross_revenue: 0,
                cost_of_goods_sold: 0,
                net_revenue: 0,
                syndic_commission: 0,
                total_expenses: generalExpenses,
                final_net_profit: -generalExpenses 
            });
        }
        
        res.status(200).json(finalReport);

    } catch (error) {
        console.error("Erro ao gerar relatório financeiro:", error);
        res.status(500).json({ message: error.message });
    }
};

// Busca todas as despesas (pendentes e pagas)
exports.getExpenses = async (req, res) => {
    try {
        const query = `
            SELECT 
                o.*, 
                c.name as condo_name 
            FROM operating_expenses o
            LEFT JOIN condominiums c ON o.condo_id = c.id
            ORDER BY o.status ASC, o.due_date ASC;
        `;
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Cria uma nova conta a pagar
exports.createExpense = async (req, res) => {
    // --- ALTERAÇÃO AQUI ---
    const { condo_id, description, amount, due_date, recurrence_type } = req.body;
    try {
        const newExpense = await pool.query(
            // --- ALTERAÇÃO AQUI ---
            "INSERT INTO operating_expenses (condo_id, description, amount, due_date, status, recurrence_type) VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING *",
            [condo_id || null, description, amount, due_date, recurrence_type || null]
        );
        res.status(201).json(newExpense.rows[0]);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Marca uma despesa como paga
exports.markExpenseAsPaid = async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect(); 
    
    try {
        await client.query('BEGIN');

        const result = await client.query(
            "UPDATE operating_expenses SET status = 'paid', paid_at = NOW() WHERE id = $1 RETURNING *",
            [id]
        );

        if (result.rows.length === 0) {
            throw new Error("Despesa não encontrada.");
        }

        const paidExpense = result.rows[0];
        
        // --- INÍCIO DA LÓGICA DE RECORRÊNCIA CORRIGIDA ---
        // 2. Verifica se ela é recorrente
        if (paidExpense.recurrence_type) {
            
            // O Node-PG lê o 'DATE' do banco como um objeto Date em UTC (meia-noite).
            // Precisamos tratar isso com cuidado para evitar bugs de fuso horário.
            const currentDueDate = new Date(paidExpense.due_date);
            
            // Pega os componentes da data EM UTC para ignorar o fuso local
            const year = currentDueDate.getUTCFullYear();
            const month = currentDueDate.getUTCMonth(); // 0-11 (Jan é 0, Out é 9)
            const day = currentDueDate.getUTCDate(); // 1-31

            let newDueDate;

            if (paidExpense.recurrence_type === 'monthly') {
                // Adiciona 1 ao mês (ex: 9 (Out) + 1 = 10 (Nov))
                // Date.UTC() lida corretamente com "overflow" (ex: 31 de Outubro + 1 mês = 1 de Dezembro)
                newDueDate = new Date(Date.UTC(year, month + 1, day));
            } else if (paidExpense.recurrence_type === 'yearly') {
                // Adiciona 1 ao ano
                newDueDate = new Date(Date.UTC(year + 1, month, day));
            }

            // 3. Cria a próxima despesa (clone) como 'pending'
            if (newDueDate) {
                await client.query(
                    "INSERT INTO operating_expenses (condo_id, description, amount, due_date, status, recurrence_type) VALUES ($1, $2, $3, $4, 'pending', $5)",
                    [paidExpense.condo_id, paidExpense.description, paidExpense.amount, newDueDate, paidExpense.recurrence_type]
                );
            }
        }
        // --- FIM DA LÓGICA DE RECORRÊNCIA CORRIGIDA ---

        await client.query('COMMIT');
        res.status(200).json(paidExpense);
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Erro ao marcar despesa como paga:", error); // Log mais detalhado
        res.status(500).json({ message: error.message });
    } finally {
        client.release();
    }
};

// Apaga uma despesa (lançamento errado)
exports.deleteExpense = async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM operating_expenses WHERE id = $1", [id]);
        res.status(200).json({ message: 'Despesa apagada com sucesso.' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};



// --- GESTÃO DE UTILIZADORES ---
exports.getUsersByCondo = async (req, res) => {
    try {
        const query = `
            SELECT c.id, c.name, COUNT(u.id) as user_count 
            FROM condominiums c 
            LEFT JOIN users u ON c.id = u.condo_id 
            GROUP BY c.id 
            ORDER BY c.name;
        `;
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (error) {
        console.error("Erro ao buscar contagem de utilizadores:", error);
        res.status(500).json({ message: 'Erro ao buscar contagem de utilizadores.' });
    }
};

exports.getUsersByCondoPaginated = async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    // --- CONDO ID REMOVIDO DAQUI ---
    const offset = (page - 1) * limit;

    try {
        // --- QUERY CORRIGIDA (Busca TODOS os usuários e junta o nome da máquina) ---
        const usersQuery = `
            SELECT 
                u.id, u.name, u.cpf, u.email, u.apartment, u.wallet_balance, 
                u.phone_number, u.credit_limit, u.credit_used, u.credit_due_day, 
                u.is_active, u.birth_date, 
                c.name as condo_name
            FROM users u
            LEFT JOIN condominiums c ON u.condo_id = c.id
            ORDER BY u.name ASC 
            LIMIT $1 OFFSET $2
        `;
        // --- PARÂMETROS CORRIGIDOS (sem condoId) ---
        const usersResult = await pool.query(usersQuery, [limit, offset]);
        
        // --- QUERY DE TOTAL CORRIGIDA (Conta TODOS os usuários) ---
        const totalQuery = "SELECT COUNT(*)::int FROM users";
        const totalResult = await pool.query(totalQuery);
        // --- FIM DA CORREÇÃO ---

        res.status(200).json({
            users: usersResult.rows,
            pagination: {
                page: page,
                limit: limit,
                total: totalResult.rows[0].count,
                totalPages: Math.ceil(totalResult.rows[0].count / limit) 
            }
        });
    } catch (error) {
        console.error("Erro ao buscar utilizadores:", error);
        res.status(500).json({ message: 'Erro ao buscar utilizadores.' });
    }
};

exports.updateUserByAdmin = async (req, res) => {
    const { id } = req.params;
    const { name, email, apartment, newPassword, birth_date, phone_number } = req.body;
    try {
        let query = 'UPDATE users SET name = $1, email = $2, apartment = $3, birth_date = $4, phone_number = $5';
        const params = [name, email, apartment, birth_date || null, phone_number];
        let paramIndex = 6;
        if (newPassword && newPassword.length >= 6) {
            const salt = await bcrypt.genSalt(10);
            const password_hash = await bcrypt.hash(newPassword, salt);
            query += `, password_hash = $${paramIndex++}`;
            params.push(password_hash);
        }
        query += ` WHERE id = $${paramIndex++} RETURNING *`;
        params.push(id);

        const { rows } = await pool.query(query, params);
        res.status(200).json({ message: 'Utilizador atualizado com sucesso.', user: rows[0] });
    } catch (error) {
        console.error("Erro ao atualizar utilizador:", error);
        res.status(500).json({ message: 'Erro ao atualizar utilizador.' });
    }
};

exports.addWalletBalanceByAdmin = async (req, res) => {
    const { id } = req.params; // ID do usuário que vai receber/perder
    const { amount, reason } = req.body;
    const parsedAmount = parseFloat(amount);

    if (!parsedAmount || isNaN(parsedAmount)) {
        return res.status(400).json({ message: 'Valor inválido.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Atualiza o saldo (Isto já estava funcionando)
        await client.query(
            'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', 
            [parsedAmount, id]
        );
        
        let transactionType;
        let description;
        // --- INÍCIO DA CORREÇÃO (Mensagem do Tiquete) ---
        let ticketMessage;

        if (parsedAmount > 0) {
            // Se for um depósito (positivo)
            transactionType = 'deposit';
            description = `Crédito administrativo: ${reason || 'Adicionado pelo administrador'}`;
            ticketMessage = `Você recebeu um crédito de R$ ${parsedAmount.toFixed(2).replace('.',',')} do administrador. Motivo: ${reason || 'Crédito administrativo'}`;
        } else {
            // Se for um débito (negativo)
            transactionType = 'transfer_out'; 
            description = `Débito administrativo: ${reason || 'Removido pelo administrador'}`;
            ticketMessage = `Um débito de R$ ${Math.abs(parsedAmount).toFixed(2).replace('.',',')} foi realizado pelo administrador. Motivo: ${reason || 'Débito administrativo'}`;
        }
        // --- FIM DA CORREÇÃO ---

        // 2. Insere no Histórico (Isto já estava funcionando)
        await client.query(
            `INSERT INTO wallet_transactions (user_id, type, amount, description) 
             VALUES ($1, $2, $3, $4)`,
            // Usamos Math.abs() para garantir que o 'amount' seja sempre positivo na tabela de transações
            [id, transactionType, Math.abs(parsedAmount), description] 
        );
        
        // --- INÍCIO DA CORREÇÃO (Enviar o Tiquete) ---
        // 3. Envia o tiquete de notificação para o usuário
        await createSystemTicket(id, ticketMessage);
        // --- FIM DA CORREÇÃO ---

        // 4. Confirma a transação
        await client.query('COMMIT');
        res.status(200).json({ message: 'Saldo do usuário ajustado e tiquete enviado com sucesso.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Erro ao ajustar saldo:", error);
        res.status(500).json({ message: 'Erro ao ajustar saldo.' });
    } finally {
        client.release();
    }
};

exports.toggleUserStatus = async (req, res) => {
    const { id } = req.params;
    try {
        const userResult = await pool.query('SELECT is_active FROM users WHERE id = $1', [id]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        const newStatus = !userResult.rows[0].is_active;
        await pool.query('UPDATE users SET is_active = $1 WHERE id = $2', [newStatus, id]);
        res.status(200).json({ message: `Usuário ${newStatus ? 'desbloqueado' : 'bloqueado'} com sucesso.` });
    } catch (error) {
        console.error("Erro ao alterar status do usuário:", error);
        res.status(500).json({ message: 'Erro ao alterar status do usuário.' });
    }
};

// =================================================================
// FUNÇÃO getInventoryAnalysis (ATUALIZADA)
// =================================================================
exports.getInventoryAnalysis = async (req, res) => {
    const { condoId, startDate, endDate } = req.query;
    if (!condoId) {
        return res.status(400).json({ message: 'O ID do condomínio é obrigatório.' });
    }
    try {
        let dateFilter = "";
        const queryParams = [condoId];
        let paramCounter = 1;
        if (startDate && endDate) {
            paramCounter++;
            dateFilter = `AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $${paramCounter} AND $${paramCounter + 1}`;
            queryParams.push(startDate, endDate);
        } else {
            dateFilter = `AND o.created_at >= NOW() - INTERVAL '30 days'`;
        }
        
        // --- QUERY DE ANÁLISE ATUALIZADA ---
        // 'net_profit_in_period' agora usa 'cost_at_purchase'
        const analysisQuery = `
            SELECT
                p.id, p.name, p.image_url, p.purchase_price, p.sale_price, p.critical_stock_level,
                i.quantity AS current_stock,
                (i.quantity * p.purchase_price) AS total_cost_in_stock,
                (i.quantity * (p.sale_price - p.purchase_price)) AS potential_net_profit,
                (
                    SELECT COALESCE(SUM(oi.quantity), 0)::int
                    FROM order_items oi
                    JOIN orders o ON oi.order_id = o.id
                    WHERE oi.product_id = p.id AND o.condo_id = $1 AND o.status = 'paid' ${dateFilter}
                ) AS units_sold_in_period,
                (
                    SELECT COALESCE(SUM(oi.quantity * (oi.price_at_purchase - oi.cost_at_purchase)), 0)
                    FROM order_items oi
                    JOIN orders o ON oi.order_id = o.id
                    WHERE oi.product_id = p.id AND o.condo_id = $1 AND o.status = 'paid' ${dateFilter}
                ) AS net_profit_in_period
            FROM products p
            JOIN inventory i ON p.id = i.product_id
            WHERE i.condo_id = $1
            ORDER BY p.name;
        `;
        const { rows: analysisData } = await pool.query(analysisQuery, queryParams);
        
        const summaryQuery = `
            SELECT
                COALESCE(SUM(i.quantity * p.purchase_price), 0)::float AS total_cost_all_stock,
                COALESCE(SUM(i.quantity * (p.sale_price - p.purchase_price)), 0)::float AS total_potential_profit
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            WHERE i.condo_id = $1;
        `;
        const summaryResult = await pool.query(summaryQuery, [condoId]);

        const topSellers = [...analysisData].sort((a, b) => b.units_sold_in_period - a.units_sold_in_period).slice(0, 3).filter(p => p.units_sold_in_period > 0);
        const topLucrative = [...analysisData].sort((a, b) => b.net_profit_in_period - a.net_profit_in_period).slice(0, 3).filter(p => p.net_profit_in_period > 0);
        const promotionSuggestions = analysisData.filter(p => p.units_sold_in_period === 0 && p.current_stock > 0).slice(0, 3);
            
        const responsePayload = {
            analysis: analysisData,
            summary: summaryResult.rows[0],
            insights: { topSellers, topLucrative, promotionSuggestions }
        };
        res.status(200).json(responsePayload);
    } catch (error) {
        console.error("Erro ao gerar análise de inventário:", error);
        res.status(500).json({ message: 'Erro ao gerar análise de inventário.' });
    }
};

exports.getDashboardStats = async (req, res) => {
    try {
        const { startDate, endDate, condoId } = req.query;

        // ============================================================
        // 1. CONFIGURAÇÃO DE FILTROS (VENDAS E KPIS)
        // ============================================================
        
        // Filtro de DATA
        // Padrão: "1=1" (Sempre verdadeiro), ou seja, busca TODO O PERÍODO se não houver datas.
        let dateWhereClause = "1=1"; 
        const dateParams = [];
        
        // Só aplica filtro de data se AMBAS as datas forem fornecidas
        if (startDate && endDate) {
            dateWhereClause = `(o.created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2`;
            dateParams.push(startDate, endDate);
        }

        // Filtro de CONDOMÍNIO (Para tabelas de Orders)
        let condoWhereClause = "";
        let nextParamIndex = dateParams.length + 1; // Calcula dinamicamente ($1, $2 ou $3)
        const condoParams = [];

        if (condoId && condoId !== 'all') {
            condoWhereClause = `AND o.condo_id = $${nextParamIndex}`;
            condoParams.push(condoId);
        }

        // Junta os parâmetros para usar nas queries de vendas
        const salesQueryParams = [...dateParams, ...condoParams];


        // ============================================================
        // 2. CONFIGURAÇÃO DE FILTRO (ESTOQUE)
        // ============================================================
        
        // O Estoque filtra direto pelo 'condo_id' na tabela inventory.
        
        let inventoryWhere = "";
        const inventoryParams = [];

        if (condoId && condoId !== 'all') {
            inventoryWhere = `WHERE i.condo_id = $1`;
            inventoryParams.push(condoId);
        }


        // ============================================================
        // 3. EXECUÇÃO DAS QUERIES
        // ============================================================

        // --- KPI 1: Financeiro (Faturamento, Pedidos, Lucro) ---
        const kpiQuery = `
            SELECT
                COALESCE(SUM(o.total_amount), 0)::float AS revenue_today,
                COUNT(DISTINCT o.id)::int AS orders_today,
                COALESCE(SUM(oi.quantity * (oi.price_at_purchase - oi.cost_at_purchase)), 0)::float AS net_profit_today
            FROM orders o
            LEFT JOIN order_items oi ON o.id = oi.order_id
            WHERE o.status = 'paid' 
            AND ${dateWhereClause}
            ${condoWhereClause}
        `;
        
        // --- KPI 2: Usuários (Total e Novos) ---
        // Nota: Usuários geralmente são globais, mas filtramos novos pelo dia se necessário.
        // Aqui mantivemos a lógica original de mostrar total geral.
        const userStatsQuery = `
            SELECT
                COUNT(id)::int AS total_users,
                SUM(CASE WHEN created_at >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN 1 ELSE 0 END)::int AS new_users_today
            FROM users
        `;

        // --- KPI 3: Valor de Estoque (Custo e Lucro Potencial) ---
        const inventoryValueQuery = `
            SELECT
                COALESCE(SUM(i.quantity * p.purchase_price), 0)::float AS total_inventory_cost,
                COALESCE(SUM(i.quantity * (p.sale_price - p.purchase_price)), 0)::float AS total_potential_profit_value
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            ${inventoryWhere}
        `;

        // --- KPI 4: Produtos Mais Vendidos ---
        const topSellersQuery = `
            SELECT 
                p.name, 
                p.id, 
                p.image_url,
                COALESCE(SUM(oi.quantity), 0)::int AS units_sold
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            JOIN products p ON oi.product_id = p.id
            WHERE o.status = 'paid' 
            AND ${dateWhereClause}
            ${condoWhereClause}
            GROUP BY p.id, p.name, p.image_url
            HAVING SUM(oi.quantity) > 0
            ORDER BY units_sold DESC
        `;

        // Roda todas as consultas ao mesmo tempo (Promise.all) para ser rápido
        const [kpiRes, userRes, invRes, sellersRes] = await Promise.all([
            pool.query(kpiQuery, salesQueryParams),
            pool.query(userStatsQuery),
            pool.query(inventoryValueQuery, inventoryParams),
            pool.query(topSellersQuery, salesQueryParams)
        ]);

        const salesData = sellersRes.rows;

        // Monta o objeto final para o Frontend
        const stats = {
            ...kpiRes.rows[0],       // revenue_today, orders_today, net_profit_today
            ...userRes.rows[0],      // total_users, new_users_today
            inventory_value: invRes.rows[0], // total_inventory_cost, total_potential_profit_value
            top_sellers: salesData.slice(0, 5),
            least_sellers: salesData.slice(-5).reverse()
        };

        res.status(200).json(stats);

    } catch (error) {
        console.error("Erro Crítico no Dashboard:", error);
        res.status(500).json({ message: 'Erro ao processar dados do dashboard.' });
    }
};

exports.getCriticalStockWidget = async (req, res) => {
    try {
        const { condoId } = req.query; // Para filtrar por condomínio, se aplicável

        // Filtro base: produtos vencendo nos próximos 30 dias
        let filter = "i.nearest_expiration_date IS NOT NULL AND i.nearest_expiration_date BETWEEN NOW() AND (NOW() + INTERVAL '30 days')";
        const params = [];
        
        // Adiciona o filtro de condomínio se ele for fornecido e não for "todos"
        if (condoId && condoId !== 'all') {
            params.push(condoId);
            filter += ` AND i.condo_id = $${params.length}`;
        }

        const query = `
            SELECT 
                p.id, 
                p.name, 
                p.image_url,
                i.quantity,
                i.nearest_expiration_date
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            WHERE ${filter}
            ORDER BY i.nearest_expiration_date ASC
            LIMIT 5; -- Limita a 5 produtos para o widget
        `;
        const result = await pool.query(query, params);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error("Erro ao buscar produtos próximos da validade:", error);
        res.status(500).json({ message: 'Erro ao buscar produtos próximos da validade.' });
    }
};

exports.getLatestOrders = async (req, res) => {
    try {
        const { condoId } = req.query; // Para filtrar por condomínio, se aplicável

        let filter = "o.status = 'paid'";
        const params = [];
        
        // Adiciona o filtro de condomínio se ele for fornecido e não for "todos"
        if (condoId && condoId !== 'all') {
            params.push(condoId);
            filter += ` AND o.condo_id = $${params.length}`;
        }

        // Query atualizada para buscar nomes de produtos (string_agg)
        const query = `
            SELECT 
                o.id, 
                o.total_amount, 
                o.created_at, 
                u.name as user_name,
                SUM(oi.quantity)::int as item_count,
                string_agg(DISTINCT p.name, ', ') AS product_names
            FROM orders o
            JOIN users u ON o.user_id = u.id
            LEFT JOIN order_items oi ON o.id = oi.order_id
            LEFT JOIN products p ON oi.product_id = p.id
            WHERE ${filter}
            GROUP BY o.id, o.total_amount, o.created_at, u.name
            ORDER BY o.created_at DESC
            LIMIT 5; -- Limita a 5 pedidos para o widget
        `;
        
        const result = await pool.query(query, params);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error("Erro ao buscar últimos pedidos:", error);
        res.status(500).json({ message: 'Erro ao buscar últimos pedidos.' });
    }
};

exports.remoteUnlockFridge = async (req, res) => {
    const { fridgeId } = req.params;
    if (!fridgeId) {
        return res.status(400).json({ message: 'O ID da geladeira é obrigatório.' });
    }
    try {
        await pool.query(
            'INSERT INTO unlock_commands (fridge_id) VALUES ($1)',
            [fridgeId]
        );
        console.log(`COMANDO DE DESBLOQUEIO REMOTO GERADO PARA A GELADEIRA: ${fridgeId}`);
        res.status(200).json({ message: 'Comando de desbloqueio enviado com sucesso!' });
    } catch (error) {
        console.error(`Erro ao enviar comando de desbloqueio remoto para ${fridgeId}:`, error);
        res.status(500).json({ message: 'Erro interno ao enviar comando.' });
    }
};

// controllers/adminController.js

exports.refundOrder = async (req, res) => {
    const { orderId } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // (Passo 1: Buscar o condo_id - Sem alteração)
        const orderResult = await client.query(
            "SELECT id, user_id, total_amount, status, condo_id FROM orders WHERE id = $1",
            [orderId]
        );

        if (orderResult.rows.length === 0) throw new Error('Pedido não encontrado.');
        
        const order = orderResult.rows[0];
        
        if (order.status !== 'paid') throw new Error(`Este pedido não pode ser reembolsado (Status atual: ${order.status}).`);

        // (Passo 2: Buscar Itens E SEUS NOMES - Sem alteração)
        const itemsResult = await client.query(
            `SELECT 
                oi.product_id, 
                oi.quantity, 
                p.name as product_name 
             FROM order_items oi
             JOIN products p ON oi.product_id = p.id
             WHERE oi.order_id = $1`,
            [orderId]
        );
        const orderItems = itemsResult.rows;

        // (Passo 3: Devolver itens ao estoque - Sem alteração)
        for (const item of orderItems) {
            await client.query(
                "UPDATE inventory SET quantity = quantity + $1 WHERE product_id = $2 AND condo_id = $3",
                [item.quantity, item.product_id, order.condo_id]
            );
        }

        // (Passo 4: Marcar o pedido como reembolsado - Sem alteração)
        await client.query(
            "UPDATE orders SET status = 'refunded' WHERE id = $1",
            [orderId]
        );
        
        // (Passo 5: Devolver o saldo para a carteira - Sem alteração)
        await client.query(
            "UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2",
            [order.total_amount, order.user_id]
        );
        
        // --- INÍCIO DA CORREÇÃO (Passo 6: Descrição da Transação) ---
        // 1. Construir a lista de nomes de produtos
        const productNames = orderItems.map(item => `${item.quantity}x ${item.product_name}`).join(', ');
        
        // 2. Criar a descrição para o Histórico e Atividade Recente
        const description = `Reembolso (${productNames})`;

        // 3. Registrar a transação de depósito (reembolso) com a NOVA descrição
        await client.query(
            `INSERT INTO wallet_transactions (user_id, type, amount, description, related_order_id) 
             VALUES ($1, 'deposit', $2, $3, $4)`,
            [order.user_id, order.total_amount, description, orderId]
        );
        // --- FIM DA CORREÇÃO ---
        
        
        // (Passo 7: Mensagem do Ticket - Sem alteração, já estava correta)
        const ticketMessage = `O seu pedido (${productNames}) foi reembolsado. O valor de R$ ${parseFloat(order.total_amount).toFixed(2).replace('.',',')} foi devolvido à sua carteira.`;
        await createSystemTicket(order.user_id, ticketMessage);
        
        await client.query('COMMIT');
        
        res.status(200).json({ message: 'Pedido reembolsado, saldo devolvido e estoque atualizado com sucesso.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Erro ao reembolsar pedido:", error);
        res.status(500).json({ message: error.message || 'Erro interno ao processar o reembolso.' });
    } finally {
        client.release();
    }
};

exports.getCashierSummary = async (req, res) => {
    try {
        // --- QUERY ATUALIZADA ---
        const summaryQuery = `
            SELECT
                COALESCE(SUM((oi.price_at_purchase - oi.cost_at_purchase) * oi.quantity), 0) AS total_net_profit,
                COALESCE(SUM(oi.cost_at_purchase * oi.quantity), 0) AS total_cost_of_goods_sold
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            WHERE o.status = 'paid';
        `;
        const summaryResult = await pool.query(summaryQuery);

        const withdrawalsQuery = `
            SELECT type, COALESCE(SUM(amount), 0) as total_withdrawn
            FROM central_cashier_withdrawals
            GROUP BY type;
        `;
        const withdrawalsResult = await pool.query(withdrawalsQuery);
        const walletBalanceQuery = `
            SELECT COALESCE(SUM(wallet_balance), 0)::float AS total_wallet_balance
            FROM users;
        `;
        const walletBalanceResult = await pool.query(walletBalanceQuery);
        let netProfit = parseFloat(summaryResult.rows[0].total_net_profit);
        let costOfGoods = parseFloat(summaryResult.rows[0].total_cost_of_goods_sold);
        withdrawalsResult.rows.forEach(w => {
            if (w.type === 'net_profit') {
                netProfit -= parseFloat(w.total_withdrawn);
            } else if (w.type === 'cost_of_goods') {
                costOfGoods -= parseFloat(w.total_withdrawn);
            }
        });
        res.status(200).json({
            net_profit: netProfit,
            cost_of_goods: costOfGoods,
            total_wallet_balance: walletBalanceResult.rows[0].total_wallet_balance
        });
    } catch (error) {
        console.error("Erro ao buscar resumo do caixa central:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

exports.createWithdrawal = async (req, res) => {
    const { amount, type, reason } = req.body;
    if (!amount || !type || !['net_profit', 'cost_of_goods'].includes(type)) {
        return res.status(400).json({ message: 'Dados de retirada inválidos.' });
    }
    try {
        const newWithdrawal = await pool.query(
            "INSERT INTO central_cashier_withdrawals (amount, type, reason) VALUES ($1, $2, $3) RETURNING *",
            [amount, type, reason]
        );
        res.status(201).json(newWithdrawal.rows[0]);
    } catch (error) {
        console.error("Erro ao criar retirada:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

exports.getMovementHistory = async (req, res) => {
    const { startDate, endDate, type } = req.query; // Recebe os filtros

    try {
        // 1. Construção do Filtro de Data (BLINDADO contra erro de fuso)
        let dateFilterWallet = "";
        let dateFilterCashier = "";
        const params = [];
        let pIndex = 1;

        if (startDate && endDate) {
            // Adiciona as horas para pegar o dia completo em Brasília
            // Ex: de '2023-10-01 00:00:00' até '2023-10-01 23:59:59'
            params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
            
            const filter = ` AND (created_at AT TIME ZONE 'America/Sao_Paulo') BETWEEN $${pIndex} AND $${pIndex + 1}`;
            dateFilterWallet = filter;
            dateFilterCashier = filter;
            pIndex += 2;
        }

        // 2. Construção da Query com UNION ALL (Junta tudo e filtra depois)
        // Usamos uma CTE (Common Table Expression) para organizar melhor
        let query = `
            WITH all_movements AS (
                -- 1. Depósitos (Entradas)
                SELECT
                    'entrada' AS movement_type,
                    wt.id,
                    wt.created_at,
                    wt.amount,
                    wt.description AS details,
                    u.name AS user_name,
                    c.name AS condo_name,
                    'wallet' AS source_type
                FROM wallet_transactions wt
                JOIN users u ON wt.user_id = u.id
                JOIN condominiums c ON u.condo_id = c.id
                WHERE wt.type = 'deposit' 
                  AND wt.amount > 0 
                  AND wt.description NOT LIKE 'Reembolso%'
                  ${dateFilterWallet.replace('created_at', 'wt.created_at')}

                UNION ALL

                -- 2. Retiradas do Admin (Saídas do Lucro/Reposição)
                SELECT
                    'saida' AS movement_type,
                    cw.id,
                    cw.created_at,
                    cw.amount * -1 AS amount, 
                    cw.reason AS details,
                    'Administrador' AS user_name,
                    'Caixa Central' AS condo_name,
                    cw.type AS source_type
                FROM central_cashier_withdrawals cw
                WHERE 1=1 ${dateFilterCashier.replace('created_at', 'cw.created_at')}

                UNION ALL

                -- 3. Saídas de Carteira (Transferências/Débitos)
                SELECT
                    'saida' AS movement_type,
                    wt.id,
                    wt.created_at,
                    wt.amount * -1 AS amount,
                    wt.description AS details,
                    u.name AS user_name,
                    c.name AS condo_name,
                    'wallet' AS source_type
                FROM wallet_transactions wt
                JOIN users u ON wt.user_id = u.id
                JOIN condominiums c ON u.condo_id = c.id
                WHERE wt.type = 'transfer_out'
                  ${dateFilterWallet.replace('created_at', 'wt.created_at')}
            )
            SELECT * FROM all_movements
            WHERE 1=1
        `;

        // 3. Aplica filtro de Tipo (Entrada/Saída) se selecionado
        if (type && type !== 'all') {
            params.push(type);
            query += ` AND movement_type = $${pIndex}`;
            pIndex++;
        }

        query += ` ORDER BY created_at DESC`;

        const { rows } = await pool.query(query, params);
        
        // Formata para o frontend
        const formattedHistory = rows.map(item => ({
            id: item.id,
            created_at: item.created_at,
            type: item.movement_type,
            amount: item.amount,
            details: item.details,
            user_name: item.user_name,
            condo_name: item.condo_name,
            source_type: item.source_type
        }));
        
        res.status(200).json(formattedHistory);

    } catch (error) {
        console.error("Erro ao buscar histórico financeiro:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

exports.refundDeposit = async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const depositResult = await client.query(
            "SELECT id, user_id, amount, description FROM wallet_transactions WHERE id = $1 AND type = 'deposit'",
            [id]
        );
        if (depositResult.rows.length === 0) throw new Error('Transação de depósito não encontrada.');
        const deposit = depositResult.rows[0];
        const depositAmount = parseFloat(deposit.amount);
        if (depositAmount <= 0 || deposit.description.startsWith('[REEMBOLSADO]')) {
            throw new Error('Este depósito já foi estornado anteriormente.');
        }
        const userResult = await client.query("SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE", [deposit.user_id]);
        const userBalance = parseFloat(userResult.rows[0].wallet_balance);
        const amountToDebit = Math.min(userBalance, depositAmount);
        let ticketMessage;
        let adminMessage;
        const newDescription = `[REEMBOLSADO] ${deposit.description}`;
        await client.query(
            "UPDATE wallet_transactions SET amount = 0, description = $1 WHERE id = $2",
            [newDescription, id]
        );
        if (amountToDebit > 0) {
            await client.query(
                "UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2",
                [amountToDebit, deposit.user_id]
            );
            ticketMessage = `Um depósito de R$ ${depositAmount.toFixed(2)} (Ref: ${deposit.description}) foi estornado pelo administrador. O valor de R$ ${amountToDebit.toFixed(2)} foi debitado do seu saldo.`;
            adminMessage = `Estorno contábil realizado. O usuário tinha R$ ${userBalance.toFixed(2)} em saldo, então R$ ${amountToDebit.toFixed(2)} foi debitado da conta dele.`;
        } else {
            ticketMessage = `Um depósito de R$ ${depositAmount.toFixed(2)} (Ref: ${deposit.description}) foi estornado pelo administrador. Nenhum valor foi debitado pois seu saldo era R$ 0,00.`;
            adminMessage = `Estorno contábil realizado. O usuário não possuía saldo (R$ ${userBalance.toFixed(2)}), então nada foi debitado. O depósito foi zerado nos relatórios.`;
        }
        await createSystemTicket(deposit.user_id, ticketMessage);
        await client.query('COMMIT');
        res.status(200).json({ message: adminMessage });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Erro ao reembolsar depósito:", error);
        res.status(400).json({ message: error.message || 'Erro interno ao processar o reembolso do depósito.' });
    } finally {
        client.release();
    }
};

// ARQUIVO: controllers/adminController.js
// SUBSTITUA A FUNÇÃO 'getSalesHistory' POR ESTA VERSÃO PAGINADA:

exports.getSalesHistory = async (req, res) => {
    const { startDate, endDate, condoId, status, search, page = 1, limit = 10 } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    try {
        // 1. Construção Dinâmica do WHERE
        let whereClause = "WHERE 1=1";
        const params = [];
        let paramIndex = 1;

        // Filtro de Data (OPCIONAL AGORA)
        if (startDate && endDate) {
            whereClause += ` AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
            params.push(startDate, endDate);
            paramIndex += 2;
        }

        // Filtro de Condomínio
        if (condoId && condoId !== 'all') {
            whereClause += ` AND o.condo_id = $${paramIndex}`;
            params.push(condoId);
            paramIndex++;
        }

        // Filtro de Status
        if (status && status !== 'all') {
            whereClause += ` AND o.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        // Busca por Texto
        if (search) {
            whereClause += ` AND (u.name ILIKE $${paramIndex} OR o.id::text = $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        // 2. QUERY DE DADOS (Paginada)
        const dataQuery = `
            SELECT 
                o.id, 
                o.total_amount, 
                o.status, 
                o.created_at, 
                o.door_opened_at,
                u.name as user_name, 
                u.email as user_email,
                c.name as condo_name,
                (SELECT string_agg(p.name, ', ') 
                 FROM order_items oi 
                 JOIN products p ON oi.product_id = p.id 
                 WHERE oi.order_id = o.id) as product_summary
            FROM orders o
            JOIN users u ON o.user_id = u.id
            LEFT JOIN condominiums c ON o.condo_id = c.id
            ${whereClause}
            ORDER BY o.created_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        // 3. QUERY DE CONTAGEM E TOTAIS (Para Paginação e KPIs)
        const summaryQuery = `
            SELECT 
                COUNT(*) as total_count,
                COALESCE(SUM(total_amount), 0) as total_revenue
            FROM orders o
            JOIN users u ON o.user_id = u.id
            LEFT JOIN condominiums c ON o.condo_id = c.id
            ${whereClause}
        `;

        // Executa em paralelo
        const [dataResult, summaryResult] = await Promise.all([
            pool.query(dataQuery, [...params, limit, offset]),
            pool.query(summaryQuery, params) // Usa os mesmos params do WHERE, sem limit/offset
        ]);

        const totalItems = parseInt(summaryResult.rows[0].total_count);
        const totalRevenue = parseFloat(summaryResult.rows[0].total_revenue);
        const totalPages = Math.ceil(totalItems / limit);

        // Retorna formato completo com metadados
        res.json({
            data: dataResult.rows,
            meta: {
                currentPage: parseInt(page),
                totalPages: totalPages,
                totalItems: totalItems,
                itemsPerPage: parseInt(limit),
                totalRevenue: totalRevenue // Envia o total financeiro real do filtro
            }
        });

    } catch (error) {
        console.error("Erro no histórico de vendas:", error);
        res.status(500).json({ message: "Erro ao buscar vendas." });
    }
};

exports.getOrderDetails = async (req, res) => {
    const { orderId } = req.params;
    try {
        const query = `
            SELECT oi.quantity, oi.price_at_purchase, p.name, p.image_url
            FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1
        `;
        const { rows } = await pool.query(query, [orderId]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: "Erro ao buscar itens." });
    }
};


exports.getExpiringProducts = async (req, res) => {
    try {
        const { condoId } = req.query;

        // Filtro Base: Produtos vencendo HOJE até DAQUI 30 DIAS
        let whereClause = `
            WHERE i.nearest_expiration_date IS NOT NULL 
            AND i.nearest_expiration_date BETWEEN (NOW() AT TIME ZONE 'America/Sao_Paulo')::date 
            AND ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '30 days')
        `;
        
        const params = [];

        // Filtro de Condomínio (Se selecionado)
        if (condoId && condoId !== 'all') {
            whereClause += ` AND i.condo_id = $1`;
            params.push(condoId);
        }

        const query = `
            SELECT 
                p.id, 
                p.name, 
                p.image_url, 
                i.quantity,
                i.nearest_expiration_date as expiry_date,
                c.name as condo_name
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            JOIN condominiums c ON i.condo_id = c.id
            ${whereClause}
            ORDER BY i.nearest_expiration_date ASC
            LIMIT 5
        `;

        const result = await pool.query(query, params);
        res.json(result.rows);

    } catch (error) {
        console.error('Erro ao buscar produtos vencendo:', error);
        res.status(500).json({ message: 'Erro ao buscar produtos' });
    }
};

exports.createFinancialTransaction = async (req, res) => {
    try {
        const { description, amount, type, category, date } = req.body;
        
        // Salva no banco
        await pool.query(
            `INSERT INTO financial_transactions (description, amount, type, category, date) 
             VALUES ($1, $2, $3, $4, $5)`,
            [description, parseFloat(amount), type, category, date || new Date()]
        );

        res.status(201).json({ message: 'Lançamento registrado com sucesso!' });
    } catch (error) {
        console.error('Erro ao criar transação:', error);
        res.status(500).json({ message: 'Erro ao salvar.' });
    }
};

// --- 2. DELETAR TRANSAÇÃO ---
exports.deleteFinancialTransaction = async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM financial_transactions WHERE id = $1', [id]);
        res.json({ message: 'Transação removida.' });
    } catch (error) {
        console.error('Erro ao deletar:', error);
        res.status(500).json({ message: 'Erro ao deletar.' });
    }
};

// --- 3. ESTATÍSTICAS FINANCEIRAS (O CÉREBRO ATUALIZADO) ---
exports.getFinancialStats = async (req, res) => {
    try {
        const { period } = req.query;
        let dateFilterOrders = "";
        let dateFilterTrans = "";

        // Filtro de Data Simples
        if (period === '7days') {
            dateFilterOrders = "AND created_at >= NOW() - INTERVAL '7 days'";
            dateFilterTrans = "AND date >= NOW() - INTERVAL '7 days'";
        } else if (period === 'month') {
            dateFilterOrders = "AND created_at >= DATE_TRUNC('month', CURRENT_DATE)";
            dateFilterTrans = "AND date >= DATE_TRUNC('month', CURRENT_DATE)";
        } else {
            // Default: Tudo
            dateFilterOrders = ""; 
            dateFilterTrans = "";
        }

        // A. Puxa Receita das Vendas (Automático)
        const salesQuery = await pool.query(`
            SELECT COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count 
            FROM orders WHERE status = 'paid' ${dateFilterOrders}
        `);
        const salesRevenue = parseFloat(salesQuery.rows[0].total);
        const salesCount = parseInt(salesQuery.rows[0].count) || 1;

        // B. Puxa Despesas Manuais (Tabela nova)
        const expensesQuery = await pool.query(`
            SELECT COALESCE(SUM(amount), 0) as total 
            FROM financial_transactions 
            WHERE type = 'expense' ${dateFilterTrans}
        `);
        const manualExpenses = parseFloat(expensesQuery.rows[0].total);

        // C. Puxa Transações para a Lista (Extrato)
        const transactionsList = await pool.query(`
            SELECT id, description, amount, type, category, date 
            FROM financial_transactions 
            WHERE 1=1 ${dateFilterTrans}
            ORDER BY date DESC
        `);

        // D. Custo dos Produtos (Estimado ou Real)
        // Aqui assumimos 40% do valor da venda como custo do produto se não tiver coluna exata
        const productCosts = salesRevenue * 0.4; 

        // === CÁLCULOS FINAIS ===
        const totalRevenue = salesRevenue; // + Receitas manuais se tiver
        const totalExpenses = productCosts + manualExpenses; // Custo Produto + Conta de Luz/Água etc
        const netProfit = totalRevenue - totalExpenses;
        const profitMargin = totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(1) : 0;
        const averageTicket = salesRevenue / salesCount;

        // E. Dados do Gráfico (Misturando Vendas e Despesas)
        // Simplificado para devolver apenas vendas diárias por enquanto no gráfico
        const chartQuery = await pool.query(`
            SELECT TO_CHAR(created_at, 'DD/MM') as name, SUM(total_amount) as value
            FROM orders WHERE status = 'paid' ${dateFilterOrders}
            GROUP BY TO_CHAR(created_at, 'DD/MM'), DATE(created_at)
            ORDER BY DATE(created_at) ASC
        `);

        res.json({
            revenue: totalRevenue,
            expenses: totalExpenses, // Agora inclui suas despesas manuais!
            profit: netProfit,
            margin: profitMargin,
            ticketAverage: averageTicket,
            chartData: {
                labels: chartQuery.rows.map(r => r.name),
                data: chartQuery.rows.map(r => parseFloat(r.value))
            },
            transactions: transactionsList.rows // Manda a lista para o frontend
        });

    } catch (error) {
        console.error('Erro stats:', error);
        res.status(500).json({ message: 'Erro interno' });
    }
};


exports.getPurchaseHistory = async (req, res) => {
    try {
        const { condoId } = req.query;
        let query = 'SELECT * FROM purchase_history';
        let values = [];

        if (condoId && condoId !== 'all') {
            query += ' WHERE condo_id = $1 OR condo_id IS NULL';
            values.push(condoId);
        }

        query += ' ORDER BY date DESC, created_at DESC';

        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (error) {
        console.error('Erro ao buscar histórico de compras:', error);
        res.status(500).json({ message: 'Erro interno no servidor' });
    }
};

exports.registerPurchase = async (req, res) => {
    const { condo_id, date, total_spent, total_savings, items } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. Grava o resumo financeiro no histórico (Mantém a aba de Histórico a funcionar normalmente)
        await client.query(
            'INSERT INTO purchase_history (condo_id, date, total_spent, total_savings) VALUES ($1, $2, $3, $4)',
            [condo_id, date, total_spent, total_savings]
        );

        // 2. Cria a sessão de reposição pendente (O "Carrinho do Fornecedor" que vai viajar até à máquina)
        const pendingResult = await client.query(
            `INSERT INTO pending_restocks (condo_id, total_spent, total_savings, status) 
             VALUES ($1, $2, $3, 'pending') RETURNING id`,
            [condo_id, total_spent, total_savings]
        );
        const pendingId = pendingResult.rows[0].id;

        // 3. Atualiza o preço base e guarda os itens pendentes (ATENÇÃO: JÁ NÃO SOMA NO INVENTORY)
        for (let item of items) {
            // Atualiza o custo do produto globalmente para os relatórios financeiros
            await client.query(
                'UPDATE products SET purchase_price = $1 WHERE id = $2',
                [item.new_price, item.product_id]
            );
            
            // Guarda o item na lista de pendentes para a conferência visual na máquina
            if (condo_id && condo_id !== 'all') {
                await client.query(
                    `INSERT INTO pending_restock_items (pending_restock_id, product_id, quantity, purchase_price)
                     VALUES ($1, $2, $3, $4)`,
                    [pendingId, item.product_id, item.quantity, item.new_price]
                );
            }
        }

        await client.query('COMMIT');
        res.status(200).json({ success: true, message: 'Compras registadas! A aguardar abastecimento físico na máquina.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao registar compras pendentes:', error);
        res.status(500).json({ message: 'Erro ao registar reposição pendente no sistema.' });
    } finally {
        client.release();
    }
};
