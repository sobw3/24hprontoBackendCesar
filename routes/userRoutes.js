// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
// --- CORREÇÃO AQUI: Importar 'protect' e não 'protectAdmin' ---
const { protect } = require('../middleware/authMiddleware');
const userController = require('../controllers/userController');

// Rotas de Tiquetes do usuário
// --- CORREÇÃO AQUI: Usar 'protect' em todas as rotas ---
router.get('/tickets', protect, ticketController.getUserTickets);
router.get('/tickets/unread-count', protect, ticketController.getUnreadTicketsCount);
router.post('/tickets/:ticketId/read', protect, ticketController.markTicketAsRead);
router.get('/history', protect, userController.getUserHistory);

module.exports = router;