// controllers/creditController.js

const pool = require('../db');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const client = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(client);

// --- LÓGICA DE CÁLCULO CENTRALIZADA E CORRIGIDA ---
// Esta função agora é 'async' para permitir o 'await' e foi renomeada para clareza
async function getCreditData(userId) {
    // 1. Busca dados do utilizador
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) throw new Error('Utilizador não encontrado.');
    const user = userResult.rows[0];

    // 2. Busca faturas pendentes
    const invoicesResult = await pool.query(
        "SELECT id, amount, due_date FROM credit_invoices WHERE user_id = $1 AND status IN ('open', 'late')",
        [userId]
    );
    const pendingInvoices = invoicesResult.rows;

    // 3. Calcula a dívida
    const currentSpending = parseFloat(user.credit_used);
    const pendingInvoicesAmount = pendingInvoices.reduce((sum, inv) => sum + parseFloat(inv.amount), 0);
    const totalDebt = currentSpending + pendingInvoicesAmount;
    
    // 4. Calcula a taxa de serviço sobre a dívida total
    const serviceFee = totalDebt * 0.10;

    // 5. Calcula juros apenas sobre faturas que já venceram
    let totalInterest = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    pendingInvoices.forEach(inv => {
        const dueDate = new Date(inv.due_date);
        if (today > dueDate) {
            const diffTime = Math.abs(today - dueDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            totalInterest += parseFloat(inv.amount) * 0.025 * diffDays;
        }
    });
    
    // 6. Calcula o total final a pagar
    const totalToPay = totalDebt + serviceFee + totalInterest;

    // 7. Calcula a data de vencimento da próxima fatura
    let nextDueDate = null;
    if (user.credit_due_day) {
        nextDueDate = new Date(today.getFullYear(), today.getMonth(), user.credit_due_day);
        if (today.getDate() >= user.credit_due_day) {
            nextDueDate.setMonth(nextDueDate.getMonth() + 1);
        }
    }

    // O objeto de retorno foi corrigido para ser um objeto JavaScript válido
    return {
        user,
        currentSpending,
        pendingInvoicesAmount,
        totalDebt,
        serviceFee,
        totalInterest,
        totalToPay,
        nextDueDate
    };
}


// --- ROTAS DO CONTROLADOR ---

exports.getCreditSummary = async (req, res) => {
    try {
        const creditData = await getCreditData(req.user.id);
        res.status(200).json({
            creditLimit: parseFloat(creditData.user.credit_limit),
            creditUsed: creditData.totalDebt,
            availableCredit: parseFloat(creditData.user.credit_limit) - creditData.totalDebt,
            currentSpending: creditData.currentSpending,
            pendingInvoicesAmount: creditData.pendingInvoicesAmount,
            serviceFee: creditData.serviceFee,
            interest: creditData.totalInterest,
            totalToPay: creditData.totalToPay,
            dueDate: creditData.nextDueDate
        });
    } catch (error) {
        console.error('Erro ao buscar resumo de crédito:', error);
        res.status(500).json({ message: 'Erro interno ao buscar resumo de crédito.' });
    }
};

exports.createInvoicePixPayment = async (req, res) => {
    const userId = req.user.id;
    try {
        const creditData = await getCreditData(userId);

        if (creditData.totalToPay <= 0) {
            return res.status(400).json({ message: 'Não há fatura ou saldo devedor para pagar.' });
        }
        
        const externalReference = `credit_invoice_${userId}_${Date.now()}`;
        const description = `Pagamento Fatura SmartFridge (Total: R$${creditData.totalToPay.toFixed(2)})`;

        const paymentData = {
            body: {
                transaction_amount: parseFloat(creditData.totalToPay.toFixed(2)),
                description: description,
                payment_method_id: 'pix',
                payer: {
                    email: creditData.user.email,
                    first_name: creditData.user.name.split(' ')[0],
                    identification: { type: 'CPF', number: creditData.user.cpf.replace(/\D/g, '') }
                },
                external_reference: externalReference,
            }
        };

        const result = await payment.create(paymentData);
        
        res.status(201).json({
            paymentId: result.id,
            pix_qr_code: result.point_of_interaction.transaction_data.qr_code_base64,
            pix_qr_code_text: result.point_of_interaction.transaction_data.qr_code
        });

    } catch (error) {
        console.error('Erro ao gerar PIX para fatura:', error);
        res.status(500).json({ message: 'Falha ao gerar PIX para pagamento da fatura.' });
    }
};

exports.closeAndCreateInvoice = async (req, res) => {
    const { userId } = req.params;
    const dbClient = await pool.connect();

    try {
        await dbClient.query('BEGIN');

        const userResult = await dbClient.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (userResult.rows.length === 0) throw new Error('Utilizador não encontrado.');
        
        const user = userResult.rows[0];
        const creditUsed = parseFloat(user.credit_used);

        if (creditUsed <= 0) throw new Error('Não há saldo devedor para criar uma fatura.');

        const today = new Date();
        let dueDate = new Date(today.getFullYear(), today.getMonth(), user.credit_due_day);
        if (today.getDate() >= user.credit_due_day) {
            dueDate.setMonth(dueDate.getMonth() + 1);
        }

        await dbClient.query(
            `INSERT INTO credit_invoices (user_id, amount, due_date, status) VALUES ($1, $2, $3, 'open')`,
            [userId, creditUsed, dueDate]
        );

        // Zera o crédito usado para o próximo ciclo
        await dbClient.query('UPDATE users SET credit_used = 0 WHERE id = $1', [userId]);

        await dbClient.query('COMMIT');
        res.status(201).json({ message: 'Fatura fechada e criada com sucesso!' });

    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error(`Erro ao fechar fatura para o utilizador ${userId}:`, error);
        res.status(400).json({ message: error.message });
    } finally {
        dbClient.release();
    }
};

exports.getInvoicesForUser = async (req, res) => {
    const { userId } = req.params;
    try {
        const { rows } = await pool.query(
            "SELECT id, amount, due_date, status, paid_at FROM credit_invoices WHERE user_id = $1 ORDER BY due_date DESC",
            [userId]
        );
        res.status(200).json(rows);
    } catch (error) {
        console.error(`Erro ao buscar faturas para o utilizador ${userId}:`, error);
        res.status(500).json({ message: 'Erro ao buscar histórico de faturas.' });
    }
};
