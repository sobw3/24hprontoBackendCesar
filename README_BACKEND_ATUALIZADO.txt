BACKEND ATUALIZADO - SMARTFRIDGE / MERCADO AUTÔNOMO

O que foi atualizado:
- Removidas as rotas/funções de crédito/fatura do cliente final.
- Rotas administrativas que estavam sem proteção agora usam protectAdmin.
- Adicionadas rotas que o frontend premium chama:
  /api/admin/critical-stock-page
  /api/admin/inventory-analysis
  /api/admin/promotions/daily
- Corrigida rota DELETE /api/admin/inventory para remover produto do estoque.
- Relatório de vendas agora retorna log, summary e pagination, além de data/meta para compatibilidade.
- Compra com carteira agora valida estoque antes de cobrar e impede estoque negativo.
- Compra com cartão agora usa o usuário autenticado do token, não o usuário enviado pelo frontend.
- Webhook Mercado Pago focado em depósito de carteira; crédito/fatura removido.
- Adicionada rota /health para monitoramento.

IMPORTANTE:
- O .env não foi incluído por segurança. Use exatamente o .env que já está em produção/Render.
- node_modules não foi incluído. Rode npm install ou deixe a Render instalar automaticamente.
- O arquivo database_safety_updates.sql é opcional. Ele só adiciona colunas/tabelas se não existirem.

Comandos:
npm install
npm start

Deploy Render:
Build Command: npm install
Start Command: npm start
