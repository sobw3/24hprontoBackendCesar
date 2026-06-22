const pool = require('../db');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { createSystemTicket } = require('./ticketController');

const client = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });

exports.handleMercadoPagoWebhook = async (req, res) => {
    const paymentType = req.body.type || req.query.type;
    const paymentId = req.body.data?.id || req.query['data.id'];

    if (paymentType !== 'payment' || !paymentId) {
        return res.sendStatus(200);
    }

    try {
        const paymentInfo = await new Payment(client).get({ id: paymentId });
        const externalRef = paymentInfo.external_reference || '';

        if (paymentInfo.status === 'approved' && externalRef.startsWith('wallet_deposit_')) {
            const userId = externalRef.split('_')[2];
            const amount = Number(paymentInfo.transaction_amount || 0);
            await processWalletDeposit({ userId, amount, paymentId });
        } else {
            console.log(`Webhook recebido sem ação necessária. Status: ${paymentInfo.status}; Referência: ${externalRef}`);
        }
    } catch (error) {
        // Mercado Pago pode reenviar webhooks. Respondemos 200 para evitar loop infinito,
        // mas mantemos o erro no log para depuração.
        console.error('ERRO NO PROCESSAMENTO DO WEBHOOK:', error);
    }

    res.sendStatus(200);
};

async function processWalletDeposit(depositInfo) {
    const { userId, amount, paymentId } = depositInfo;
    if (!userId || !amount || amount <= 0) {
        console.error(`Tentativa de depósito inválida. UserID: ${userId}, Amount: ${amount}`);
        return;
    }

    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        const existingTx = await dbClient.query(
            "SELECT id FROM wallet_transactions WHERE payment_gateway_id = $1 AND type = 'deposit'",
            [String(paymentId)]
        );
        if (existingTx.rows.length > 0) {
            await dbClient.query('COMMIT');
            return;
        }

        const updatedUser = await dbClient.query(
            'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance',
            [amount, userId]
        );

        if (updatedUser.rows.length === 0) {
            throw new Error('Usuário do depósito não encontrado.');
        }

        await dbClient.query(
            `INSERT INTO wallet_transactions (user_id, type, amount, description, payment_gateway_id)
             VALUES ($1, 'deposit', $2, $3, $4)`,
            [userId, amount, 'Depósito via PIX', String(paymentId)]
        );

        await dbClient.query('COMMIT');

        const depositMessage = `Confirmamos o seu depósito de R$ ${Number(amount).toFixed(2)}. O valor já está disponível na sua carteira.`;
        await createSystemTicket(userId, depositMessage);
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error(`ERRO ao processar depósito para o usuário ${userId}:`, error);
        throw error;
    } finally {
        dbClient.release();
    }
}
