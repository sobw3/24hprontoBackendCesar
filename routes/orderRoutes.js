const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const { protect } = require('../middleware/authMiddleware');

// Compra pelo saldo da carteira
router.post('/pay-with-wallet', protect, orderController.createWalletPaymentOrder);

// Compra com cartão direto
router.post('/create-card', protect, orderController.createCardOrder);

// Status do pedido/pagamento
router.get('/:orderId/status', protect, orderController.getOrderStatus);
router.get('/:orderId/unlock-status', protect, orderController.getUnlockStatus);
router.post('/confirm-door-opened', protect, orderController.confirmDoorOpened);

// Legado
router.get('/active-qrcodes', protect, orderController.getActiveQRCodes);

module.exports = router;
