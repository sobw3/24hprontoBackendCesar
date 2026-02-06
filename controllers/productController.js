const pool = require('../db');

exports.getProductsByCondo = async (req, res) => {
    const { condoId } = req.query;

    if (!condoId) {
        return res.status(400).json({ message: 'O ID do condomínio é obrigatório.' });
    }

    try {
        // --- CORREÇÃO: Adicionado 'AND p.is_archived = false' ---
        const query = `
            SELECT
                p.id, p.name, p.description, p.image_url, p.category,
                p.critical_stock_level,
                COALESCE(i.quantity, 0) AS stock,
                CASE
                    WHEN p.promotional_price IS NOT NULL AND NOW() BETWEEN p.promotion_start_date AND p.promotion_end_date
                    THEN p.promotional_price
                    ELSE p.sale_price
                END AS sale_price,
                CASE
                    WHEN p.promotional_price IS NOT NULL AND NOW() BETWEEN p.promotion_start_date AND p.promotion_end_date
                    THEN p.sale_price
                    ELSE NULL
                END AS original_price,
                CASE
                    WHEN p.promotional_price IS NOT NULL AND NOW() BETWEEN p.promotion_start_date AND p.promotion_end_date
                    THEN TRUE
                    ELSE FALSE
                END AS is_on_sale
            FROM products AS p
            JOIN inventory AS i ON p.id = i.product_id
            WHERE i.condo_id = $1 AND p.is_archived = false
            ORDER BY
                p.category, 
                is_on_sale DESC,
                p.name ASC;
        `;

        const productsResult = await pool.query(query, [condoId]);

        // --- LÓGICA DE AGRUPAMENTO POR CATEGORIA ---
        const groupedProducts = productsResult.rows.reduce((acc, product) => {
            const category = product.category || 'Outros'; 
            if (!acc[category]) {
                acc[category] = [];
            }
            acc[category].push(product);
            return acc;
        }, {});

        res.status(200).json(groupedProducts);

    } catch (error) {
        console.error('Erro ao buscar produtos:', error.message);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

// --- Função de pesquisa (MODIFICADA) ---
exports.searchProductsByName = async (req, res) => {
    const { q, condoId } = req.query;
    
    if (!q || !condoId) {
        return res.status(400).json({ message: 'Termo de pesquisa e ID do condomínio são obrigatórios.' });
    }

    try {
        const searchTerm = `%${q}%`;
        const query = `
            SELECT
                p.id,
                p.name,
                p.image_url,
                CASE
                    WHEN p.promotional_price IS NOT NULL AND NOW() BETWEEN p.promotion_start_date AND p.promotion_end_date
                    THEN p.promotional_price
                    ELSE p.sale_price
                END AS sale_price,
                CASE
                    WHEN p.promotional_price IS NOT NULL AND NOW() BETWEEN p.promotion_start_date AND p.promotion_end_date
                    THEN p.sale_price
                    ELSE NULL
                END AS original_price,
                CASE
                    WHEN p.promotional_price IS NOT NULL AND NOW() BETWEEN p.promotion_start_date AND p.promotion_end_date
                    THEN p.promotion_end_date
                    ELSE NULL
                END AS promotion_end_date
            FROM products AS p
            JOIN inventory AS i ON p.id = i.product_id
            WHERE 
                i.condo_id = $1 AND 
                i.quantity > 0 AND
                p.name ILIKE $2
            LIMIT 5; 
        `;

        const { rows } = await pool.query(query, [condoId, searchTerm]);
        res.status(200).json(rows);

    } catch (error) {
        console.error('ERRO NA PESQUISA DE PRODUTOS:', error);
        res.status(500).json({ message: 'Erro interno ao pesquisar produtos.' });
    }
};
