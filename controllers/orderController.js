const pool = require('../db');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const mercadoPagoClient = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(mercadoPagoClient);

const normalizeCartItems = (items) => {
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error('Carrinho vazio.');
    }

    const grouped = new Map();
    for (const item of items) {
        const id = Number(item.id || item.product_id);
        const quantity = Number(item.quantity);

        if (!Number.isInteger(id) || id <= 0) {
            throw new Error('Produto inválido no carrinho.');
        }
        if (!Number.isInteger(quantity) || quantity <= 0) {
            throw new Error('Quantidade inválida no carrinho.');
        }
        if (quantity > 99) {
            throw new Error('Quantidade muito alta para uma única compra.');
        }

        grouped.set(id, (grouped.get(id) || 0) + quantity);
    }

    return Array.from(grouped.entries()).map(([id, quantity]) => ({ id, quantity }));
};

const getUserForPurchase = async (dbClient, userId, lock = true) => {
    const query = `
        SELECT id, name, email, cpf, condo_id, wallet_balance
        FROM users
        WHERE id = $1
        ${lock ? 'FOR UPDATE' : ''}
    `;
    const result = await dbClient.query(query, [userId]);
    if (result.rows.length === 0) {
        throw new Error('Usuário não encontrado.');
    }
    return result.rows[0];
};

const ensureSessionMatchesUser = (user, condoId) => {
    if (!condoId) {
        throw new Error('Condomínio/ponto de venda não informado.');
    }
    if (String(user.condo_id) !== String(condoId)) {
        throw new Error('Sessão inválida para este ponto de venda. Atualize a página pelo QR Code correto.');
    }
};

const ensureFridgeBelongsToCondo = async (dbClient, condoId, fridgeId) => {
    if (!fridgeId) {
        throw new Error('ID da geladeira não informado.');
    }
    const result = await dbClient.query(
        'SELECT id, name, fridge_id FROM condominiums WHERE id = $1',
        [condoId]
    );
    if (result.rows.length === 0) {
        throw new Error('Ponto de venda não encontrado.');
    }

    const registeredFridgeId = result.rows[0].fridge_id;
    if (registeredFridgeId && String(registeredFridgeId) !== String(fridgeId)) {
        throw new Error('Geladeira não corresponde ao ponto de venda selecionado.');
    }

    return result.rows[0];
};

const getProductDetailsFromCart = async (dbClient, items, condoId) => {
    const normalizedItems = normalizeCartItems(items);
    const productIds = normalizedItems.map(item => item.id);

    const productQuery = await dbClient.query(
        `SELECT
            p.id,
            p.name,
            p.purchase_price,
            CASE
                WHEN p.promotional_price IS NOT NULL
                 AND p.promotion_start_date IS NOT NULL
                 AND p.promotion_end_date IS NOT NULL
                 AND NOW() BETWEEN p.promotion_start_date AND p.promotion_end_date
                THEN p.promotional_price
                ELSE p.sale_price
            END AS sale_price,
            i.quantity AS stock_quantity
        FROM products p
        JOIN inventory i ON i.product_id = p.id AND i.condo_id = $2
        WHERE p.id = ANY($1::int[])
        FOR UPDATE OF i`,
        [productIds, condoId]
    );

    const productMap = productQuery.rows.reduce((map, product) => {
        map[Number(product.id)] = product;
        return map;
    }, {});

    let totalAmount = 0;
    const processedItems = normalizedItems.map(cartItem => {
        const productDetails = productMap[cartItem.id];
        if (!productDetails) {
            throw new Error(`Produto ID ${cartItem.id} não disponível neste ponto de venda.`);
        }

        const stockQuantity = Number(productDetails.stock_quantity || 0);
        if (stockQuantity < cartItem.quantity) {
            throw new Error(`Estoque insuficiente para ${productDetails.name}. Disponível: ${stockQuantity}.`);
        }

        const salePrice = Number(productDetails.sale_price || 0);
        const purchasePrice = Number(productDetails.purchase_price || 0);
        if (salePrice <= 0) {
            throw new Error(`Preço inválido para ${productDetails.name}.`);
        }

        totalAmount += salePrice * cartItem.quantity;

        return {
            id: cartItem.id,
            name: productDetails.name,
            quantity: cartItem.quantity,
            sale_price: salePrice,
            cost_at_purchase: purchasePrice
        };
    });

    return {
        processedItems,
        totalAmount: Number(totalAmount.toFixed(2))
    };
};

const insertOrderItemsAndUpdateStock = async (dbClient, orderId, condoId, processedItems) => {
    for (const item of processedItems) {
        await dbClient.query(
            `INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, cost_at_purchase)
             VALUES ($1, $2, $3, $4, $5)`,
            [orderId, item.id, item.quantity, item.sale_price, item.cost_at_purchase]
        );

        const updateResult = await dbClient.query(
            `UPDATE inventory
             SET quantity = quantity - $1, last_updated = CURRENT_TIMESTAMP
             WHERE product_id = $2 AND condo_id = $3 AND quantity >= $1`,
            [item.quantity, item.id, condoId]
        );

        if (updateResult.rowCount === 0) {
            throw new Error(`Não foi possível baixar o estoque de ${item.name}. Tente atualizar a página.`);
        }
    }
};

const createUnlockCommand = async (dbClient, fridgeId, orderId = null) => {
    try {
        await dbClient.query('INSERT INTO unlock_commands (fridge_id, order_id) VALUES ($1, $2)', [fridgeId, orderId]);
    } catch (error) {
        // Compatibilidade com bancos onde unlock_commands ainda não tem order_id.
        await dbClient.query('INSERT INTO unlock_commands (fridge_id) VALUES ($1)', [fridgeId]);
    }
};

const createPaymentDescription = async (dbClient, items, condoId) => {
    const condoResult = await dbClient.query('SELECT name FROM condominiums WHERE id = $1', [condoId]);
    const condoName = condoResult.rows[0]?.name || 'Ponto de venda';
    const itemsSummary = items.map(item => `${item.quantity}x ${item.name}`).join(', ');
    return `[${condoName}] ${itemsSummary}`.substring(0, 255);
};

exports.createWalletPaymentOrder = async (req, res) => {
    const userId = req.user.id;
    const { items, condoId, fridgeId } = req.body;

    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        const user = await getUserForPurchase(dbClient, userId, true);
        ensureSessionMatchesUser(user, condoId);
        await ensureFridgeBelongsToCondo(dbClient, condoId, fridgeId);

        const { processedItems, totalAmount } = await getProductDetailsFromCart(dbClient, items, condoId);

        if (Number(user.wallet_balance || 0) < totalAmount) {
            throw new Error('Saldo insuficiente para completar a compra.');
        }

        await dbClient.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [totalAmount, userId]);

        const newOrder = await dbClient.query(
            `INSERT INTO orders (user_id, condo_id, total_amount, status, payment_method, fridge_id)
             VALUES ($1, $2, $3, 'paid', 'wallet', $4)
             RETURNING id, total_amount, status`,
            [userId, condoId, totalAmount, fridgeId]
        );
        const orderId = newOrder.rows[0].id;

        await insertOrderItemsAndUpdateStock(dbClient, orderId, condoId, processedItems);

        let productNames = processedItems.map(item => item.name).join(', ');
        if (productNames.length > 255) productNames = productNames.substring(0, 252) + '...';

        await dbClient.query(
            `INSERT INTO wallet_transactions (user_id, type, amount, related_order_id, description)
             VALUES ($1, 'purchase', $2, $3, $4)`,
            [userId, totalAmount, orderId, `Compra ${productNames}`]
        );

        await createUnlockCommand(dbClient, fridgeId, orderId);
        await dbClient.query('COMMIT');

        res.status(201).json({
            message: 'Compra com saldo realizada com sucesso!',
            orderId,
            status: 'paid',
            totalAmount,
            items: processedItems
        });
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('ERRO AO PAGAR COM CARTEIRA:', error);
        res.status(400).json({ message: error.message || 'Erro interno ao processar pagamento com saldo.' });
    } finally {
        dbClient.release();
    }
};

exports.createCardOrder = async (req, res) => {
    const userId = req.user.id;
    const { items, token, issuer_id, payment_method_id, installments, condoId, fridgeId } = req.body;

    if (!items || !token || !payment_method_id || !condoId || !fridgeId) {
        return res.status(400).json({ message: 'Dados de pagamento ou da sessão de compra estão incompletos.' });
    }

    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        const user = await getUserForPurchase(dbClient, userId, true);
        ensureSessionMatchesUser(user, condoId);
        await ensureFridgeBelongsToCondo(dbClient, condoId, fridgeId);

        const { processedItems, totalAmount } = await getProductDetailsFromCart(dbClient, items, condoId);

        const newOrder = await dbClient.query(
            `INSERT INTO orders (user_id, condo_id, total_amount, status, payment_method, fridge_id)
             VALUES ($1, $2, $3, 'pending', 'card', $4)
             RETURNING id`,
            [userId, condoId, totalAmount, fridgeId]
        );
        const orderId = newOrder.rows[0].id;

        const description = await createPaymentDescription(dbClient, processedItems, condoId);
        const paymentResult = await payment.create({
            body: {
                transaction_amount: totalAmount,
                description,
                token,
                installments: Number(installments || 1),
                payment_method_id,
                issuer_id,
                payer: {
                    email: user.email,
                    identification: { type: 'CPF', number: String(user.cpf || '').replace(/\D/g, '') }
                },
                external_reference: String(orderId),
            }
        });

        if (paymentResult.status === 'approved') {
            await dbClient.query(
                'UPDATE orders SET status = $1, payment_gateway_id = $2 WHERE id = $3',
                ['paid', String(paymentResult.id), orderId]
            );

            await insertOrderItemsAndUpdateStock(dbClient, orderId, condoId, processedItems);
            await createUnlockCommand(dbClient, fridgeId, orderId);

            await dbClient.query('COMMIT');
            return res.status(201).json({
                status: 'approved',
                orderId,
                unlockToken: String(orderId),
                totalAmount,
                items: processedItems
            });
        }

        await dbClient.query('ROLLBACK');
        res.status(400).json({
            status: paymentResult.status,
            message: paymentResult.status_detail || 'Pagamento recusado.'
        });
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('Erro ao criar pedido com cartão:', error);
        res.status(400).json({ message: error.message || 'Falha ao processar pagamento com cartão.' });
    } finally {
        dbClient.release();
    }
};

exports.getOrderStatus = async (req, res) => {
    const { orderId } = req.params;
    const userId = req.user.id;
    try {
        const orderResult = await pool.query(
            'SELECT status FROM orders WHERE id = $1 AND user_id = $2',
            [Number(orderId), userId]
        );
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ message: 'Pedido não encontrado.' });
        }
        res.status(200).json({ status: orderResult.rows[0].status });
    } catch (error) {
        console.error(`[getOrderStatus] ERRO ao buscar pedido ${orderId}:`, error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

exports.getUnlockStatus = async (req, res) => {
    const { orderId } = req.params;
    const userId = req.user.id;
    try {
        const result = await pool.query(
            'SELECT door_opened_at FROM orders WHERE id = $1 AND user_id = $2',
            [orderId, userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Pedido não encontrado.' });
        }
        res.status(200).json({ doorOpened: !!result.rows[0].door_opened_at });
    } catch (error) {
        console.error(`Erro ao verificar status de abertura do pedido ${orderId}:`, error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

exports.confirmDoorOpened = async (req, res) => {
    const userId = req.user.id;
    const { orderId } = req.body;
    if (!orderId) {
        return res.status(400).json({ message: 'ID do pedido é obrigatório.' });
    }
    try {
        const result = await pool.query(
            `UPDATE orders
             SET door_opened_at = COALESCE(door_opened_at, NOW())
             WHERE id = $1 AND user_id = $2
             RETURNING id`,
            [orderId, userId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Pedido não encontrado.' });
        }
        res.status(200).json({ message: 'Confirmação de porta aberta recebida.' });
    } catch (error) {
        console.error(`Erro ao confirmar abertura da porta para o pedido ${orderId}:`, error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

exports.getActiveQRCodes = async (req, res) => {
    res.status(410).json({ message: 'Esta funcionalidade foi descontinuada.' });
};
