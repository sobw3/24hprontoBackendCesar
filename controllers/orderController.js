// controllers/orderController.js

const pool = require('../db');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const crypto = require('crypto');

const client = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN });
const payment = new Payment(client);

// --- FUNÇÕES AUXILIARES ---

// Valida a geladeira e o usuário (Sem alteração)
const validateAndGetFridgeId = async (dbClient, userId) => {
    const userResult = await dbClient.query('SELECT condo_id FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
        throw new Error('Usuário não encontrado.');
    }
    const { condo_id } = userResult.rows[0];

    const condoResult = await dbClient.query('SELECT fridge_id FROM condominiums WHERE id = $1', [condo_id]);
    if (condoResult.rows.length === 0 || !condoResult.rows[0].fridge_id) {
        throw new Error('Condomínio não encontrado ou nenhuma geladeira associada a ele.');
    }
    return condoResult.rows[0].fridge_id;
};

// Cria a descrição detalhada para o Mercado Pago (Sem alteração)
const createPaymentDescription = async (items, user, condoId) => {
    const condoResult = await pool.query('SELECT name FROM condominiums WHERE id = $1', [condoId]);
    const condoName = condoResult.rows[0]?.name || 'Condomínio';
    const itemsSummary = items.map(item => `${item.quantity}x ${item.name}`).join(', ');
    
    const fullDescription = `[${condoName}] ${itemsSummary}`;
    return fullDescription.substring(0, 255); 
};


// --- FUNÇÃO AUXILIAR PARA BUSCAR PREÇO E CUSTO CORRETOS NO SERVIDOR ---
// Esta função é CRUCIAL para evitar que o frontend envie o preço errado.
const getProductDetailsFromCart = async (items) => {
    const productIds = items.map(item => item.id);
    
    // Consulta que busca o preço promocional/venda e o preço de custo.
    const productQuery = await pool.query(
        `SELECT 
            p.id, 
            p.name, 
            p.purchase_price,
            CASE
                WHEN p.promotional_price IS NOT NULL AND NOW() BETWEEN p.promotion_start_date AND p.promotion_end_date
                THEN p.promotional_price
                ELSE p.sale_price
            END AS sale_price
        FROM products p WHERE id = ANY($1::int[])`,
        [productIds]
    );

    const productMap = productQuery.rows.reduce((map, prod) => {
        map[prod.id] = prod;
        return map;
    }, {});

    let totalAmount = 0;
    const processedItems = items.map(cartItem => {
        const productDetails = productMap[cartItem.id];
        if (!productDetails) {
            throw new Error(`Produto com ID ${cartItem.id} não encontrado.`);
        }
        
        // **CORREÇÃO: Usamos o preço de venda/promoção VERIFICADO pelo servidor**
        const salePrice = parseFloat(productDetails.sale_price);
        totalAmount += salePrice * cartItem.quantity;

        return {
            ...cartItem,
            sale_price: salePrice,
            // Custo Histórico (custo congelado)
            cost_at_purchase: parseFloat(productDetails.purchase_price) 
        };
    });

    return { processedItems, totalAmount };
};


// --- FUNÇÕES DE PAGAMENTO (ATUALIZADAS PARA USAR PREÇOS DO SERVIDOR) ---

exports.createWalletPaymentOrder = async (req, res) => {
    const userId = req.user.id;
    const { items, condoId, fridgeId } = req.body;

    if (!items || items.length === 0 || !condoId || !fridgeId) {
        return res.status(400).json({ message: 'Dados da sessão de compra são obrigatórios.' });
    }

    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        
        // **USA PREÇO E CUSTO VERIFICADOS**
        const { processedItems, totalAmount } = await getProductDetailsFromCart(req.body.items);

        const userResult = await dbClient.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const currentUser = userResult.rows[0];
        
        if (parseFloat(currentUser.wallet_balance) < totalAmount) {
            throw new Error('Saldo insuficiente para completar a compra.');
        }

        await dbClient.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [totalAmount, userId]);

        const newOrder = await dbClient.query(
            'INSERT INTO orders (user_id, condo_id, total_amount, status, payment_method, fridge_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [userId, condoId, totalAmount, 'paid', 'wallet', fridgeId]
        );
        const orderId = newOrder.rows[0].id;

        let productNames = processedItems.map(item => item.name).join(', ');
        if (productNames.length > 255) productNames = productNames.substring(0, 252) + '...';
        const description = `Compra ${productNames}`;

        for (const item of processedItems) {
            // **INSERÇÃO CORRIGIDA**
            await dbClient.query(
                'INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, cost_at_purchase) VALUES ($1, $2, $3, $4, $5)', 
                [orderId, item.id, item.quantity, item.sale_price, item.cost_at_purchase]
            );
            await dbClient.query('UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2 AND condo_id = $3', [item.quantity, item.id, condoId]);
        }

        await dbClient.query(`INSERT INTO wallet_transactions (user_id, type, amount, related_order_id, description) VALUES ($1, 'purchase', $2, $3, $4)`, [userId, totalAmount, orderId, description]);

        await dbClient.query('INSERT INTO unlock_commands (fridge_id) VALUES ($1)', [fridgeId]);
        
        await dbClient.query('COMMIT');
        res.status(201).json({ message: 'Compra com saldo realizada com sucesso!', orderId: orderId });

    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('ERRO AO PAGAR COM CARTEIRA:', error);
        res.status(500).json({ message: error.message || 'Erro interno ao processar pagamento com saldo.' });
    } finally {
        dbClient.release();
    }
};

exports.createCardOrder = async (req, res) => {
    const { items, user, token, issuer_id, payment_method_id, installments, condoId, fridgeId } = req.body;
    if (!items || !token || !payment_method_id || !user || !user.cpf || !condoId || !fridgeId) {
        return res.status(400).json({ message: 'Dados de pagamento, do utilizador ou da sessão de compra estão incompletos.' });
    }
    
    const clientDB = await pool.connect();
    try {
        await clientDB.query('BEGIN');
        
        // **USA PREÇO E CUSTO VERIFICADOS**
        const { processedItems, totalAmount } = await getProductDetailsFromCart(req.body.items);
        
        const newOrder = await clientDB.query(
            'INSERT INTO orders (user_id, condo_id, total_amount, status, payment_method, fridge_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [user.id, condoId, totalAmount, 'pending', 'card', fridgeId]
        );
        const orderId = newOrder.rows[0].id;

        for (const item of processedItems) {
            // **INSERÇÃO CORRIGIDA**
            await clientDB.query(
                'INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, cost_at_purchase) VALUES ($1, $2, $3, $4, $5)', 
                [orderId, item.id, item.quantity, item.sale_price, item.cost_at_purchase]
            );
        }

        const description = await createPaymentDescription(processedItems, user, condoId);

        const paymentData = {
            body: {
                transaction_amount: totalAmount,
                description: description,
                token: token,
                installments: installments,
                payment_method_id: payment_method_id,
                issuer_id: issuer_id,
                payer: {
                    email: user.email,
                    identification: { type: 'CPF', number: user.cpf.replace(/\D/g, '') }
                },
                external_reference: orderId.toString(),
            }
        };
        const paymentResult = await payment.create(paymentData);

        if (paymentResult.status === 'approved') {
            await clientDB.query('UPDATE orders SET status = $1, payment_gateway_id = $2 WHERE id = $3', ['paid', paymentResult.id.toString(), orderId]);
            for (const item of processedItems) {
                await clientDB.query('UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2 AND condo_id = $3', [item.quantity, item.id, condoId]);
            }
            
            await clientDB.query('INSERT INTO unlock_commands (fridge_id) VALUES ($1)', [fridgeId]);

            await clientDB.query('COMMIT');
            res.status(201).json({ status: 'approved', orderId: orderId });
        } else {
            await clientDB.query('ROLLBACK');
            res.status(400).json({ status: paymentResult.status, message: paymentResult.status_detail });
        }
    } catch (error) {
        await clientDB.query('ROLLBACK');
        console.error('Erro ao criar pedido com cartão:', error);
        res.status(500).json({ message: 'Falha ao processar pagamento com cartão.' });
    } finally {
        clientDB.release();
    }
};

exports.createCreditPaymentOrder = async (req, res) => {
    const userId = req.user.id;
    const { items, condoId, fridgeId } = req.body;

    if (!items || items.length === 0 || !condoId || !fridgeId) {
        return res.status(400).json({ message: 'Dados da sessão de compra são obrigatórios.' });
    }

    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        // **USA PREÇO E CUSTO VERIFICADOS**
        const { processedItems, totalAmount } = await getProductDetailsFromCart(req.body.items);

        const userResult = await dbClient.query('SELECT credit_limit, credit_used FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const currentUser = userResult.rows[0];

        const invoicesResult = await dbClient.query(
            "SELECT COALESCE(SUM(amount), 0)::float AS total FROM credit_invoices WHERE user_id = $1 AND status IN ('open', 'late')",
            [userId]
        );
        const pendingInvoicesAmount = invoicesResult.rows[0].total;

        const totalDebt = parseFloat(currentUser.credit_used) + pendingInvoicesAmount;
        const availableCredit = parseFloat(currentUser.credit_limit) - totalDebt;

        if (availableCredit < totalAmount) {
            throw new Error('Limite de crédito insuficiente. Pague suas faturas pendentes para liberar mais limite.');
        }

        await dbClient.query('UPDATE users SET credit_used = credit_used + $1 WHERE id = $2', [totalAmount, userId]);

        const newOrder = await dbClient.query(
            'INSERT INTO orders (user_id, condo_id, total_amount, status, payment_method, fridge_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [userId, condoId, totalAmount, 'paid', 'credit', fridgeId]
        );
        const orderId = newOrder.rows[0].id;
        
        let productNames = processedItems.map(item => item.name).join(', ');
        if (productNames.length > 255) productNames = productNames.substring(0, 252) + '...';
        const description = `Compra ${productNames}`;
        
        for (const item of processedItems) {
            // **INSERÇÃO CORRIGIDA**
            await dbClient.query(
                'INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, cost_at_purchase) VALUES ($1, $2, $3, $4, $5)', 
                [orderId, item.id, item.quantity, item.sale_price, item.cost_at_purchase]
            );
            await dbClient.query('UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2 AND condo_id = $3', [item.quantity, item.id, condoId]);
        }

        await dbClient.query(`INSERT INTO wallet_transactions (user_id, type, amount, related_order_id, description) VALUES ($1, 'credit_purchase', $2, $3, $4)`, [userId, totalAmount, orderId, description]);
        
        await dbClient.query('INSERT INTO unlock_commands (fridge_id) VALUES ($1)', [fridgeId]);
        
        await dbClient.query('COMMIT');
        res.status(201).json({ message: 'Compra com crédito realizada com sucesso!', orderId: orderId });

    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('ERRO AO PAGAR COM CRÉDITO:', error);
        res.status(500).json({ message: error.message || 'Erro interno ao processar pagamento com crédito.' });
    } finally {
        dbClient.release();
    }
};

exports.getOrderStatus = async (req, res) => {
    const { orderId } = req.params;
    const userId = req.user.id;
    try {
        const orderResult = await pool.query('SELECT status FROM orders WHERE id = $1 AND user_id = $2', [parseInt(orderId, 10), userId]);
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ message: 'Pedido não encontrado.' });
        }
        res.status(200).json({ status: orderResult.rows[0].status });
    } catch (error) {
        console.error(`[getOrderStatus] ERRO ao buscar pedido ${orderId}:`, error);
        return res.status(500).json({ message: 'Erro interno do servidor.' });
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
    const { orderId } = req.body;
    if (!orderId) {
        return res.status(400).json({ message: 'ID do pedido é obrigatório.' });
    }
    try {
        const result = await pool.query(
            "UPDATE orders SET door_opened_at = NOW() WHERE id = $1 AND door_opened_at IS NULL RETURNING id",
            [orderId]
        );
        if (result.rowCount > 0) {
            console.log(`CONFIRMAÇÃO DE ABERTURA: Porta para o pedido ${orderId} foi aberta.`);
            res.status(200).json({ message: 'Confirmação de porta aberta recebida.' });
        } else {
            console.log(`AVISO: Recebida confirmação de abertura para o pedido ${orderId}, mas ele não foi encontrado ou já estava confirmado.`);
            res.status(404).json({ message: 'Pedido não encontrado ou já confirmado.' });
        }
    } catch (error) {
        console.error(`Erro ao confirmar abertura da porta para o pedido ${orderId}:`, error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

exports.getActiveQRCodes = async (req, res) => {
    res.status(410).json({ message: "Esta funcionalidade foi descontinuada." });
};