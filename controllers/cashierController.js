// controllers/cashierController.js
const pool = require('../db');
// --- ESTA É A CORREÇÃO ---
const { createSystemTicket } = require('./ticketController');
// --- FIM DA CORREÇÃO ---

// --- Pega o resumo geral do caixa ---
// (Esta função permanece a mesma)
exports.getCashierSummary = async (req, res) => {
    try {
        // Query 1: Lucro e Custo
        const summaryQuery = `
            SELECT
                COALESCE(SUM((oi.price_at_purchase - p.purchase_price) * oi.quantity), 0) AS total_net_profit,
                COALESCE(SUM(p.purchase_price * oi.quantity), 0) AS total_cost_of_goods_sold
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE o.status = 'paid';
        `;
        const summaryResult = await pool.query(summaryQuery);

        // Query 2: Retiradas
        const withdrawalsQuery = `
            SELECT type, COALESCE(SUM(amount), 0) as total_withdrawn
            FROM central_cashier_withdrawals
            GROUP BY type;
        `;
        const withdrawalsResult = await pool.query(withdrawalsQuery);

        // Query 3: Saldo total em carteiras
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

// --- Registra uma nova retirada ---
// (Esta função permanece a mesma)
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

// --- Pega o histórico unificado de Entradas e Saídas ---
// (Esta função permanece a mesma)
exports.getMovementHistory = async (req, res) => {
    try {
        const historyQuery = `
            -- ENTRADAS (Depósitos)
            SELECT
                'entrada' AS movement_type,
                wt.id,
                wt.created_at,
                wt.amount,
                wt.description AS details,
                u.name AS user_name,
                c.name AS condo_name
            FROM wallet_transactions wt
            JOIN users u ON wt.user_id = u.id
            JOIN condominiums c ON u.condo_id = c.id
            WHERE 
                wt.type = 'deposit'
                AND wt.amount > 0
                AND wt.description NOT LIKE 'Reembolso%'

            UNION ALL

            -- SAÍDAS (Retiradas do Admin)
            SELECT
                'saida' AS movement_type,
                cw.id,
                cw.created_at,
                cw.amount * -1 AS amount,
                cw.reason AS details,
                'Administrador' AS user_name,
                'Caixa Central' AS condo_name
            FROM central_cashier_withdrawals cw

            UNION ALL
            
            -- SAÍDAS (Ajustes manuais / Estornos)
            SELECT
                'saida' AS movement_type,
                wt.id,
                wt.created_at,
                wt.amount * -1 AS amount, -- Mostra como negativo
                wt.description AS details,
                u.name AS user_name,
                c.name AS condo_name
            FROM wallet_transactions wt
            JOIN users u ON wt.user_id = u.id
            JOIN condominiums c ON u.condo_id = c.id
            WHERE 
                wt.type = 'transfer_out' -- Captura os débitos manuais

            ORDER BY created_at DESC;
        `;
        
        const { rows } = await pool.query(historyQuery);
        
        const formattedHistory = rows.map(item => ({
            id: item.id,
            created_at: item.created_at,
            type: item.movement_type,
            amount: item.amount,
            details: item.details,
            user_name: item.user_name,
            condo_name: item.condo_name
        }));

        res.status(200).json(formattedHistory);
        
    } catch (error) {
        console.error("Erro ao buscar histórico de movimentações:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

// =================================================================
// FUNÇÃO refundDeposit (Esta função agora FUNCIONARÁ)
// =================================================================
exports.refundDeposit = async (req, res) => {
    const { id } = req.params; // ID da transação (wallet_transactions)
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Busca a transação de depósito
        const depositResult = await client.query(
            "SELECT id, user_id, amount, description FROM wallet_transactions WHERE id = $1 AND type = 'deposit'",
            [id]
        );

        if (depositResult.rows.length === 0) {
            throw new Error('Transação de depósito não encontrada.');
        }

        const deposit = depositResult.rows[0];
        const depositAmount = parseFloat(deposit.amount);

        if (depositAmount <= 0 || deposit.description.startsWith('[REEMBOLSADO]')) {
            throw new Error('Este depósito já foi estornado anteriormente.');
        }

        // 2. Busca o saldo atual do usuário
        const userResult = await client.query("SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE", [deposit.user_id]);
        const userBalance = parseFloat(userResult.rows[0].wallet_balance);

        // 3. Calcula quanto PODE ser debitado
        const amountToDebit = Math.min(userBalance, depositAmount);
        let ticketMessage;
        let adminMessage;

        // 4. "Cancela" a transação (zera o valor e adiciona marcador)
        const newDescription = `[REEMBOLSADO] ${deposit.description}`;
        await client.query(
            "UPDATE wallet_transactions SET amount = 0, description = $1 WHERE id = $2",
            [newDescription, id]
        );

        // 5. Debita o valor possível da carteira do usuário
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

        // 6. Envia um tiquete ao usuário (AGORA FUNCIONA)
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