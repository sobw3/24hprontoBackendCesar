// controllers/fridgeController.js

const pool = require('../db');

exports.pollForUnlock = async (req, res) => {
    const { fridgeId } = req.params;

    try {
        // --- INÍCIO DA CORREÇÃO ---
        // Esta nova consulta é "atómica". Ela encontra e apaga o comando
        // numa única operação, o que é muito mais seguro e estável.
        const query = `
            DELETE FROM unlock_commands
            WHERE id = (
                SELECT id
                FROM unlock_commands
                WHERE fridge_id = $1
                ORDER BY created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id;
        `;
        
        const result = await pool.query(query, [fridgeId]);

        // Se a consulta apagou uma linha (e a retornou), significa que encontrou um comando.
        if (result.rowCount > 0) {
            console.log(`[SUCESSO] Comando de desbloqueio ${result.rows[0].id} consumido pela geladeira: ${fridgeId}`);
            return res.status(200).json({ unlock: true });
        } else {
            // Se não apagou nenhuma linha, não havia comandos pendentes.
            return res.status(404).json({ unlock: false, message: 'Nenhum comando de desbloqueio pendente.' });
        }
        // --- FIM DA CORREÇÃO ---

    } catch (error) {
        console.error(`[ERRO] Falha no polling da geladeira ${fridgeId}:`, error);
        res.status(500).json({ unlock: false, message: 'Erro interno do servidor.' });
    }
};
