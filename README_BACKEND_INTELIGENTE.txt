Backend atualizado para o novo App.js mobile-first Daniel Marques Market.

O que foi adicionado:
- DRE inteligente / financeiro IA: /api/admin/finance/smart-dre e /api/admin/finance/smart-config
- Payback automático com investimento, custos, perdas, taxas, comissão e margem líquida
- Promoções automáticas com trava matemática: desconto somente sobre o lucro, nunca abaixo do custo
- Promoções do dia para cliente final: /api/public/promotions/daily
- Abastecimento físico com atualização de estoque e custo médio ponderado
- Auditoria de inconsistências com janela de vendas suspeitas desde o último abastecimento
- Registro de perdas/furtos integrado ao DRE
- Registro de compras/fornecedores para saber onde está mais barato
- Advertências/anotações por cliente
- Log de ações administrativas e motivo obrigatório no destravamento remoto

Importante:
- Este pacote NÃO inclui .env.
- Use exatamente o .env que já está em operação na Render.
- O backend cria/atualiza automaticamente as novas tabelas/colunas com comandos idempotentes.
- Também deixei o arquivo database_safety_updates.sql caso você prefira executar manualmente no banco.

Comandos Render:
npm install
npm start

Rota de saúde:
GET /health

Variável opcional:
DISABLE_PROMOTION_SCHEDULER=true para desativar o cron diário de promoções.
