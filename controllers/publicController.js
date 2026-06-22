const pool = require('../db');

// --- Função para Listar Condomínios Disponíveis ---
exports.getAvailableCondominiums = async (req, res) => {
    try {
        // ALTERAÇÃO: Adicionado 'fridge_id' à consulta SQL
        const allCondos = await pool.query("SELECT id, name, fridge_id FROM condominiums ORDER BY name ASC");
        res.status(200).json(allCondos.rows);
    } catch (error) {
        console.error("Erro ao buscar condomínios públicos:", error.message);
        res.status(500).json({ message: error.message });
    }
};

// PONTO 6: Nova função para validar o ID da geladeira
exports.validateFridgeId = async (req, res) => {
    const { condoId, fridgeId } = req.body;

    if (!condoId || !fridgeId) {
        return res.status(400).json({ valid: false, message: 'ID do condomínio e da geladeira são obrigatórios.' });
    }

    try {
        const result = await pool.query(
            "SELECT id FROM condominiums WHERE id = $1 AND fridge_id = $2",
            [condoId, fridgeId]
        );

        if (result.rows.length > 0) {
            res.status(200).json({ valid: true });
        } else {
            res.status(404).json({ valid: false, message: 'ID da geladeira não corresponde ao condomínio selecionado.' });
        }
    } catch (error) {
        console.error("Erro ao validar ID da geladeira:", error);
        res.status(500).json({ valid: false, message: 'Erro interno do servidor.' });
    }
};

// Promoções do dia para a Home do cliente final.
// Mostra produtos em promoção independentemente da máquina selecionada,
// e inclui para qual ponto/máquina o cliente deve ir ao clicar.
exports.getPublicDailyPromotions = async (req, res) => {
    try {
        const query = `
            SELECT
                p.id,
                p.name,
                p.image_url,
                p.sale_price AS original_price,
                p.promotional_price AS sale_price,
                p.promotional_price,
                p.promotion_end_date,
                p.category,
                MIN(c.id) AS condo_id,
                MIN(c.name) AS condo_name,
                MIN(c.fridge_id) AS fridge_id,
                COALESCE(SUM(i.quantity), 0)::int AS stock
            FROM products p
            JOIN inventory i ON i.product_id = p.id AND i.quantity > 0
            JOIN condominiums c ON c.id = i.condo_id
            WHERE COALESCE(p.is_archived, FALSE) = FALSE
              AND p.promotional_price IS NOT NULL
              AND p.promotion_start_date IS NOT NULL
              AND p.promotion_end_date IS NOT NULL
              AND NOW() BETWEEN p.promotion_start_date AND p.promotion_end_date
            GROUP BY p.id
            ORDER BY RANDOM()
            LIMIT 12
        `;
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Erro ao buscar promoções públicas:', error);
        res.status(500).json({ message: 'Erro ao buscar promoções do dia.' });
    }
};
