// CRIE ESTE NOVO ARQUIVO: routes/creditRoutes.js

const express = require('express');
const router = express.Router();
const creditController = require('../controllers/creditController');
const { protect } = require('../middleware/authMiddleware');

router.get('/summary', protect, creditController.getCreditSummary);

// Rota que o frontend irá chamar para gerar o PIX da fatura
router.post('/pay-invoice', protect, creditController.createInvoicePixPayment);

module.exports = router;