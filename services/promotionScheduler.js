// services/promotionScheduler.js
const cron = require('node-cron');
const pool = require('../db');

const runDailyPromotionCycle = async () => {
    console.log(`[${new Date().toLocaleString('pt-BR')}] Executando ciclo de promoções diárias...`);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Limpa as promoções do dia anterior (que já expiraram)
        const cleanupResult = await client.query(
            "UPDATE products SET promotion_start_date = NULL, promotion_end_date = NULL WHERE promotion_end_date <= NOW()"
        );
        console.log(`${cleanupResult.rowCount} promoções antigas foram desativadas.`);

        // 2. Busca 3 produtos aleatórios que tenham estoque e não estejam em promoção
        const { rows: productsToPromote } = await client.query(`
            SELECT p.id FROM products p
            JOIN inventory i ON p.id = i.product_id
            WHERE i.quantity > 0 AND p.promotion_start_date IS NULL
            GROUP BY p.id
            ORDER BY RANDOM()
            LIMIT 3;
        `);

        if (productsToPromote.length === 0) {
            console.log("Nenhum produto elegível encontrado para a promoção diária.");
            await client.query('COMMIT');
            return;
        }

        const productIds = productsToPromote.map(p => p.id);

        // 3. Ativa a promoção para os produtos selecionados, com duração de 24 horas
        const promotionResult = await client.query(`
            UPDATE products 
            SET promotion_start_date = NOW(), 
                promotion_end_date = NOW() + INTERVAL '1 day'
            WHERE id = ANY($1::int[])
        `, [productIds]);

        console.log(`${promotionResult.rowCount} novos produtos foram colocados em promoção: ${productIds.join(', ')}`);

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("ERRO no ciclo de promoções diárias:", error);
    } finally {
        client.release();
    }
};

// Agenda a tarefa para rodar todo dia à meia-noite e cinco minutos (00:05)
exports.start = () => {
    cron.schedule('30 11 * * *', runDailyPromotionCycle, {
        timezone: "America/Sao_Paulo"
    });
    console.log('Agendador de promoções diárias iniciado. Irá rodar às 11:30 (horário de Brasília).');
};
