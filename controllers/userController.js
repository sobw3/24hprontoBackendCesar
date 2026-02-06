// controllers/userController.js
const pool = require('../db');

exports.getUserHistory = async (req, res) => {
    const userId = req.user.id;
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    try {
        // Query para buscar todas as transações unificadas
         const historyQuery = `
            SELECT
                id,
                type,
                amount,
                description,
                created_at,
                related_order_id
            FROM wallet_transactions
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3;
        `;

        const { rows: transactions } = await pool.query(historyQuery, [userId, limit, offset]);

        // Para cada transação de compra, buscar os itens
        for (const tx of transactions) {
            if ((tx.type === 'purchase' || tx.type === 'credit_purchase') && tx.related_order_id) {
                
                // --- INÍCIO DA ALTERAÇÃO ---
                // Adicionamos 'p.image_url' ao SELECT
                const itemsQuery = `
                    SELECT oi.quantity, oi.price_at_purchase, p.name as product_name, p.id as product_id, p.image_url
                    FROM order_items oi
                    JOIN products p ON oi.product_id = p.id
                    WHERE oi.order_id = $1;
                `;
                // --- FIM DA ALTERAÇÃO ---
                
                const { rows: items } = await pool.query(itemsQuery, [tx.related_order_id]);
                tx.items = items;
            }
        }
        
        // Query para contagem total (sem alteração)
        const totalQuery = `
            SELECT COUNT(*)::int 
            FROM (
                SELECT id FROM wallet_transactions WHERE user_id = $1
                UNION ALL
                SELECT id FROM wallet_transactions WHERE user_id = $1 AND type = 'invoice_payment'
            ) AS total;
        `;
        const totalResult = await pool.query(totalQuery, [userId]);

        res.status(200).json({
            transactions: transactions,
            pagination: {
                page: parseInt(page, 10),
                limit: parseInt(limit, 10),
                total: totalResult.rows[0].count
            }
        });

    } catch (error) {
        console.error('Erro ao buscar histórico unificado do usuário:', error);
        res.status(500).json({ message: 'Erro interno ao buscar seu histórico.' });
    }
};