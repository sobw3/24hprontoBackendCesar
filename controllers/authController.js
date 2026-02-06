// sobw3/backendsmart/backendsmart-a691fbac7367ed29d2e67cae6bd0bd5ddac8ecef/authController.js

const pool = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createSystemTicket } = require('./ticketController');

// Funções de validação (permanecem as mesmas)
const validateCPF = (cpf) => {
    cpf = cpf.replace(/[^\d]+/g,'');
    if(cpf === '') return false;
    if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
    let add = 0;
    for (let i=0; i < 9; i ++) add += parseInt(cpf.charAt(i)) * (10 - i);
    let rev = 11 - (add % 11);
    if (rev === 10 || rev === 11) rev = 0;
    if (rev !== parseInt(cpf.charAt(9))) return false;
    add = 0;
    for (let i = 0; i < 10; i ++) add += parseInt(cpf.charAt(i)) * (11 - i);
    rev = 11 - (add % 11);
    if (rev === 10 || rev === 11) rev = 0;
    if (rev !== parseInt(cpf.charAt(10))) return false;
    return true;
};
const validateEmail = (email) => {
    const re = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return re.test(String(email).toLowerCase());
};
const validatePhoneNumber = (phone) => {
    const re = /^(?:(?:\+|00)?(55)\s?)?(?:\(?([1-9][0-9])\)?\s?)?(?:((?:9\d|[2-9])\d{3})-?(\d{4}))$/;
    return re.test(phone);
};


exports.register = async (req, res) => {
    // --- condo_id REMOVIDO DAQUI ---
    const { name, cpf, email, password, birth_date, apartment, phone_number } = req.body;
    
    // --- ID DA MÁQUINA/CONDOMÍNIO PRINCIPAL (Hardcoded) ---
    const DEFAULT_CONDO_ID = 1;
    
    // Validações
    if (!name || !cpf || !email || !password || !birth_date || !apartment || !phone_number) {
        return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    }
    if (!validateCPF(cpf)) {
        return res.status(400).json({ message: 'CPF inválido.' });
    }
    if (!validateEmail(email)) {
        return res.status(400).json({ message: 'Formato de e-mail inválido.' });
    }
    if (!validatePhoneNumber(phone_number)) {
        return res.status(400).json({ message: 'Formato de número de telefone inválido.' });
    }
    if (apartment.length < 2) {
         return res.status(400).json({ message: 'Formato do apartamento inválido.' });
    }

    try {
        const userExists = await pool.query("SELECT * FROM users WHERE cpf = $1 OR email = $2", [cpf, email]);
        if (userExists.rows.length > 0) {
            return res.status(409).json({ message: 'CPF ou e-mail já cadastrado.' });
        }
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        
        // --- QUERY ATUALIZADA ---
        const newUser = await pool.query(
            "INSERT INTO users (name, cpf, email, password_hash, birth_date, condo_id, apartment, phone_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
            [name, cpf, email, password_hash, birth_date, DEFAULT_CONDO_ID, apartment, phone_number]
        );

        const newUserId = newUser.rows[0].id;
        const welcomeMessage = `Olá, ${name.split(' ')[0]}! Seja bem-vindo(a) à SmartFridge. Estamos felizes por tê-lo(a) connosco.`;
        await createSystemTicket(newUserId, welcomeMessage);
        
        // --- RESPOSTA ATUALIZADA COM SALDO ---
        const user = newUser.rows[0];
        const payload = {
            id: user.id, 
            name: user.name, 
            condoId: user.condo_id,
            email: user.email, 
            cpf: user.cpf, 
            // AQUI ESTÁ A CORREÇÃO:
            wallet_balance: parseFloat(user.wallet_balance || 0), 
            credit_limit: user.credit_limit,
            credit_used: user.credit_used, 
            credit_due_day: user.credit_due_day
        };

        jwt.sign({ user: payload }, process.env.JWT_SECRET, { expiresIn: '7d' }, (err, token) => {
            if (err) throw err;
            res.status(201).json({ message: 'Usuário cadastrado com sucesso!', token, user: payload });
        });
        
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

// ALTERADO: Adicionada verificação `is_active` e mais dados no payload
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

        if (!user.is_active) {
            return res.status(403).json({ message: 'Esta conta está bloqueada. Por favor, entre em contato com o suporte.' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: 'CPF ou senha inválidos.' });
        }
        
        // --- PAYLOAD ATUALIZADO COM SALDO ---
        const payload = {
            id: user.id,
            name: user.name,
            condoId: user.condo_id,
            email: user.email,
            cpf: user.cpf,
            // AQUI ESTÁ A CORREÇÃO:
            wallet_balance: parseFloat(user.wallet_balance || 0),
            credit_limit: user.credit_limit,
            credit_used: user.credit_used,
            credit_due_day: user.credit_due_day
        };

        jwt.sign({ user: payload }, process.env.JWT_SECRET, { expiresIn: '7d' }, (err, token) => {
            if (err) throw err;
            res.json({ message: 'Login bem-sucedido!', token, user: payload });
        });
    } catch (error) {
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

exports.getMe = async (req, res) => {
    try {
        const userResult = await pool.query(
            // --- CORREÇÃO AQUI: Adicionado 'birth_date' ao SELECT ---
            'SELECT id, name, email, condo_id, cpf, phone_number, apartment, wallet_balance, credit_limit, credit_used, credit_due_day, birth_date FROM users WHERE id = $1', 
            [req.user.id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'Utilizador do token não encontrado.' });
        }
        
        res.status(200).json(userResult.rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar dados do utilizador.' });
    }
};

// As outras funções (updateUserCondo, updateMe, verifyUserForReset, resetPassword) permanecem as mesmas
exports.updateUserCondo = async (req, res) => {
    const userId = req.user.id;
    const { condoId } = req.body;
    if (!condoId) {
        return res.status(400).json({ message: 'O ID do condomínio é obrigatório.' });
    }
    try {
        const updatedUser = await pool.query(
            'UPDATE users SET condo_id = $1 WHERE id = $2 RETURNING id, name, email, condo_id, cpf',
            [condoId, userId]
        );
        if (updatedUser.rows.length === 0) {
            return res.status(404).json({ message: 'Utilizador não encontrado.' });
        }
        const user = updatedUser.rows[0];
        const userPayload = { id: user.id, name: user.name, email: user.email, condoId: user.condo_id, cpf: user.cpf };
        res.status(200).json({ message: 'Condomínio atualizado com sucesso!', user: userPayload });
    } catch (error) {
        res.status(500).json({ message: 'Erro interno ao atualizar condomínio.' });
    }
};

exports.updateMe = async (req, res) => {
    const userId = req.user.id;
    const { name, email, password, newPassword } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Nome e e-mail são obrigatórios.' });
    try {
        const emailExists = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, userId]);
        if (emailExists.rows.length > 0) return res.status(409).json({ message: 'Este e-mail já está em uso por outra conta.' });
        let passwordHash = null;
        if (newPassword) {
            if (!password) return res.status(400).json({ message: 'A senha atual é necessária para definir uma nova.' });
            const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
            const user = userResult.rows[0];
            const isMatch = await bcrypt.compare(password, user.password_hash);
            if (!isMatch) return res.status(401).json({ message: 'A senha atual está incorreta.' });
            const salt = await bcrypt.genSalt(10);
            passwordHash = await bcrypt.hash(newPassword, salt);
        }
        let query;
        let queryParams;
        if (passwordHash) {
            query = 'UPDATE users SET name = $1, email = $2, password_hash = $3 WHERE id = $4 RETURNING id, name, email, condo_id, cpf';
            queryParams = [name, email, passwordHash, userId];
        } else {
            query = 'UPDATE users SET name = $1, email = $2 WHERE id = $3 RETURNING id, name, email, condo_id, cpf';
            queryParams = [name, email, userId];
        }
        const { rows } = await pool.query(query, queryParams);
        if (rows.length === 0) return res.status(404).json({ message: 'Utilizador não encontrado.' });
        const user = rows[0];
        const userPayload = { id: user.id, name: user.name, email: user.email, condoId: user.condo_id, cpf: user.cpf };
        res.status(200).json({ message: 'Dados atualizados com sucesso!', user: userPayload });
    } catch (error) {
        res.status(500).json({ message: 'Erro interno ao atualizar os dados.' });
    }
};

exports.verifyUserForReset = async (req, res) => {
    const { cpf, birth_date } = req.body;
    if (!cpf || !birth_date) return res.status(400).json({ message: 'CPF e data de nascimento são obrigatórios.' });
    try {
        const userResult = await pool.query("SELECT id FROM users WHERE cpf = $1 AND to_char(birth_date, 'YYYY-MM-DD') = $2", [cpf, birth_date]);
        if (userResult.rows.length === 0) return res.status(404).json({ message: 'Os dados não correspondem a nenhuma conta existente.' });
        res.status(200).json({ message: 'Utilizador verificado com sucesso.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

exports.resetPassword = async (req, res) => {
    const { cpf, newPassword } = req.body;
    if (!cpf || !newPassword || newPassword.length < 6) return res.status(400).json({ message: 'CPF e uma nova senha com pelo menos 6 caracteres são obrigatórios.' });
    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(newPassword, salt);
        const result = await pool.query("UPDATE users SET password_hash = $1 WHERE cpf = $2", [password_hash, cpf]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Utilizador não encontrado para alterar a senha.' });
        res.status(200).json({ message: 'Senha alterada com sucesso!' });
    } catch (error) {
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};
