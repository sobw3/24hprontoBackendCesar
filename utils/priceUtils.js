// utils/priceUtils.js

// Arredonda um preço para o final .49 ou .99 mais próximo.
exports.calculatePsychologicalPrice = (price) => {
    const priceFloat = parseFloat(price);
    if (isNaN(priceFloat)) return 0;

    const integerPart = Math.floor(priceFloat);
    const decimalPart = priceFloat - integerPart;

    if (decimalPart < 0.25) {
        return integerPart - 0.01; // Ex: 10.20 -> 9.99
    } else if (decimalPart < 0.75) {
        return integerPart + 0.49; // Ex: 10.60 -> 10.49
    } else {
        return integerPart + 0.99; // Ex: 10.80 -> 10.99
    }
};