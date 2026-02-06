// routes/ttsRoutes.js
const express = require('express');
const router = express.Router();
const ttsController = require('../controllers/ttsController');
const { protect } = require('../middleware/authMiddleware'); // Usamos o 'protect' normal, não 'protectAdmin'

// A rota agora vive aqui, protegida para qualquer utilizador logado
router.post('/speak', protect, ttsController.synthesizeSpeech);

module.exports = router;