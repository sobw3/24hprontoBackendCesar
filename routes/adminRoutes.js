const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const ticketController = require('../controllers/ticketController');
const promotionController = require('../controllers/promotionController');
const intelligenceController = require('../controllers/intelligenceController');
const { protectAdmin } = require('../middleware/authMiddleware');

// --- AUTENTICAÇÃO ---
router.post('/login', adminController.loginAdmin);

// --- DASHBOARD / VISÃO GERAL ---
router.get('/dashboard-stats', protectAdmin, adminController.getDashboardStats);
router.get('/critical-stock', protectAdmin, adminController.getCriticalStockWidget);
router.get('/critical-stock-page', protectAdmin, adminController.getCriticalStockPage);
router.get('/inventory-analysis', protectAdmin, adminController.getInventoryAnalysis);
router.get('/latest-orders', protectAdmin, adminController.getLatestOrders);
router.get('/dashboard/expiring-products', protectAdmin, adminController.getExpiringProducts);
router.get('/promotions/daily', protectAdmin, promotionController.getDailyPromotions);

// --- VENDAS / RELATÓRIOS ---
router.get('/sales', protectAdmin, adminController.getSalesHistory);
router.get('/sales/:orderId/items', protectAdmin, adminController.getOrderDetails);
router.post('/orders/:orderId/refund', protectAdmin, adminController.refundOrder);

// --- PONTOS DE VENDA / CONDOMÍNIOS ---
router.post('/condominiums', protectAdmin, adminController.createCondominium);
router.get('/condominiums', protectAdmin, adminController.getCondominiums);
router.put('/condominiums/:id', protectAdmin, adminController.updateCondominium);
router.delete('/condominiums/:id', protectAdmin, adminController.deleteCondominium);

// --- ESTOQUE E INVENTÁRIO ---
router.get('/inventory', protectAdmin, adminController.getInventoryByCondo);
router.post('/inventory', protectAdmin, adminController.updateInventory);
router.delete('/inventory', protectAdmin, adminController.removeProductFromInventory);
router.post('/inventory/bulk-update', protectAdmin, adminController.bulkUpdateInventory);
router.get('/inventory/expiring', protectAdmin, adminController.getExpiringProducts);
router.get('/purchase-history', protectAdmin, adminController.getPurchaseHistory);
router.post('/inventory/purchase', protectAdmin, adminController.registerPurchase);
router.get('/inventory/pending-restocks', protectAdmin, adminController.getPendingRestocks);
router.post('/inventory/execute-restock', protectAdmin, adminController.executePhysicalRestock);
router.get('/inventory/audits', protectAdmin, adminController.getStockAudits);
router.get('/inventory/audit/:auditId', protectAdmin, adminController.getAuditDetails);

// --- FINANCEIRO ---
router.get('/financial/stats', protectAdmin, adminController.getFinancialStats);
router.get('/finance/report', protectAdmin, adminController.getFinancialReport);
router.get('/finance/expenses', protectAdmin, adminController.getExpenses);
router.post('/finance/expenses', protectAdmin, adminController.createExpense);
router.put('/finance/expenses/:id/pay', protectAdmin, adminController.markExpenseAsPaid);
router.delete('/finance/expenses/:id', protectAdmin, adminController.deleteExpense);
router.post('/finance/transactions', protectAdmin, adminController.createFinancialTransaction);
router.delete('/finance/transactions/:id', protectAdmin, adminController.deleteFinancialTransaction);

// --- HARDWARE / SEGURANÇA OPERACIONAL ---
router.post('/fridges/:fridgeId/unlock', protectAdmin, adminController.remoteUnlockFridge);

// --- PRODUTOS ---
router.post('/products', protectAdmin, adminController.createProduct);
router.get('/products', protectAdmin, adminController.getProducts);
router.put('/products/:id', protectAdmin, adminController.updateProduct);
router.delete('/products/:id', protectAdmin, adminController.deleteProduct);

// --- CAIXA CENTRAL ---
router.get('/cashier/summary', protectAdmin, adminController.getCashierSummary);
router.get('/cashier/history', protectAdmin, adminController.getMovementHistory);
router.post('/cashier/withdraw', protectAdmin, adminController.createWithdrawal);

// --- GESTÃO DE USUÁRIOS ---
router.get('/users-paginated', protectAdmin, adminController.getUsersByCondoPaginated);
router.get('/users-by-condo', protectAdmin, adminController.getUsersByCondo);
router.put('/users/:id', protectAdmin, adminController.updateUserByAdmin);
router.post('/users/:id/add-balance', protectAdmin, adminController.addWalletBalanceByAdmin);
router.post('/users/:id/toggle-status', protectAdmin, adminController.toggleUserStatus);


// --- INTELIGÊNCIA DO FRANQUEADO / NOVO PAINEL MOBILE ---
router.get('/operations/summary', protectAdmin, intelligenceController.getOperationsSummary);
router.get('/finance/smart-dre', protectAdmin, intelligenceController.getSmartDre);
router.post('/finance/smart-config', protectAdmin, intelligenceController.saveSmartFinanceConfig);
router.get('/promotions/automation', protectAdmin, intelligenceController.getPromotionAutomation);
router.post('/promotions/automation', protectAdmin, intelligenceController.savePromotionAutomation);
router.post('/promotions/automation/run-today', protectAdmin, intelligenceController.runTodayPromotions);
router.get('/audit/suspect-sales', protectAdmin, intelligenceController.getSuspectSales);
router.get('/supply-records', protectAdmin, intelligenceController.getSupplyRecords);
router.post('/supply-records', protectAdmin, intelligenceController.createSupplyRecord);
router.get('/audit/inconsistencies', protectAdmin, intelligenceController.getInconsistencies);
router.post('/audit/inconsistencies', protectAdmin, intelligenceController.createInconsistency);
router.get('/losses', protectAdmin, intelligenceController.getLosses);
router.post('/losses', protectAdmin, intelligenceController.createLoss);
router.get('/purchases', protectAdmin, intelligenceController.getPurchases);
router.post('/purchases', protectAdmin, intelligenceController.createPurchase);
router.get('/users/:id/warnings', protectAdmin, intelligenceController.getUserWarnings);
router.post('/users/:id/warnings', protectAdmin, intelligenceController.createUserWarning);

// --- SUPORTE / AJUDA ---
router.post('/users/:userId/tickets', protectAdmin, ticketController.createTicketForUser);
router.get('/users/:userId/tickets', protectAdmin, ticketController.getTicketsForUserByAdmin);
router.delete('/tickets/:id', protectAdmin, ticketController.deleteTicketByAdmin);

module.exports = router;
