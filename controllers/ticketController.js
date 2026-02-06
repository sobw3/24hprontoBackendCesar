// controllers/ticketController.js
const pool = require('../db');

// ADMIN: Cria um tiquete para um usuário
exports.createTicketForUser = async (req, res) => {
    const { userId } = req.params;
    const { message } = req.body;
    
    // Ajuste: O id do admin é a string 'admin', podemos usar null para a DB
    const adminId = (req.user.id === 'admin') ? null : req.user.id;

    if (!message) {
        return res.status(400).json({ message: 'A mensagem é obrigatória.' });
    }

    try {
        const newTicket = await pool.query(
            "INSERT INTO user_tickets (user_id, sent_by_admin_id, message) VALUES ($1, $2, $3) RETURNING *",
            [userId, adminId, message]
        );
        res.status(201).json(newTicket.rows[0]);
    } catch (error) {
        console.error("Erro ao criar tiquete:", error);
        res.status(500).json({ message: 'Erro interno ao criar tiquete.' });
    }
};


// ADMIN: Pega os tiquetes de um usuário específico
exports.getTicketsForUserByAdmin = async (req, res) => {
    const { userId } = req.params;
    try {
        const query = `
            SELECT * FROM user_tickets 
            WHERE user_id = $1 
              AND (is_read = false OR read_at > NOW() - INTERVAL '5 minutes')
            ORDER BY created_at DESC
        `;
        const { rows } = await pool.query(query, [userId]);
        res.status(200).json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar tiquetes.' });
    }
};

// ADMIN: Apaga um tiquete
exports.deleteTicketByAdmin = async (req, res) => {
    const { ticketId } = req.params;
    try {
        await pool.query("DELETE FROM user_tickets WHERE id = $1", [ticketId]);
        res.status(200).json({ message: 'Tiquete apagado com sucesso.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao apagar tiquete.' });
    }
};

// USER: Pega os tiquetes do usuário logado (que não foram lidos ou têm menos de 24h)
exports.getUserTickets = async (req, res) => {
    const userId = req.user.id;
    try {
        const query = `
            SELECT * FROM user_tickets 
            WHERE user_id = $1 
              AND (is_read = false OR created_at > NOW() - INTERVAL '24 hours')
            ORDER BY created_at DESC
        `;
        const { rows } = await pool.query(query, [userId]);
        res.status(200).json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar seus tiquetes.' });
    }
};

// USER: Marca um tiquete como lido
exports.markTicketAsRead = async (req, res) => {
    const { ticketId } = req.params;
    const userId = req.user.id;
    try {
        const result = await pool.query(
            "UPDATE user_tickets SET is_read = true, read_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *",
            [ticketId, userId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Tiquete não encontrado ou não pertence a você.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao marcar tiquete como lido.' });
    }
};

// USER: Conta tiquetes não lidos
exports.getUnreadTicketsCount = async (req, res) => {
    const userId = req.user.id;
    try {
        const { rows } = await pool.query(
            "SELECT COUNT(*)::int FROM user_tickets WHERE user_id = $1 AND is_read = false",
            [userId]
        );
        res.status(200).json({ count: rows[0].count });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao contar tiquetes.' });
    }
};

const createSystemTicket = async (userId, message) => {
    try {
        await pool.query(
            "INSERT INTO user_tickets (user_id, sent_by_admin_id, message) VALUES ($1, NULL, $2)",
            [userId, message]
        );
        console.log(`Tiquete automático enviado para o utilizador ${userId}: "${message}"`);
    } catch (error) {
        console.error(`Falha ao enviar tiquete automático para o utilizador ${userId}:`, error);
    }
};

// Agora, exporte a nova função juntamente com as existentes
module.exports = {
    ...exports, // Mantém todas as exportações antigas
    createSystemTicket // Adiciona a nova função para que outros ficheiros a possam usar
};