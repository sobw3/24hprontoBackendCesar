// routes/cashierRoutes.js
const express = require('express');
const router = express.Router();
const cashierController = require('../controllers/cashierController');
const { protectAdmin } = require('../middleware/authMiddleware');

router.get('/', protectAdmin, cashierController.getCashierSummary);
router.post('/withdraw', protectAdmin, cashierController.createWithdrawal);

// VERIFIQUE SE ESTA LINHA ESTÁ ATUALIZADA
router.get('/history', protectAdmin, cashierController.getMovementHistory);

// VERIFIQUE SE ESTA ROTA EXISTE
router.post('/deposits/:id/refund', protectAdmin, cashierController.refundDeposit);

module.exports = router;