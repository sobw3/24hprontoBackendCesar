/*
 * =================================================================
 * API Backend - SmartFridge Brasil
 * =================================================================
 * * Este é o código inicial para o servidor backend da sua aplicação.
 * Ele usa Node.js e Express.js.
 * * --- ESTRUTURA DOS ARQUIVOS (Exemplo) ---
 * * /
 * |- index.js             (Este arquivo - Ponto de entrada do servidor)
 * |- /routes
 * |  |- auth.js           (Rotas para autenticação: /register, /login)
 * |  |- products.js       (NOVO - Rotas para produtos)
 * |- /controllers
 * |  |- authController.js (Lógica para registrar e logar usuários)
 * |  |- productController.js (NOVO - Lógica para produtos)
 * |- package.json         (Dependências do projeto - listadas abaixo)
 * * * --- DEPENDÊNCIAS PARA INSTALAR ---
 * Você precisará instalar estas bibliotecas para o projeto funcionar:
 * * npm install express pg bcryptjs jsonwebtoken cors dotenv
 * * - express: Framework para criar o servidor e as rotas da API.
 * - pg: Driver para conectar o Node.js ao banco de dados PostgreSQL.
 * - bcryptjs: Para criptografar e verificar senhas com segurança.
 * - jsonwebtoken: Para criar e verificar os tokens de acesso (JWT).
 * - cors: Para permitir que o seu frontend (React) se comunique com esta API.
 * - dotenv: Para gerenciar variáveis de ambiente (como senhas do banco).
 * */


// ===============================================================
// ARQUIVO: index.js (Ponto de entrada principal do servidor)
// ===============================================================

const express = require('express');
const cors = require('cors');
require('dotenv').config(); // Carrega variáveis de ambiente do arquivo .env

// Importar rotas
const authRoutes = require('./routes/auth'); // As rotas de autenticação
const productRoutes = require('./routes/products'); // NOVO: Importa rotas de produtos

const app = express();
const PORT = process.env.PORT || 5000; // Usa a porta do ambiente ou 5000 como padrão

// --- Middlewares Essenciais ---
app.use(cors()); // Habilita CORS para permitir requisições de outros domínios (seu frontend)
app.use(express.json()); // Permite que o servidor entenda JSON no corpo das requisições

// --- Rotas da API ---
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes); // NOVO: Adiciona as rotas de produtos
// Futuras rotas serão adicionadas aqui:
// app.use('/api/orders', orderRoutes);
// etc.

// Rota de teste para verificar se o servidor está no ar
app.get('/', (req, res) => {
    res.send('API da SmartFridge Brasil está funcionando!');
});


app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});


// ===============================================================
// ARQUIVO: routes/auth.js (Define os endpoints de autenticação)
// ===============================================================

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Rota para registrar um novo usuário
// POST /api/auth/register
router.post('/register', authController.register);

// Rota para fazer login
// POST /api/auth/login
router.post('/login', authController.login);

module.exports = router;


// ===============================================================
// ARQUIVO NOVO: routes/products.js 
// (Define os endpoints para manipulação de produtos)
// ===============================================================

const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
// const authMiddleware = require('../middleware/authMiddleware'); // Futuramente, para proteger rotas

// Rota para buscar produtos de um condomínio específico
// GET /api/products?condoId=1
// Futuramente, adicionaremos o 'authMiddleware' antes do controller para proteger a rota.
// Ex: router.get('/', authMiddleware, productController.getProductsByCondo);
router.get('/', productController.getProductsByCondo);

module.exports = router;


// ===============================================================
// ARQUIVO: controllers/authController.js (Contém a lógica de negócio de autenticação)
// ===============================================================

const pool = require('../db'); 
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// --- Função de Cadastro ---
exports.register = async (req, res) => {
    const { name, cpf, email, password, birth_date, condo_id } = req.body;

    if (!name || !cpf || !email || !password || !birth_date || !condo_id) {
        return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    }

    try {
        const userExists = await pool.query(
            "SELECT * FROM users WHERE cpf = $1 OR email = $2",
            [cpf, email]
        );

        if (userExists.rows.length > 0) {
            return res.status(409).json({ message: 'CPF ou e-mail já cadastrado.' });
        }

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        const newUser = await pool.query(
            "INSERT INTO users (name, cpf, email, password_hash, birth_date, condo_id, wallet_balance) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, email",
            [name, cpf, email, password_hash, birth_date, condo_id, 0]
        );

        res.status(201).json({
            message: 'Usuário cadastrado com sucesso!',
            user: newUser.rows[0]
        });

    } catch (error) {
        console.error('Erro no registro:', error.message);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

// --- Função de Login ---
exports.login = async (req, res) => {
    const { cpf, password } = req.body;

    if (!cpf || !password) {
        return res.status(400).json({ message: 'CPF e senha são obrigatórios.' });
    }

    try {
        const userResult = await pool.query("SELECT * FROM users WHERE cpf = $1", [cpf]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ message: 'CPF ou senha inválidos.' });
        }
        
        const payload = {
            user: {
                id: user.id,
                name: user.name,
                condo_id: user.condo_id
            }
        };

        jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: '7d' },
            (err, token) => {
                if (err) throw err;
                res.json({
                    message: 'Login bem-sucedido!',
                    token,
                    user: {
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        condoId: user.condo_id
                    }
                });
            }
        );

    } catch (error) {
        console.error('Erro no login:', error.message);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};


// ===============================================================
// ARQUIVO NOVO: controllers/productController.js 
// (Contém a lógica de negócio para produtos)
// ===============================================================

const pool = require('../db');

// --- Função para buscar produtos por condomínio ---
exports.getProductsByCondo = async (req, res) => {
    const { condoId } = req.query;

    if (!condoId) {
        return res.status(400).json({ message: 'O ID do condomínio é obrigatório.' });
    }

    try {
        // Esta query junta a tabela de produtos com a de inventário
        // para pegar as informações do produto e a quantidade em estoque
        // apenas para o condomínio especificado e com estoque > 0.
        const query = `
            SELECT
                p.id,
                p.name,
                p.description,
                p.image_url,
                p.sale_price,
                i.quantity AS stock
            FROM products AS p
            JOIN inventory AS i ON p.id = i.product_id
            WHERE i.condo_id = $1 AND i.quantity > 0
        `;

        const productsResult = await pool.query(query, [condoId]);

        res.status(200).json(productsResult.rows);

    } catch (error) {
        console.error('Erro ao buscar produtos:', error.message);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};


// ===============================================================
// ARQUIVO: db.js (Configuração da conexão com o PostgreSQL)
// ===============================================================
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

module.exports = pool;


// ===============================================================
// ARQUIVO: .env (Exemplo de arquivo de variáveis de ambiente)
// ===============================================================
/*
# Crie um arquivo chamado .env na raiz do seu projeto
# e adicione as seguintes variáveis com seus dados.

# Configuração do Servidor
PORT=5000

# Configuração do Banco de Dados PostgreSQL
DB_USER=seu_usuario_do_banco
DB_HOST=localhost
DB_DATABASE=smartfridge_db
DB_PASSWORD=sua_senha_do_banco
DB_PORT=5432

# Chave Secreta para o JWT (use um gerador de string aleatória e segura)
JWT_SECRET=MINHA_CHAVE_SECRETA_MUITO_LONGA_E_SEGURA_PARA_PRODUCAO
*/
