// services/cieloService.js
// Integração Cielo E-commerce: PIX, cartão de crédito transparente e consulta de status.
// Requer Node 18+ (fetch nativo). Render Node 22 funciona.

const crypto = require('crypto');

function getCieloConfig() {
  const env = (process.env.CIELO_ENV || 'sandbox').toLowerCase();
  const isProduction = ['production', 'prod', 'producao', 'produção'].includes(env);

  return {
    merchantId: process.env.CIELO_MERCHANT_ID,
    merchantKey: process.env.CIELO_MERCHANT_KEY,
    salesBaseUrl: process.env.CIELO_SALES_URL || (isProduction
      ? 'https://api.cieloecommerce.cielo.com.br'
      : 'https://apisandbox.cieloecommerce.cielo.com.br'),
    queryBaseUrl: process.env.CIELO_QUERY_URL || (isProduction
      ? 'https://apiquery.cieloecommerce.cielo.com.br'
      : 'https://apiquerysandbox.cieloecommerce.cielo.com.br'),
    pixProvider: process.env.CIELO_PIX_PROVIDER || 'Cielo30',
    softDescriptor: process.env.CIELO_SOFT_DESCRIPTOR || 'SMARTFRIDGE',
  };
}

function assertCredentials(config) {
  if (!config.merchantId || !config.merchantKey) {
    throw new Error('Credenciais Cielo ausentes. Configure CIELO_MERCHANT_ID e CIELO_MERCHANT_KEY na Render.');
  }
}

function cieloHeaders(config) {
  return {
    'Content-Type': 'application/json',
    MerchantId: config.merchantId,
    MerchantKey: config.merchantKey,
    RequestId: crypto.randomUUID(),
  };
}

function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { raw: text };
  }

  if (!response.ok) {
    const details = typeof data === 'object' ? JSON.stringify(data) : String(data);
    throw new Error(`Erro Cielo HTTP ${response.status}: ${details}`);
  }

  return data;
}

function normalizeCardBrand(brand = '') {
  const normalized = String(brand).trim().toLowerCase();
  const map = {
    visa: 'Visa',
    master: 'Master',
    mastercard: 'Master',
    master_card: 'Master',
    elo: 'Elo',
    amex: 'Amex',
    americanexpress: 'Amex',
    american_express: 'Amex',
    hipercard: 'Hipercard',
    hiper: 'Hiper',
    diners: 'Diners',
    discover: 'Discover',
    jcb: 'JCB',
    aura: 'Aura',
  };

  return map[normalized] || brand;
}

function sanitizeCardPayload(card = {}) {
  const cardNumber = String(card.cardNumber || '').replace(/\D/g, '');
  const securityCode = String(card.securityCode || '').replace(/\D/g, '');
  const holder = String(card.holder || '').trim().toUpperCase();
  const expirationDate = String(card.expirationDate || '').trim();
  const brand = normalizeCardBrand(card.brand);

  if (!cardNumber || cardNumber.length < 13 || cardNumber.length > 19) {
    throw new Error('Número do cartão inválido.');
  }
  if (!holder || holder.length < 3) {
    throw new Error('Nome do titular inválido.');
  }
  if (!/^\d{2}\/\d{4}$/.test(expirationDate)) {
    throw new Error('Validade inválida. Use MM/AAAA.');
  }
  if (!securityCode || securityCode.length < 3 || securityCode.length > 4) {
    throw new Error('CVV inválido.');
  }
  if (!brand) {
    throw new Error('Bandeira do cartão inválida.');
  }

  return { cardNumber, holder, expirationDate, securityCode, brand };
}

async function createPixPayment({ merchantOrderId, amount, customerName = 'Cliente SmartFridge' }) {
  const config = getCieloConfig();
  assertCredentials(config);

  const body = {
    MerchantOrderId: merchantOrderId,
    Customer: {
      Name: customerName,
    },
    Payment: {
      Type: 'Pix',
      Amount: toCents(amount),
      Provider: config.pixProvider,
    },
  };

  return requestJson(`${config.salesBaseUrl}/1/sales/`, {
    method: 'POST',
    headers: cieloHeaders(config),
    body: JSON.stringify(body),
  });
}

async function createCreditCardPayment({ merchantOrderId, amount, customerName = 'Cliente SmartFridge', card, installments = 1 }) {
  const config = getCieloConfig();
  assertCredentials(config);

  const safeCard = sanitizeCardPayload(card);
  const installmentsNumber = Math.max(1, Math.min(Number(installments || 1), 12));

  const body = {
    MerchantOrderId: merchantOrderId,
    Customer: {
      Name: customerName,
    },
    Payment: {
      Type: 'CreditCard',
      Amount: toCents(amount),
      Installments: installmentsNumber,
      Capture: true,
      SoftDescriptor: config.softDescriptor,
      CreditCard: {
        CardNumber: safeCard.cardNumber,
        Holder: safeCard.holder,
        ExpirationDate: safeCard.expirationDate,
        SecurityCode: safeCard.securityCode,
        Brand: safeCard.brand,
        SaveCard: 'false',
      },
    },
  };

  return requestJson(`${config.salesBaseUrl}/1/sales/`, {
    method: 'POST',
    headers: cieloHeaders(config),
    body: JSON.stringify(body),
  });
}

async function getPaymentById(paymentId) {
  const config = getCieloConfig();
  assertCredentials(config);

  return requestJson(`${config.queryBaseUrl}/1/sales/${encodeURIComponent(paymentId)}`, {
    method: 'GET',
    headers: cieloHeaders(config),
  });
}

module.exports = {
  createPixPayment,
  createCreditCardPayment,
  getPaymentById,
  toCents,
  normalizeCardBrand,
};
