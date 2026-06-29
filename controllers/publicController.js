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
