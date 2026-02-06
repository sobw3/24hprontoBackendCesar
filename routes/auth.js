const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/me', protect, authController.getMe);
router.put('/update-condo', protect, authController.updateUserCondo);
router.put('/me', protect, authController.updateMe);
router.post('/verify-user', authController.verifyUserForReset);
router.post('/reset-password', authController.resetPassword);

module.exports = router;
