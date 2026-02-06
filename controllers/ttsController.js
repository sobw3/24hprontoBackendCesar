// controllers/ttsController.js
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");

const pollyClient = new PollyClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

exports.synthesizeSpeech = async (req, res) => {
    const { text } = req.body;
    console.log(`[TTS Controller] Recebido pedido para falar o texto: "${text}"`);

    if (!text) {
        return res.status(400).json({ message: "O texto é obrigatório." });
    }

    // --- ALTERAÇÃO APLICADA AQUI ---
    const params = {
        // Envolvemos o texto na tag <prosody> para controlar a velocidade
        Text: `<prosody rate="108%">${text}</prosody>`,
        // Informamos à AWS que estamos a enviar o formato SSML
        TextType: 'ssml',
        OutputFormat: 'mp3',
        VoiceId: 'Vitoria',
        Engine: 'standard'
    };
    // --- FIM DA ALTERAÇÃO ---

    try {
        const command = new SynthesizeSpeechCommand(params);
        const data = await pollyClient.send(command);
        
        res.set('Content-Type', 'audio/mpeg');
        data.AudioStream.pipe(res);

    } catch (error) {
        console.error("Erro ao sintetizar a voz com a AWS Polly:", error);
        res.status(500).json({ message: "Erro ao gerar o áudio." });
    }
};