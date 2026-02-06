// ===============================================================
// ARQUIVO: routes/products.js (VERSÃO ATUALIZADA)
// ===============================================================
const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');

// Rota para buscar produtos de um condomínio específico
router.get('/', productController.getProductsByCondo);

// Rota para pesquisar produtos por nome
router.get('/search', productController.searchProductsByName);

module.exports = router;