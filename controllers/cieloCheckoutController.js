// controllers/cieloCheckoutController.js
// Checkout Cielo sem cadastro: PIX + cartão de crédito transparente.
// Nunca salve número do cartão/CVV no banco e nunca faça console.log do body do cartão.

const pool = require('../db');
const { createPixPayment, createCreditCardPayment } = require('../services/cieloService');
const { finalizeCieloPaymentIfPaid, PAID_STATUS, DENIED_STATUS } = require('../services/unlockOrderService');

function normalizeMerchantOrderId(value) {
  return String(value).replace(/[^a-zA-Z0-9]/g, '').substring(0, 50);
}

function extractPaymentData(cieloResponse) {
  const payment = cieloResponse.Payment || {};
  return {
    paymentId: payment.PaymentId || cieloResponse.PaymentId,
    merchantOrderId: cieloResponse.MerchantOrderId,
    status: Number(payment.Status),
    amount: payment.Amount,
    type: payment.Type,
    provider: payment.Provider,
    returnCode: payment.ReturnCode,
    returnMessage: payment.ReturnMessage,
    tid: payment.Tid,
    authorizationCode: payment.AuthorizationCode,
    raw: cieloResponse,
  };
}

async function getProductDetailsFromCart(dbClient, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Carrinho vazio.');
  }

  const productIds = items.map(item => Number(item.id)).filter(Boolean);
  if (productIds.length !== items.length) {
    throw new Error('Carrinho possui produto inválido.');
  }

  const productQuery = await dbClient.query(
    `SELECT 
        p.id,
        p.name,
        COALESCE(p.purchase_price, 0) AS purchase_price,
        CASE
          WHEN p.promotional_price IS NOT NULL
               AND p.promotion_start_date IS NOT NULL
               AND p.promotion_end_date IS NOT NULL
               AND NOW() BETWEEN p.promotion_start_date AND p.promotion_end_date
          THEN p.promotional_price
          ELSE p.sale_price
        END AS sale_price
      FROM products p
      WHERE p.id = ANY($1::int[])`,
    [productIds]
  );

  const productMap = new Map(productQuery.rows.map(product => [Number(product.id), product]));
  let totalAmount = 0;

  const processedItems = items.map(item => {
    const quantity = Number(item.quantity || 1);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('Quantidade inválida no carrinho.');
    }

    const product = productMap.get(Number(item.id));
    if (!product) {
      throw new Error(`Produto ${item.id} não encontrado.`);
    }

    const salePrice = Number(product.sale_price);
    totalAmount += salePrice * quantity;

    return {
      id: Number(product.id),
      name: product.name,
      quantity,
      sale_price: salePrice,
      cost_at_purchase: Number(product.purchase_price || 0),
    };
  });

  return { processedItems, totalAmount };
}

async function createPendingOrder({ dbClient, items, condoId, fridgeId, paymentMethod }) {
  if (!items || !Array.isArray(items) || items.length === 0 || !condoId || !fridgeId) {
    throw new Error('Informe items, condoId e fridgeId.');
  }

  const condo = await dbClient.query(
    'SELECT id, name, fridge_id FROM condominiums WHERE id = $1 AND fridge_id = $2',
    [condoId, fridgeId]
  );

  if (condo.rows.length === 0) {
    throw new Error('Geladeira/condomínio inválido.');
  }

  const { processedItems, totalAmount } = await getProductDetailsFromCart(dbClient, items);

  for (const item of processedItems) {
    const stock = await dbClient.query(
      `SELECT quantity
         FROM inventory
        WHERE product_id = $1 AND condo_id = $2
        FOR UPDATE`,
      [item.id, condoId]
    );

    const available = Number(stock.rows[0]?.quantity || 0);
    if (available < item.quantity) {
      throw new Error(`Estoque insuficiente para ${item.name}. Disponível: ${available}.`);
    }
  }

  const order = await dbClient.query(
    `INSERT INTO orders
       (user_id, condo_id, total_amount, status, payment_method, fridge_id, provider)
     VALUES
       (NULL, $1, $2, 'pending', $3, $4, 'cielo')
     RETURNING id, condo_id, fridge_id, status`,
    [condoId, totalAmount, paymentMethod, fridgeId]
  );

  const orderId = order.rows[0].id;
  const merchantOrderId = normalizeMerchantOrderId(`SF${orderId}${Date.now()}`);

  await dbClient.query(
    `UPDATE orders
        SET cielo_merchant_order_id = $1
      WHERE id = $2`,
    [merchantOrderId, orderId]
  );

  for (const item of processedItems) {
    await dbClient.query(
      `INSERT INTO order_items
         (order_id, product_id, quantity, price_at_purchase, cost_at_purchase)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, item.id, item.quantity, item.sale_price, item.cost_at_purchase]
    );
  }

  return {
    order: { ...order.rows[0], id: orderId, condo_id: Number(condoId), fridge_id: fridgeId },
    orderId,
    merchantOrderId,
    totalAmount,
  };
}

exports.createPixOrder = async (req, res) => {
  const { items, condoId, fridgeId, customerName } = req.body;
  const dbClient = await pool.connect();
  let orderId;

  try {
    await dbClient.query('BEGIN');
    const pending = await createPendingOrder({ dbClient, items, condoId, fridgeId, paymentMethod: 'pix' });
    orderId = pending.orderId;
    await dbClient.query('COMMIT');

    const cieloResponse = await createPixPayment({
      merchantOrderId: pending.merchantOrderId,
      amount: pending.totalAmount,
      customerName: customerName || 'Cliente SmartFridge',
    });

    const payment = cieloResponse.Payment || {};
    const paymentId = payment.PaymentId;

    if (!paymentId) {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['payment_error', orderId]);
      return res.status(502).json({ message: 'Cielo não retornou PaymentId.', cieloResponse });
    }

    await pool.query(
      `UPDATE orders
          SET payment_gateway_id = $1,
              cielo_payment_id = $1,
              status = 'payment_pending'
        WHERE id = $2`,
      [paymentId, orderId]
    );

    return res.status(201).json({
      orderId,
      merchantOrderId: pending.merchantOrderId,
      paymentId,
      status: payment.Status,
      totalAmount: pending.totalAmount,
      qrCodeString: payment.QrCodeString || payment.QrcodeString || payment.QRCodeString || null,
      qrCodeBase64Image: payment.QrCodeBase64Image || payment.QrcodeBase64Image || null,
    });
  } catch (error) {
    try { await dbClient.query('ROLLBACK'); } catch (_) {}
    if (orderId) {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['payment_error', orderId]).catch(() => {});
    }
    console.error('[CIELO PIX] Erro ao criar pedido:', error.message);
    return res.status(500).json({ message: error.message || 'Erro interno ao criar Pix Cielo.' });
  } finally {
    dbClient.release();
  }
};

exports.createCardOrder = async (req, res) => {
  const { items, condoId, fridgeId, customerName, card, installments } = req.body;
  const dbClient = await pool.connect();
  let orderId;

  try {
    await dbClient.query('BEGIN');
    const pending = await createPendingOrder({ dbClient, items, condoId, fridgeId, paymentMethod: 'card' });
    orderId = pending.orderId;
    await dbClient.query('COMMIT');

    const cieloResponse = await createCreditCardPayment({
      merchantOrderId: pending.merchantOrderId,
      amount: pending.totalAmount,
      customerName: customerName || card?.holder || 'Cliente SmartFridge',
      card,
      installments,
    });

    const paymentData = extractPaymentData(cieloResponse);

    if (!paymentData.paymentId) {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['payment_error', orderId]);
      return res.status(502).json({ message: 'Cielo não retornou PaymentId.' });
    }

    await pool.query(
      `UPDATE orders
          SET payment_gateway_id = $1,
              cielo_payment_id = $1,
              status = $2
        WHERE id = $3`,
      [paymentData.paymentId, paymentData.status === PAID_STATUS ? 'paid' : paymentData.status === DENIED_STATUS ? 'failed' : 'processing_payment', orderId]
    );

    let unlockResult = { unlocked: false };
    if (paymentData.status === PAID_STATUS) {
      const finalizeClient = await pool.connect();
      try {
        await finalizeClient.query('BEGIN');
        const orderResult = await finalizeClient.query(
          `SELECT id, condo_id, fridge_id, status
             FROM orders
            WHERE id = $1
            FOR UPDATE`,
          [orderId]
        );
        unlockResult = await finalizeCieloPaymentIfPaid(finalizeClient, orderResult.rows[0], paymentData);
        await finalizeClient.query('COMMIT');
      } catch (finalizeError) {
        await finalizeClient.query('ROLLBACK');
        console.error('[CIELO CARD] Pagamento aprovado, erro ao gerar destrava:', finalizeError.message);
        throw finalizeError;
      } finally {
        finalizeClient.release();
      }
    }

    await pool.query(
      `INSERT INTO payment_events (provider, payment_id, event_type, payload)
       VALUES ('cielo', $1, $2, $3)`,
      [paymentData.paymentId, 'card_order_response', JSON.stringify({
        orderId,
        merchantOrderId: pending.merchantOrderId,
        payment: {
          status: paymentData.status,
          returnCode: paymentData.returnCode,
          returnMessage: paymentData.returnMessage,
          tid: paymentData.tid,
          authorizationCode: paymentData.authorizationCode,
        },
      })]
    ).catch(() => {});

    return res.status(201).json({
      orderId,
      merchantOrderId: pending.merchantOrderId,
      paymentId: paymentData.paymentId,
      status: paymentData.status,
      totalAmount: pending.totalAmount,
      returnCode: paymentData.returnCode,
      returnMessage: paymentData.returnMessage,
      tid: paymentData.tid,
      authorizationCode: paymentData.authorizationCode,
      paid: paymentData.status === PAID_STATUS,
      unlocked: Boolean(unlockResult.unlocked),
    });
  } catch (error) {
    try { await dbClient.query('ROLLBACK'); } catch (_) {}
    if (orderId) {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['payment_error', orderId]).catch(() => {});
    }
    console.error('[CIELO CARD] Erro ao criar pedido:', error.message);
    return res.status(500).json({ message: error.message || 'Erro interno ao processar cartão Cielo.' });
  } finally {
    dbClient.release();
  }
};

exports.getCieloOrderStatus = async (req, res) => {
  const { orderId } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, status, total_amount, payment_method, fridge_id, payment_gateway_id, paid_at, door_opened_at
         FROM orders
        WHERE id = $1`,
      [orderId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Pedido não encontrado.' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error('[CIELO] Erro ao consultar pedido:', error.message);
    return res.status(500).json({ message: 'Erro interno ao consultar pedido.' });
  }
};
