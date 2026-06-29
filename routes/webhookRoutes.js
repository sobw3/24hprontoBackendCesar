const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const cieloWebhookController = require('../controllers/cieloWebhookController');

router.post('/mercadopago', webhookController.handleMercadoPagoWebhook);
router.post('/cielo', cieloWebhookController.handleCieloWebhook);

module.exports = router;
