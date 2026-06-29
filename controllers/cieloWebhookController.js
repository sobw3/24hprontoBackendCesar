// controllers/cieloWebhookController.js
// Recebe Post de Notificação Cielo, consulta a transação e libera a trava somente se estiver pago.

const pool = require('../db');
const { getPaymentById } = require('../services/cieloService');
const { finalizeCieloPaymentIfPaid } = require('../services/unlockOrderService');

function isWebhookHeaderValid(req) {
  const expectedValue = process.env.CIELO_WEBHOOK_SECRET;
  if (!expectedValue) return true; // Em teste, deixa passar. Em produção, configure.

  const headerName = (process.env.CIELO_WEBHOOK_HEADER || 'x-cielo-webhook-secret').toLowerCase();
  const received = req.get(headerName);
  return received && received === expectedValue;
}

function getPaymentIdFromBody(body) {
  return body?.PaymentId || body?.paymentId || body?.payment_id || null;
}

function extractPaymentData(cieloTransaction) {
  const payment = cieloTransaction.Payment || {};

  return {
    paymentId: payment.PaymentId || cieloTransaction.PaymentId,
    merchantOrderId: cieloTransaction.MerchantOrderId,
    status: Number(payment.Status),
    amount: payment.Amount,
    type: payment.Type,
    provider: payment.Provider,
    raw: cieloTransaction,
  };
}

exports.handleCieloWebhook = async (req, res) => {
  console.log('--- WEBHOOK CIELO RECEBIDO ---', req.body);

  if (!isWebhookHeaderValid(req)) {
    console.warn('[CIELO WEBHOOK] Header de segurança inválido.');
    return res.status(401).json({ message: 'Header de segurança inválido.' });
  }

  const paymentId = getPaymentIdFromBody(req.body);

  // A Cielo envia uma notificação teste quando configura a URL. Responder 200 evita erro no painel.
  if (!paymentId) {
    console.log('[CIELO WEBHOOK] Sem PaymentId. Provável teste de configuração.');
    return res.sendStatus(200);
  }

  let cieloTransaction;
  try {
    cieloTransaction = await getPaymentById(paymentId);
  } catch (error) {
    console.error('[CIELO WEBHOOK] Falha ao consultar PaymentId na Cielo:', error.message);
    return res.sendStatus(200);
  }

  const paymentData = extractPaymentData(cieloTransaction);

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    await dbClient.query(
      `INSERT INTO payment_events (provider, payment_id, event_type, payload)
       VALUES ('cielo', $1, $2, $3)`,
      [paymentData.paymentId, String(req.body.ChangeType || 'status_change'), JSON.stringify({ notification: req.body, cieloTransaction })]
    );

    const orderResult = await dbClient.query(
      `SELECT id, condo_id, fridge_id, status
         FROM orders
        WHERE payment_gateway_id = $1
           OR cielo_payment_id = $1
           OR cielo_merchant_order_id = $2
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE`,
      [paymentData.paymentId, paymentData.merchantOrderId]
    );

    if (orderResult.rows.length === 0) {
      console.warn(`[CIELO WEBHOOK] Pagamento ${paymentData.paymentId} não encontrado em orders.`);
      await dbClient.query('COMMIT');
      return res.sendStatus(200);
    }

    const order = orderResult.rows[0];
    const result = await finalizeCieloPaymentIfPaid(dbClient, order, paymentData);

    if (result.unlocked) {
      console.log(`[CIELO WEBHOOK] Pedido ${order.id} pago. Comando de destrava gerado para ${order.fridge_id}.`);
    } else {
      console.log(`[CIELO WEBHOOK] Pedido ${order.id} status Cielo ${paymentData.status}. Não destravou. Motivo: ${result.reason || 'n/a'}`);
    }

    await dbClient.query('COMMIT');
    return res.sendStatus(200);
  } catch (error) {
    await dbClient.query('ROLLBACK');
    console.error('[CIELO WEBHOOK] Erro ao processar notificação:', error.message);
    // Importante: retorna 200 para evitar loop agressivo, mas loga o erro.
    return res.sendStatus(200);
  } finally {
    dbClient.release();
  }
};
