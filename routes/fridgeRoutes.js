const express = require('express');
const router = express.Router();
const fridgeController = require('../controllers/fridgeController');
const { protectFridge } = require('../middleware/authMiddleware');


// Rota que a geladeira irá chamar para verificar se há um token de desbloqueio
router.get('/poll-unlock/:fridgeId', protectFridge, fridgeController.pollForUnlock);

module.exports = router;

