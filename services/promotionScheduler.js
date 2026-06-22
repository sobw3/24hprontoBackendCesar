// services/promotionScheduler.js
// Motor diário de promoções automáticas com trava de margem:
// desconto sempre sobre o lucro, nunca sobre o custo do produto.

const cron = require('node-cron');
const pool = require('../db');
const { ensureSmartSchema } = require('../utils/smartSchema');

const toNumber = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const round2 = (v) => Math.round((toNumber(v) + Number.EPSILON) * 100) / 100;
const clamp = (v, min, max) => Math.min(max, Math.max(min, toNumber(v, min)));

async function runDailyPromotionCycle() {
  console.log(`[${new Date().toLocaleString('pt-BR')}] Rodando promoções automáticas...`);
  const client = await pool.connect();
  try {
    await ensureSmartSchema(pool);
    await client.query('BEGIN');

    const { rows: settingsRows } = await client.query(`SELECT * FROM auto_promotion_settings WHERE id = 1`);
    const settings = settingsRows[0] || { enabled: false };

    await client.query(`
      UPDATE products
      SET promotional_price = NULL, promotion_start_date = NULL, promotion_end_date = NULL
      WHERE promotion_end_date IS NOT NULL AND promotion_end_date <= NOW()
    `);

    if (!settings.enabled) {
      await client.query('COMMIT');
      console.log('Promoções automáticas desativadas. Nada a fazer.');
      return [];
    }

    const maxProducts = Math.max(1, Math.min(7, parseInt(settings.max_products, 10) || 4));
    const excluded = Array.isArray(settings.excluded_product_ids) ? settings.excluded_product_ids : [];
    const discounts = settings.product_discounts || {};
    const defaultPct = clamp(settings.default_discount_profit_percent, 0, 100);

    // Limpa promoções ativas antes de escolher os produtos do novo dia.
    await client.query(`UPDATE products SET promotional_price = NULL, promotion_start_date = NULL, promotion_end_date = NULL`);

    const { rows: products } = await client.query(
      `SELECT p.id, p.name, p.sale_price, p.purchase_price, COALESCE(SUM(i.quantity),0)::int AS stock
       FROM products p
       JOIN inventory i ON i.product_id = p.id
       WHERE COALESCE(p.is_archived, FALSE) = FALSE
         AND i.quantity > 0
         AND p.sale_price > p.purchase_price
         AND NOT (p.id = ANY($1::int[]))
       GROUP BY p.id
       ORDER BY RANDOM()
       LIMIT $2`,
      [excluded, maxProducts]
    );

    const selected = [];
    for (const product of products) {
      const sale = round2(product.sale_price);
      const cost = round2(product.purchase_price);
      const profit = Math.max(0, sale - cost);
      if (profit <= 0) continue;
      const pct = clamp(discounts[String(product.id)] ?? defaultPct, 0, 100);
      let promo = round2(sale - (profit * pct / 100));
      if (promo < cost) promo = cost;
      if (promo > sale) promo = sale;

      await client.query(
        `UPDATE products
         SET promotional_price = $1,
             promotion_start_date = NOW(),
             promotion_end_date = (CURRENT_DATE + INTERVAL '1 day' - INTERVAL '1 second'),
             auto_promo_discount_profit_percent = $2
         WHERE id = $3`,
        [promo, pct, product.id]
      );

      selected.push({
        id: product.id,
        name: product.name,
        sale_price: sale,
        purchase_price: cost,
        promotional_price: promo,
        discount_profit_percent: pct,
        protected_profit_after_discount: round2(promo - cost)
      });
    }

    await client.query(
      `INSERT INTO auto_promotion_runs (run_date, product_ids, metadata)
       VALUES (CURRENT_DATE, $1::int[], $2::jsonb)`,
      [selected.map(p => p.id), JSON.stringify({ selected, source: 'scheduler' })]
    );

    await client.query('COMMIT');
    console.log(`${selected.length} produto(s) entraram em promoção automática.`);
    return selected;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('ERRO no ciclo de promoções automáticas:', error);
    return [];
  } finally {
    client.release();
  }
}

exports.runDailyPromotionCycle = runDailyPromotionCycle;

exports.start = () => {
  if (process.env.DISABLE_PROMOTION_SCHEDULER === 'true') {
    console.log('Agendador de promoções desativado por DISABLE_PROMOTION_SCHEDULER=true.');
    return;
  }
  // Todo dia 00:05 no horário de Brasília.
  cron.schedule('5 0 * * *', runDailyPromotionCycle, { timezone: 'America/Sao_Paulo' });
  console.log('Agendador de promoções automáticas iniciado: 00:05 America/Sao_Paulo.');
};
