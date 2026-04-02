const express = require('express');
const cors = require('cors');
require('dotenv').config();
const ttsRoutes = require('./routes/ttsRoutes');

// Importar seu arquivo de conexão com o banco para o teste
const pool = require('./db'); 

// Importar TODAS as suas rotas
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orderRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const adminRoutes = require('./routes/adminRoutes');
const publicRoutes = require('./routes/publicRoutes');
const fridgeRoutes = require('./routes/fridgeRoutes');
const walletRoutes = require('./routes/walletRoutes');
const cashierRoutes = require('./routes/cashierRoutes');
const userRoutes = require('./routes/userRoutes');

// O agendador não será iniciado, mas a importação pode permanecer
const promotionScheduler = require('./services/promotionScheduler');

const app = express();

// Configuração de CORS
const corsOptions = {
    origin: process.env.CORS_ORIGIN || '*',
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Middleware para interpretar o corpo das requisições como JSON
app.use(express.json());

// Middleware para logar os pedidos
app.use((req, res, next) => {
    console.log(`Pedido recebido: ${req.method} ${req.originalUrl}`);
    next();
});

// Rotas da API
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/fridge', fridgeRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin/central-cashier', cashierRoutes);
app.use('/api/user', userRoutes);
app.use('/api/tts', ttsRoutes);

// --- ROTA DE DIAGNÓSTICO DO BANCO (TESTE NA RENDER) ---
app.get('/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() as tempo_atual, current_database() as nome_banco');
        res.json({ 
            success: true, 
            message: "🚀 Backend conectado ao Banco com sucesso!",
            detalhes: result.rows[0]
        });
    } catch (err) {
        console.error("ERRO NO TEST-DB:", err.message);
        res.status(500).json({ 
            success: false, 
            error: err.message,
            stack: "Verifique o SSL no seu db.js ou a DATABASE_URL na Render" 
        });
    }
});

// Rota de teste simples
app.get('/', (req, res) => {
    res.send('API da SmartFridge Brasil está funcionando!');
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`🚀 SUCESSO! Servidor rodando perfeitamente na porta ${PORT}`);
});

module.exports = app;
