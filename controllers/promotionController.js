// controllers/promotionController.js
const pool = require('../db');

exports.getDailyPromotions = async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT id, name, image_url, sale_price, promotional_price, promotion_end_date 
            FROM products 
            WHERE NOW() BETWEEN promotion_start_date AND promotion_end_date
            ORDER BY name
        `);
        res.status(200).json(rows);
    } catch (error) {
        console.error("Erro ao buscar promoções do dia:", error);
        res.status(500).json({ message: "Erro ao buscar promoções do dia." });
    }
};