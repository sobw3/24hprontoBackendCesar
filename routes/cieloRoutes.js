// routes/cieloRoutes.js
const express = require('express');
const router = express.Router();
const cieloCheckoutController = require('../controllers/cieloCheckoutController');

router.post('/pix-order', cieloCheckoutController.createPixOrder);
router.post('/card-order', cieloCheckoutController.createCardOrder);
router.get('/orders/:orderId/status', cieloCheckoutController.getCieloOrderStatus);

module.exports = router;
