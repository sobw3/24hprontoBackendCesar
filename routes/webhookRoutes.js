const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

router.post('/mercadopago', webhookController.handleMercadoPagoWebhook);

module.exports = router;
