// controllers/webhookController.js -> SUBSTITUA O ARQUIVO INTEIRO

const pool = require('../db');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const crypto = require('crypto');
const { createSystemTicket } = require('./ticketController');

const client = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });

exports.handleMercadoPagoWebhook = async (req, res) => {
    console.log('--- WEBHOOK DO MERCADO PAGO RECEBIDO ---');
    
    const paymentType = req.body.type || req.query.type;
    const paymentId = req.body.data?.id || req.query['data.id'];

    if (paymentType === 'payment' && paymentId) {
        console.log(`Notificação de pagamento recebida para o ID: ${paymentId}`);
        try {
            const paymentInfo = await new Payment(client).get({ id: paymentId });
            console.log(`Status do pagamento no MP: ${paymentInfo.status}. Referência externa: ${paymentInfo.external_reference}`);

            if (paymentInfo.status === 'approved') {
                const externalRef = paymentInfo.external_reference;

                if (externalRef.startsWith('credit_invoice_')) {
                    console.log(`Pagamento identificado como PAGAMENTO DE FATURA para a referência: ${externalRef}`);
                    await processInvoicePayment(externalRef, paymentId);

                } else if (externalRef.startsWith('wallet_deposit_')) {
                    console.log(`Pagamento identificado como DEPÓSITO DE CARTEIRA para a referência: ${externalRef}`);
                    const userId = externalRef.split('_')[2]; 
                    const amount = paymentInfo.transaction_amount; 
                    
                    await processWalletDeposit({ userId, amount, paymentId });

                } else {
                    // Esta lógica agora está morta, pois não criamos mais PIX para produtos.
                    // Mantemos um log caso algum pagamento antigo chegue.
                    console.log(`Pagamento de compra de produto (Legado) recebido: ${externalRef}. Nenhuma ação de desbloqueio será tomada.`);
                }
            } else {
                console.log(`Status do pagamento não é 'approved' (${paymentInfo.status}).`);
            }
        } catch (error) {
            console.error('ERRO NO PROCESSAMENTO DO WEBHOOK:', error);
        }
    } else {
        console.log(`Tipo de evento recebido não é 'payment' ou ID do pagamento não encontrado.`);
    }

    res.sendStatus(200);
};

// Função para processar um DEPÓSITO na carteira
async function processWalletDeposit(depositInfo) {
    const { userId, amount, paymentId } = depositInfo;
    if (!userId || !amount || amount <= 0) {
        console.error(`Tentativa de depósito inválida. UserID: ${userId}, Amount: ${amount}`);
        return;
    }
    
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        
        // Verifica se a transação já foi processada
        const existingTx = await dbClient.query("SELECT id FROM wallet_transactions WHERE payment_gateway_id = $1 AND type = 'deposit'", [paymentId]);
        if (existingTx.rows.length > 0) {
            console.log(`Webhook de depósito para paymentId ${paymentId} já foi processado. Ignorando.`);
            await dbClient.query('COMMIT');
            return;
        }

        const updatedUser = await dbClient.query(
            'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance',
            [amount, userId]
        );
        console.log(`Saldo do usuário ${userId} atualizado para ${updatedUser.rows[0].wallet_balance}`);
        
        await dbClient.query(
            `INSERT INTO wallet_transactions (user_id, type, amount, description, payment_gateway_id) VALUES ($1, 'deposit', $2, $3, $4)`,
            [userId, amount, 'Depósito via PIX', paymentId]
        );
        console.log(`Transação de depósito de ${amount} registrada para o usuário ${userId}`);
        
        await dbClient.query('COMMIT');
        
        const depositMessage = `Confirmamos o seu depósito de R$ ${parseFloat(amount).toFixed(2)}. O valor já está disponível na sua carteira.`;
        await createSystemTicket(userId, depositMessage);

        console.log(`Transação de depósito para o usuário ${userId} completada com sucesso.`);
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error(`ERRO ao processar depósito para o usuário ${userId}:`, error);
        throw error;
    } finally {
        dbClient.release();
    }
}

// Função para processar o PAGAMENTO DE UMA FATURA
async function processInvoicePayment(externalReference, paymentId) {
    const userId = externalReference.split('_')[2]; 

    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        
        // Verifica se já foi pago
        const existingInvoice = await dbClient.query("SELECT id FROM credit_invoices WHERE related_payment_ref = $1 AND status = 'paid'", [paymentId]);
        if (existingInvoice.rows.length > 0) {
            console.log(`Webhook de fatura para paymentId ${paymentId} já foi processado. Ignorando.`);
            await dbClient.query('COMMIT');
            return;
        }

        await dbClient.query('UPDATE users SET credit_used = 0 WHERE id = $1', [userId]);

        await dbClient.query(
            `UPDATE credit_invoices 
             SET status = 'paid', paid_at = NOW(), related_payment_ref = $1
             WHERE user_id = $2 AND status IN ('open', 'late')`,
            [paymentId, userId]
        );
        console.log(`Fatura(s) e saldo devedor pagos para o utilizador ${userId}.`);
        
        await dbClient.query('COMMIT');

        const invoiceMessage = `Obrigado! Confirmamos o pagamento da sua fatura SmartFridge.`;
        await createSystemTicket(userId, invoiceMessage);
        
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error(`ERRO ao processar pagamento de fatura para o utilizador ${userId}:`, error);
        throw error;
    } finally {
        dbClient.release();
    }
}