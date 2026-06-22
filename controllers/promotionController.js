const pool = require('../db');

exports.getDailyPromotions = async (req, res) => {
    try {
        // Algumas bases antigas ainda não possuem colunas de promoção.
        // Nesse caso, retornamos lista vazia em vez de derrubar o dashboard.
        const columns = await pool.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'products'
              AND column_name IN ('promotional_price', 'promotion_start_date', 'promotion_end_date')
        `);
        if (columns.rowCount < 3) {
            return res.status(200).json([]);
        }

        const { rows } = await pool.query(`
            SELECT id, name, image_url, sale_price, promotional_price, promotion_end_date
            FROM products
            WHERE promotional_price IS NOT NULL
              AND promotion_start_date IS NOT NULL
              AND promotion_end_date IS NOT NULL
              AND NOW() BETWEEN promotion_start_date AND promotion_end_date
            ORDER BY name ASC
        `);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Erro ao buscar promoções do dia:', error);
        res.status(500).json({ message: 'Erro ao buscar promoções do dia.' });
    }
};
