// controllers/intelligenceController.js
// Backend das novas áreas do painel: financeiro IA, auditoria, perdas, compras,
// abastecimento, promoções automáticas e advertências de clientes.

const pool = require('../db');
const { ensureSmartSchema } = require('../utils/smartSchema');

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const round2 = (value) => Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
const intOrNull = (value) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, toNumber(value, min)));
const adminName = (req) => req.user?.username || req.admin?.username || req.user?.id || 'admin';

async function logAction(clientOrPool, req, action, entityType, entityId, reason, metadata = {}) {
  try {
    await clientOrPool.query(
      `INSERT INTO admin_action_logs (admin_identifier, action, entity_type, entity_id, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [String(adminName(req)), action, entityType, entityId ? String(entityId) : null, reason || null, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    console.warn('Não foi possível registrar log administrativo:', err.message);
  }
}

function currentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start, end };
}

function buildDateFilter(startDate, endDate, alias = 'o') {
  const values = [];
  const conditions = [];
  if (startDate) {
    values.push(startDate);
    conditions.push(`${alias}.created_at >= $${values.length}`);
  }
  if (endDate) {
    values.push(endDate);
    conditions.push(`${alias}.created_at < ($${values.length}::date + INTERVAL '1 day')`);
  }
  return { values, conditions };
}

async function getFinanceConfig(client = pool) {
  const { rows } = await client.query(`SELECT * FROM smart_finance_configs WHERE id = 1`);
  return rows[0] || {
    investment: 10549,
    cogs_rate: 62,
    fixed_costs: 349.90,
    fees_rate: 4.99,
    commission_rate: 0,
    extra_losses: 0
  };
}

async function calculateSmartDre({ condoId = null, startDate = null, endDate = null } = {}) {
  await ensureSmartSchema(pool);
  const config = await getFinanceConfig();
  const range = (!startDate && !endDate) ? currentMonthRange() : { start: startDate, end: endDate };

  const values = [range.start, range.end];
  const condoClause = condoId && condoId !== 'all' ? `AND o.condo_id = $3` : '';
  if (condoClause) values.push(condoId);

  const salesSql = `
    SELECT
      COUNT(DISTINCT o.id)::int AS orders_count,
      COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
      COALESCE(SUM(oi.quantity * oi.price_at_purchase), 0)::numeric AS revenue,
      COALESCE(SUM(oi.quantity * COALESCE(NULLIF(oi.cost_at_purchase, 0), p.purchase_price, 0)), 0)::numeric AS cogs,
      COALESCE(SUM(o.total_amount * (COALESCE(c.syndic_profit_percentage, 0) / 100.0)), 0)::numeric AS condo_commission
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN condominiums c ON c.id = o.condo_id
    WHERE o.status = 'paid'
      AND o.created_at >= $1
      AND o.created_at < $2
      ${condoClause}
  `;
  const { rows: salesRows } = await pool.query(salesSql, values);
  const sales = salesRows[0] || {};

  const lossValues = [range.start, range.end];
  // loss_records não tem condo_id por decisão de compatibilidade; perda fica global por enquanto.
  const { rows: lossRows } = await pool.query(
    `SELECT COALESCE(SUM(value), 0)::numeric AS losses
     FROM loss_records
     WHERE created_at >= $1 AND created_at < $2`,
    lossValues
  );

  const expenseValues = [range.start, range.end];
  let expenseCondoClause = '';
  if (condoId && condoId !== 'all') {
    expenseValues.push(condoId);
    expenseCondoClause = `AND condo_id = $3`;
  }
  const { rows: expenseRows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS expenses
     FROM operating_expenses
     WHERE created_at >= $1 AND created_at < $2
       ${expenseCondoClause}`,
    expenseValues
  );

  const investmentFallbackValues = [];
  let investmentFallbackClause = '';
  if (condoId && condoId !== 'all') {
    investmentFallbackValues.push(condoId);
    investmentFallbackClause = `WHERE id = $1`;
  }
  const { rows: investmentRows } = await pool.query(
    `SELECT
        COALESCE(SUM(initial_investment), 0)::numeric AS investment,
        COALESCE(SUM(monthly_fixed_cost), 0)::numeric AS fixed_costs,
        COALESCE(AVG(NULLIF(syndic_profit_percentage, 0)), 0)::numeric AS avg_commission_rate
     FROM condominiums ${investmentFallbackClause}`,
    investmentFallbackValues
  );

  const revenue = round2(sales.revenue || 0);
  const cogsFromSales = round2(sales.cogs || 0);
  const cogsByRate = round2(revenue * toNumber(config.cogs_rate, 62) / 100);
  const cogs = cogsFromSales > 0 ? cogsFromSales : cogsByRate;
  const grossProfit = round2(revenue - cogs);
  const paymentFees = round2(revenue * toNumber(config.fees_rate, 4.99) / 100);
  const commissionFromSales = round2(sales.condo_commission || 0);
  const commissionByConfig = round2(revenue * toNumber(config.commission_rate, 0) / 100);
  const commission = commissionFromSales > 0 ? commissionFromSales : commissionByConfig;
  const fixedFromCondos = round2(investmentRows[0]?.fixed_costs || 0);
  const fixedCosts = fixedFromCondos > 0 ? fixedFromCondos : round2(config.fixed_costs || 0);
  const losses = round2((lossRows[0]?.losses || 0) + toNumber(config.extra_losses, 0));
  const expenses = round2(expenseRows[0]?.expenses || 0);
  const netProfit = round2(grossProfit - paymentFees - commission - fixedCosts - losses - expenses);
  const margin = revenue > 0 ? round2((netProfit / revenue) * 100) : 0;
  const investmentFromCondos = round2(investmentRows[0]?.investment || 0);
  const investment = investmentFromCondos > 0 ? investmentFromCondos : round2(config.investment || 0);
  const paybackMonths = netProfit > 0 && investment > 0 ? round2(investment / netProfit) : null;

  return {
    period_start: range.start,
    period_end: range.end,
    revenue,
    orders_count: toNumber(sales.orders_count, 0),
    units_sold: toNumber(sales.units_sold, 0),
    cogs,
    gross_profit: grossProfit,
    payment_fees: paymentFees,
    commission,
    fixed_costs: fixedCosts,
    losses,
    operating_expenses: expenses,
    net_profit: netProfit,
    margin_percent: margin,
    investment,
    payback_months: paybackMonths,
    config: {
      cogs_rate: toNumber(config.cogs_rate, 62),
      fees_rate: toNumber(config.fees_rate, 4.99),
      commission_rate: toNumber(config.commission_rate, 0),
      fixed_costs: round2(config.fixed_costs || 0),
      extra_losses: round2(config.extra_losses || 0)
    }
  };
}

exports.getOperationsSummary = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const { start, end } = currentMonthRange();
    const [inc, losses, supplies, promos, purchases] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM audit_inconsistencies WHERE status IN ('open','em_analise')`),
      pool.query(`SELECT COALESCE(SUM(value),0)::numeric AS total, COUNT(*)::int AS count FROM loss_records WHERE created_at >= $1 AND created_at < $2`, [start, end]),
      pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cost),0)::numeric AS total FROM supply_records WHERE created_at >= $1 AND created_at < $2`, [start, end]),
      pool.query(`SELECT COUNT(*)::int AS count FROM products WHERE promotional_price IS NOT NULL AND NOW() BETWEEN promotion_start_date AND promotion_end_date`),
      pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0)::numeric AS total FROM purchase_records WHERE created_at >= $1 AND created_at < $2`, [start, end])
    ]);

    res.json({
      open_inconsistencies: inc.rows[0]?.count || 0,
      losses_count: losses.rows[0]?.count || 0,
      losses_value: round2(losses.rows[0]?.total || 0),
      supply_records_month: supplies.rows[0]?.count || 0,
      supply_cost_month: round2(supplies.rows[0]?.total || 0),
      active_promotions: promos.rows[0]?.count || 0,
      purchases_month: purchases.rows[0]?.count || 0,
      purchases_value_month: round2(purchases.rows[0]?.total || 0)
    });
  } catch (error) {
    console.error('Erro em operations/summary:', error);
    res.status(500).json({ message: 'Erro ao buscar resumo operacional.' });
  }
};

exports.getSmartDre = async (req, res) => {
  try {
    const data = await calculateSmartDre({ condoId: req.query.condoId, startDate: req.query.startDate, endDate: req.query.endDate });
    res.json(data);
  } catch (error) {
    console.error('Erro no DRE inteligente:', error);
    res.status(500).json({ message: 'Erro ao calcular DRE inteligente.' });
  }
};

exports.saveSmartFinanceConfig = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const body = req.body || {};
    const investment = round2(body.investment);
    const revenue = round2(body.revenue); // Mantido para compatibilidade visual; DRE real usa vendas.
    const cogsRate = clamp(body.cogsRate ?? body.cogs_rate, 0, 100);
    const fixedCosts = round2(body.fixedCosts ?? body.fixed_costs);
    const feesRate = clamp(body.feesRate ?? body.fees_rate, 0, 100);
    const commissionRate = clamp(body.commissionRate ?? body.commission_rate, 0, 100);
    const losses = round2(body.losses ?? body.extra_losses);

    const { rows } = await pool.query(
      `INSERT INTO smart_finance_configs (id, investment, cogs_rate, fixed_costs, fees_rate, commission_rate, extra_losses, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET
          investment = EXCLUDED.investment,
          cogs_rate = EXCLUDED.cogs_rate,
          fixed_costs = EXCLUDED.fixed_costs,
          fees_rate = EXCLUDED.fees_rate,
          commission_rate = EXCLUDED.commission_rate,
          extra_losses = EXCLUDED.extra_losses,
          updated_at = NOW()
       RETURNING *`,
      [investment, cogsRate, fixedCosts, feesRate, commissionRate, losses]
    );
    await logAction(pool, req, 'save_smart_finance_config', 'smart_finance_configs', 1, 'Atualização de DRE/payback', { ...body, revenue });
    const dre = await calculateSmartDre({});
    res.json({ success: true, config: rows[0], ...dre });
  } catch (error) {
    console.error('Erro ao salvar config financeira:', error);
    res.status(500).json({ message: 'Erro ao salvar configuração financeira.' });
  }
};

async function applyAutomaticPromotions(client, settings) {
  await client.query(`
    UPDATE products
    SET promotional_price = NULL, promotion_start_date = NULL, promotion_end_date = NULL
    WHERE promotion_end_date IS NOT NULL AND promotion_end_date <= NOW()
  `);

  if (!settings.enabled) {
    await client.query(`UPDATE products SET promotional_price = NULL, promotion_start_date = NULL, promotion_end_date = NULL`);
    return [];
  }

  const maxProducts = Math.max(1, Math.min(7, parseInt(settings.max_products, 10) || 4));
  const excluded = Array.isArray(settings.excluded_product_ids) ? settings.excluded_product_ids : [];
  const discounts = settings.product_discounts || {};
  const defaultPct = clamp(settings.default_discount_profit_percent, 0, 100);

  const { rows: eligible } = await client.query(
    `SELECT
        p.id, p.name, p.sale_price, p.purchase_price, p.image_url,
        COALESCE(SUM(i.quantity), 0)::int AS stock
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
  for (const product of eligible) {
    const sale = round2(product.sale_price);
    const cost = round2(product.purchase_price);
    const profit = Math.max(0, sale - cost);
    const pct = clamp(discounts[String(product.id)] ?? defaultPct, 0, 100);
    let promo = round2(sale - (profit * pct / 100));
    // Trava matemática: desconto é somente sobre lucro. Nunca abaixo do custo.
    if (promo < cost) promo = cost;
    if (promo > sale) promo = sale;
    if (profit <= 0) continue;

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
      real_discount_amount: round2(sale - promo),
      protected_profit_after_discount: round2(promo - cost)
    });
  }

  await client.query(
    `INSERT INTO auto_promotion_runs (run_date, product_ids, metadata)
     VALUES (CURRENT_DATE, $1::int[], $2::jsonb)`,
    [selected.map(p => p.id), JSON.stringify({ selected })]
  );

  return selected;
}

exports.getPromotionAutomation = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM auto_promotion_settings WHERE id = 1`);
    const config = rows[0] || {};
    res.json({
      enabled: !!config.enabled,
      max_products: config.max_products || 4,
      default_discount_profit_percent: toNumber(config.default_discount_profit_percent, 35),
      excluded_product_ids: config.excluded_product_ids || [],
      product_discounts: config.product_discounts || {}
    });
  } catch (error) {
    console.error('Erro ao buscar promo automation:', error);
    res.status(500).json({ message: 'Erro ao buscar configuração de promoções.' });
  }
};

exports.savePromotionAutomation = async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureSmartSchema(pool);
    const body = req.body || {};
    const enabled = !!body.enabled;
    const maxProducts = Math.max(1, Math.min(7, parseInt(body.maxProducts ?? body.max_products ?? 4, 10)));
    const defaultDiscount = clamp(body.defaultDiscount ?? body.default_discount_profit_percent ?? 35, 0, 100);
    const excludedIds = Array.isArray(body.excludedIds) ? body.excludedIds.map(intOrNull).filter(Boolean) : (Array.isArray(body.excluded_product_ids) ? body.excluded_product_ids.map(intOrNull).filter(Boolean) : []);
    const discounts = body.discounts || body.product_discounts || {};

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO auto_promotion_settings (id, enabled, max_products, default_discount_profit_percent, excluded_product_ids, product_discounts, updated_at)
       VALUES (1, $1, $2, $3, $4::int[], $5::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          max_products = EXCLUDED.max_products,
          default_discount_profit_percent = EXCLUDED.default_discount_profit_percent,
          excluded_product_ids = EXCLUDED.excluded_product_ids,
          product_discounts = EXCLUDED.product_discounts,
          updated_at = NOW()
       RETURNING *`,
      [enabled, maxProducts, defaultDiscount, excludedIds, JSON.stringify(discounts)]
    );
    const selected = await applyAutomaticPromotions(client, rows[0]);
    await logAction(client, req, 'save_auto_promotions', 'auto_promotion_settings', 1, enabled ? 'Ativou/atualizou promoções automáticas' : 'Desativou promoções automáticas', { enabled, maxProducts, defaultDiscount, excludedIds, discounts, selected });
    await client.query('COMMIT');
    res.json({ success: true, ...rows[0], selected_promotions: selected });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar promo automation:', error);
    res.status(500).json({ message: 'Erro ao salvar promoções automáticas.' });
  } finally {
    client.release();
  }
};

exports.getSuspectSales = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const condoId = intOrNull(req.query.condoId);
    const productId = intOrNull(req.query.productId);
    const since = req.query.since;
    if (!condoId || !productId || !since) return res.status(400).json({ message: 'condoId, productId e since são obrigatórios.' });

    const { rows } = await pool.query(
      `SELECT
          o.id,
          o.created_at,
          u.name AS customer_name,
          u.apartment,
          oi.quantity,
          oi.price_at_purchase,
          (oi.quantity * oi.price_at_purchase)::numeric AS total
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN users u ON u.id = o.user_id
       WHERE o.status = 'paid'
         AND o.condo_id = $1
         AND oi.product_id = $2
         AND o.created_at >= $3::timestamptz
       ORDER BY o.created_at DESC`,
      [condoId, productId, since]
    );
    res.json({ sales: rows });
  } catch (error) {
    console.error('Erro em suspect-sales:', error);
    res.status(500).json({ message: 'Erro ao buscar vendas suspeitas.' });
  }
};

exports.getSupplyRecords = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const { rows } = await pool.query(
      `SELECT sr.*, p.name AS product_name, c.name AS condo_name
       FROM supply_records sr
       LEFT JOIN products p ON p.id = sr.product_id
       LEFT JOIN condominiums c ON c.id = sr.condo_id
       ORDER BY sr.created_at DESC
       LIMIT 200`
    );
    res.json({ records: rows });
  } catch (error) {
    console.error('Erro ao buscar abastecimentos:', error);
    res.status(500).json({ message: 'Erro ao buscar abastecimentos.' });
  }
};

exports.createSupplyRecord = async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureSmartSchema(pool);
    const body = req.body || {};
    const condoId = intOrNull(body.condo_id);
    const productId = intOrNull(body.product_id);
    const quantity = Math.max(0, parseInt(body.quantity, 10) || 0);
    const unitCost = round2(body.unit_cost || 0);
    const totalCost = round2(quantity * unitCost);
    if (!condoId || !productId || quantity <= 0) return res.status(400).json({ message: 'Ponto, produto e quantidade são obrigatórios.' });

    await client.query('BEGIN');
    const { rows: productRows } = await client.query(`SELECT id, name, purchase_price FROM products WHERE id = $1 FOR UPDATE`, [productId]);
    if (!productRows.length) throw new Error('Produto não encontrado.');
    const product = productRows[0];

    const { rows: invRows } = await client.query(`SELECT quantity FROM inventory WHERE condo_id = $1 AND product_id = $2 FOR UPDATE`, [condoId, productId]);
    const currentQty = invRows[0]?.quantity || 0;
    const currentCost = round2(product.purchase_price || 0);
    const newAvgCost = unitCost > 0 ? round2(((currentQty * currentCost) + (quantity * unitCost)) / Math.max(1, currentQty + quantity)) : currentCost;

    const { rows } = await client.query(
      `INSERT INTO supply_records (condo_id, product_id, quantity, supplier, unit_cost, total_cost, expires_at, invoice, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [condoId, productId, quantity, body.supplier || null, unitCost, totalCost, body.expires_at || null, body.invoice || null, String(adminName(req))]
    );

    await client.query(
      `INSERT INTO inventory (condo_id, product_id, quantity, nearest_expiration_date, last_restock_at, last_updated)
       VALUES ($1,$2,$3,$4,NOW(),NOW())
       ON CONFLICT (condo_id, product_id)
       DO UPDATE SET
          quantity = inventory.quantity + EXCLUDED.quantity,
          nearest_expiration_date = CASE
             WHEN inventory.nearest_expiration_date IS NULL THEN EXCLUDED.nearest_expiration_date
             WHEN EXCLUDED.nearest_expiration_date IS NULL THEN inventory.nearest_expiration_date
             ELSE LEAST(inventory.nearest_expiration_date, EXCLUDED.nearest_expiration_date)
          END,
          last_restock_at = NOW(),
          last_updated = NOW()`,
      [condoId, productId, quantity, body.expires_at || null]
    );

    if (unitCost > 0) {
      await client.query(`UPDATE products SET purchase_price = $1 WHERE id = $2`, [newAvgCost, productId]);
      await client.query(
        `INSERT INTO purchase_records (product_id, product_name, supplier, unit_cost, quantity, total, invoice, bought_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE)`,
        [productId, product.name, body.supplier || null, unitCost, quantity, totalCost, body.invoice || null]
      );
    }

    await logAction(client, req, 'create_supply_record', 'supply_records', rows[0].id, 'Registro de abastecimento físico', { ...body, totalCost, newAvgCost });
    await client.query('COMMIT');
    res.status(201).json({ success: true, record: rows[0], new_purchase_price: newAvgCost });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao registrar abastecimento:', error);
    res.status(500).json({ message: error.message || 'Erro ao registrar abastecimento.' });
  } finally {
    client.release();
  }
};

exports.getInconsistencies = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const { rows } = await pool.query(
      `SELECT ai.*, p.name AS product_name, p.image_url, c.name AS condo_name
       FROM audit_inconsistencies ai
       LEFT JOIN products p ON p.id = ai.product_id
       LEFT JOIN condominiums c ON c.id = ai.condo_id
       ORDER BY ai.created_at DESC
       LIMIT 200`
    );
    res.json({ inconsistencies: rows });
  } catch (error) {
    console.error('Erro ao listar inconsistências:', error);
    res.status(500).json({ message: 'Erro ao listar inconsistências.' });
  }
};

exports.createInconsistency = async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureSmartSchema(pool);
    const body = req.body || {};
    const condoId = intOrNull(body.condo_id);
    const productId = intOrNull(body.product_id);
    const expected = parseInt(body.expected_quantity, 10) || 0;
    const counted = parseInt(body.counted_quantity, 10) || 0;
    const difference = Number.isFinite(Number(body.difference)) ? parseInt(body.difference, 10) : expected - counted;
    const estimatedLoss = round2(body.estimated_loss || 0);
    const suspectSales = Array.isArray(body.suspect_sales) ? body.suspect_sales : [];
    if (!condoId || !productId) return res.status(400).json({ message: 'Ponto e produto são obrigatórios.' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO audit_inconsistencies (condo_id, product_id, expected_quantity, counted_quantity, difference, estimated_loss, last_restock_at, suspect_sales, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'open')
       RETURNING *`,
      [condoId, productId, expected, counted, difference, estimatedLoss, body.last_restock_at || null, JSON.stringify(suspectSales)]
    );

    if (difference > 0 && estimatedLoss > 0) {
      const { rows: prodRows } = await client.query(`SELECT name FROM products WHERE id = $1`, [productId]);
      await client.query(
        `INSERT INTO loss_records (type, product_id, product_name, quantity, value, reason, status, related_inconsistency_id)
         VALUES ('furto', $1, $2, $3, $4, $5, 'em_analise', $6)`,
        [productId, prodRows[0]?.name || null, difference, estimatedLoss, 'Inconsistência de auditoria: estoque esperado maior que estoque contado.', rows[0].id]
      );
    }

    await logAction(client, req, 'create_inconsistency', 'audit_inconsistencies', rows[0].id, 'Inconsistência documentada', body);
    await client.query('COMMIT');
    res.status(201).json({ success: true, inconsistency: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao documentar inconsistência:', error);
    res.status(500).json({ message: 'Erro ao documentar inconsistência.' });
  } finally {
    client.release();
  }
};

exports.getLosses = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const { rows } = await pool.query(
      `SELECT lr.*, p.image_url
       FROM loss_records lr
       LEFT JOIN products p ON p.id = lr.product_id
       ORDER BY lr.created_at DESC
       LIMIT 300`
    );
    res.json({ losses: rows });
  } catch (error) {
    console.error('Erro ao buscar perdas:', error);
    res.status(500).json({ message: 'Erro ao buscar perdas.' });
  }
};

exports.createLoss = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const body = req.body || {};
    const productId = intOrNull(body.product_id);
    const quantity = Math.max(1, parseInt(body.quantity, 10) || 1);
    let productName = body.product_name || null;
    let value = round2(body.value || 0);
    if (productId) {
      const { rows } = await pool.query(`SELECT name, sale_price FROM products WHERE id = $1`, [productId]);
      if (rows[0]) {
        productName = productName || rows[0].name;
        if (!value) value = round2(quantity * toNumber(rows[0].sale_price, 0));
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO loss_records (type, product_id, product_name, quantity, value, reason, customer_note, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [body.type || 'perda', productId, productName, quantity, value, body.reason || null, body.customer_note || null, body.status || 'em_analise']
    );
    await logAction(pool, req, 'create_loss', 'loss_records', rows[0].id, body.reason || 'Registro de perda/furto', body);
    res.status(201).json({ success: true, loss: rows[0] });
  } catch (error) {
    console.error('Erro ao criar perda:', error);
    res.status(500).json({ message: 'Erro ao registrar perda.' });
  }
};

exports.getPurchases = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const { rows } = await pool.query(
      `SELECT pr.*, p.image_url
       FROM purchase_records pr
       LEFT JOIN products p ON p.id = pr.product_id
       ORDER BY pr.bought_at DESC, pr.created_at DESC
       LIMIT 500`
    );
    res.json({ purchases: rows });
  } catch (error) {
    console.error('Erro ao buscar compras:', error);
    res.status(500).json({ message: 'Erro ao buscar compras.' });
  }
};

exports.createPurchase = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const body = req.body || {};
    const productId = intOrNull(body.product_id);
    const quantity = Math.max(0, parseInt(body.quantity, 10) || 0);
    const unitCost = round2(body.unit_cost || 0);
    const total = round2(body.total || (quantity * unitCost));
    let productName = body.product_name || null;
    if (productId) {
      const { rows } = await pool.query(`SELECT name FROM products WHERE id = $1`, [productId]);
      productName = productName || rows[0]?.name || null;
      if (unitCost > 0) {
        await pool.query(`UPDATE products SET purchase_price = $1 WHERE id = $2`, [unitCost, productId]);
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO purchase_records (product_id, product_name, supplier, unit_cost, quantity, total, invoice, bought_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [productId, productName, body.supplier || null, unitCost, quantity, total, body.invoice || null, body.bought_at || new Date()]
    );
    await logAction(pool, req, 'create_purchase', 'purchase_records', rows[0].id, 'Registro de compra/fornecedor', body);
    res.status(201).json({ success: true, purchase: rows[0] });
  } catch (error) {
    console.error('Erro ao registrar compra:', error);
    res.status(500).json({ message: 'Erro ao registrar compra.' });
  }
};

exports.createUserWarning = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const userId = intOrNull(req.params.id);
    const { note, severity } = req.body || {};
    if (!userId || !note) return res.status(400).json({ message: 'Usuário e anotação são obrigatórios.' });
    const { rows } = await pool.query(
      `INSERT INTO user_warnings (user_id, severity, note, created_by)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [userId, severity || 'observacao', note, String(adminName(req))]
    );
    await logAction(pool, req, 'create_user_warning', 'user_warnings', rows[0].id, note, { userId, severity });
    res.status(201).json({ success: true, warning: rows[0] });
  } catch (error) {
    console.error('Erro ao criar advertência:', error);
    res.status(500).json({ message: 'Erro ao criar advertência.' });
  }
};

exports.getUserWarnings = async (req, res) => {
  try {
    await ensureSmartSchema(pool);
    const userId = intOrNull(req.params.id);
    const { rows } = await pool.query(`SELECT * FROM user_warnings WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
    res.json({ warnings: rows });
  } catch (error) {
    console.error('Erro ao listar advertências:', error);
    res.status(500).json({ message: 'Erro ao listar advertências.' });
  }
};

exports.runTodayPromotions = async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureSmartSchema(pool);
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM auto_promotion_settings WHERE id = 1`);
    const selected = await applyAutomaticPromotions(client, rows[0] || { enabled: false });
    await client.query('COMMIT');
    res.json({ success: true, selected_promotions: selected });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao rodar promoções do dia:', error);
    res.status(500).json({ message: 'Erro ao rodar promoções do dia.' });
  } finally {
    client.release();
  }
};

module.exports.calculateSmartDre = calculateSmartDre;
