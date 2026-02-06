// ARQUIVO: routes/orderRoutes.js (CORRIGIDO)

const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const { protect } = require('../middleware/authMiddleware');

// Log para depuração
console.log('Funções recebidas em orderRoutes:', Object.keys(orderController));

// Rota para pagar com o saldo da carteira
router.post('/pay-with-wallet', protect, orderController.createWalletPaymentOrder);
router.post('/pay-with-credit', protect, orderController.createCreditPaymentOrder);

// Rotas que você já tinha

router.post('/create-card', protect, orderController.createCardOrder);

router.get('/:orderId/status', protect, orderController.getOrderStatus);

router.get('/active-qrcodes', protect, orderController.getActiveQRCodes);

module.exports = router;