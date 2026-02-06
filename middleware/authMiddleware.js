// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const pool = require('../db');

// Middleware para proteger rotas de USUÁRIOS normais
exports.protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = decoded.user;
            next();
        } catch (error) {
            console.error(error);
            res.status(401).json({ message: 'Não autorizado, token falhou.' });
        }
    }

    if (!token) {
        res.status(401).json({ message: 'Não autorizado, sem token.' });
    }
};

// Middleware para proteger rotas do ADMIN
exports.protectAdmin = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            if (decoded && decoded.isAdmin) {
                req.user = decoded; 
                next();
            } else {
                res.status(403).json({ message: 'Acesso negado. Rota exclusiva para administradores.' });
            }
        } catch (error) {
            res.status(401).json({ message: 'Não autorizado, token de admin inválido.' });
        }
    }

    if (!token) {
        res.status(401).json({ message: 'Não autorizado, sem token de admin.' });
    }
};

// --- FUNÇÃO ADICIONADA DE VOLTA ---
// Middleware para proteger a rota da GELADEIRA (via chave de API)
exports.protectFridge = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];

    if (apiKey && apiKey === process.env.FRIDGE_API_KEY) {
        next(); // Chave válida, pode prosseguir
    } else {
        res.status(401).json({ message: 'Acesso não autorizado. Chave de API inválida ou ausente.' });
    }
};