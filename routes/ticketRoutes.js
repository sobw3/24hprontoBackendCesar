// routes/ticketRoutes.js
const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
const { protect, protectAdmin } = require('../middleware/authMiddleware');

// --- Rotas para o Usuário ---
router.get('/', protect, ticketController.getUserTickets);
router.get('/unread-count', protect, ticketController.getUnreadTicketsCount);
router.post('/:ticketId/read', protect, ticketController.markTicketAsRead);

// --- Rotas para o Admin ---
router.post('/user/:userId', protectAdmin, ticketController.createTicketForUser);
router.get('/user/:userId', protectAdmin, ticketController.getTicketsForUserByAdmin);
router.delete('/:ticketId', protectAdmin, ticketController.deleteTicketByAdmin);

module.exports = router;