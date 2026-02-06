const express = require('express');
const router = express.Router();
const publicController = require('../controllers/publicController');
const { protect } = require('../middleware/authMiddleware'); // Importar protect

// Rota para buscar todos os condomínios disponíveis para o cadastro
// GET /api/public/condominiums
router.get('/condominiums', publicController.getAvailableCondominiums);

// PONTO 6: Nova rota para validar o ID da geladeira (protegida)
router.post('/validate-fridge', protect, publicController.validateFridgeId);

module.exports = router;
