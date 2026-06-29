// services/unlockOrderService.js
// Finalização idempotente de pedido pago: marca status, baixa estoque e cria comando de destrava.

const PAID_STATUS = 2;
const AUTHORIZED_STATUS = 1;
const DENIED_STATUS = 3;
const VOIDED_STATUS = 10;
const REFUNDED_STATUS = 11;
const PENDING_STATUS = 12;

async function markOrderFromCieloStatus(dbClient, order, paymentData) {
  if (paymentData.status === PAID_STATUS) {
    await dbClient.query(
      `UPDATE orders
          SET status = 'paid',
              paid_at = COALESCE(paid_at, NOW()),
              payment_gateway_id = COALESCE(payment_gateway_id, $1),
              cielo_payment_id = COALESCE(cielo_payment_id, $1)
        WHERE id = $2`,
      [paymentData.paymentId, order.id]
    );
    return;
  }

  if (paymentData.status === AUTHORIZED_STATUS) {
    await dbClient.query('UPDATE orders SET status = $1 WHERE id = $2', ['authorized', order.id]);
    return;
  }

  if (paymentData.status === VOIDED_STATUS) {
    await dbClient.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', order.id]);
    return;
  }

  if (paymentData.status === REFUNDED_STATUS) {
    await dbClient.query('UPDATE orders SET status = $1 WHERE id = $2', ['refunded', order.id]);
    return;
  }

  if (paymentData.status === DENIED_STATUS) {
    await dbClient.query('UPDATE orders SET status = $1 WHERE id = $2', ['failed', order.id]);
    return;
  }

  if (paymentData.status === PENDING_STATUS) {
    await dbClient.query('UPDATE orders SET status = $1 WHERE id = $2', ['payment_pending', order.id]);
  }
}

async function processPaidOrder(dbClient, order, paymentData) {
  const alreadyUnlocked = await dbClient.query(
    'SELECT id FROM unlock_commands WHERE order_id = $1 LIMIT 1',
    [order.id]
  );

  if (alreadyUnlocked.rows.length > 0) {
    return { unlocked: false, reason: 'already_unlocked' };
  }

  const items = await dbClient.query(
    `SELECT oi.product_id, oi.quantity, p.name
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1`,
    [order.id]
  );

  for (const item of items.rows) {
    const stock = await dbClient.query(
      `SELECT quantity
         FROM inventory
        WHERE product_id = $1 AND condo_id = $2
        FOR UPDATE`,
      [item.product_id, order.condo_id]
    );

    const available = Number(stock.rows[0]?.quantity || 0);
    if (available < Number(item.quantity)) {
      await dbClient.query('UPDATE orders SET status = $1 WHERE id = $2', ['paid_stock_error', order.id]);
      throw new Error(`Pagamento aprovado, mas estoque insuficiente para ${item.name}. Pedido ${order.id}.`);
    }
  }

  for (const item of items.rows) {
    await dbClient.query(
      `UPDATE inventory
          SET quantity = quantity - $1,
              last_updated = NOW()
        WHERE product_id = $2 AND condo_id = $3`,
      [item.quantity, item.product_id, order.condo_id]
    );
  }

  await dbClient.query(
    `INSERT INTO unlock_commands (fridge_id, order_id, payment_gateway_id, source)
     VALUES ($1, $2, $3, 'cielo')
     ON CONFLICT DO NOTHING`,
    [order.fridge_id, order.id, paymentData.paymentId]
  );

  await dbClient.query(
    `UPDATE orders
        SET door_opened_at = COALESCE(door_opened_at, NOW())
      WHERE id = $1`,
    [order.id]
  );

  return { unlocked: true };
}

async function finalizeCieloPaymentIfPaid(dbClient, order, paymentData) {
  await markOrderFromCieloStatus(dbClient, order, paymentData);

  if (paymentData.status === PAID_STATUS) {
    return processPaidOrder(dbClient, order, paymentData);
  }

  return { unlocked: false, reason: `status_${paymentData.status}` };
}

module.exports = {
  PAID_STATUS,
  AUTHORIZED_STATUS,
  DENIED_STATUS,
  VOIDED_STATUS,
  REFUNDED_STATUS,
  PENDING_STATUS,
  markOrderFromCieloStatus,
  processPaidOrder,
  finalizeCieloPaymentIfPaid,
};
