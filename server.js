// FULL REPLACEMENT for server.js

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');

if (process.env.RENDER === 'true') {
    // On Render, we load the credentials from an environment variable.
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON environment variable not set. Server cannot start.");
    }
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully from environment variable.");
} else {
    
    try {
        const serviceAccount = require('./service-account-key.json');
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin SDK initialized successfully from local file.");
    } catch (error) {
        console.error("CRITICAL ERROR: Could not initialize Firebase Admin SDK. Make sure 'service-account-key.json' is in the root directory.", error);
        process.exit(1);
    }
}

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const checkAuth = async (req, res, next) => {
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        const idToken = req.headers.authorization.split('Bearer ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            req.user = decodedToken;
            return next();
        } catch (error) {
            console.error('Error while verifying Firebase ID token:', error);
            return res.status(403).send({ error: 'Unauthorized: Invalid token.' });
        }
    } else {
        return res.status(401).send({ error: 'Unauthorized: No token provided.' });
    }
};

app.post('/api/chat', checkAuth, async (req, res) => {
    const { model, messages } = req.body;
    try {
        if (model.startsWith('google/')) {
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) throw new Error('GEMINI_API_KEY not configured.');
            
            const googleModelName = model.split('/')[1];
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${googleModelName}:generateContent?key=${apiKey}`;

            const { system_prompt, contents } = transformMessagesForGoogle(messages);
            const requestBody = { contents };
            if (system_prompt) {
                requestBody.systemInstruction = { role: "user", parts: [{ text: system_prompt }] };
            }

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error?.message || 'Unknown Google API Error');
            }
            const data = await response.json();
            const reply = data.candidates[0]?.content?.parts[0]?.text || "I'm sorry, I couldn't generate a response.";
            return res.json({ choices: [{ message: { content: reply } }] });

        } else {
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured.');
            
            const apiUrl = "https://openrouter.ai/api/v1/chat/completions";
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: model, messages: messages })
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error?.message || 'Unknown OpenRouter API Error');
            }
            const data = await response.json();
            return res.json(data);
        }
    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ error: { message: error.message } });
    }
});

function transformMessagesForGoogle(messages) {
    let system_prompt = null;
    const history = [];
    messages.forEach(msg => {
        if (msg.role === 'system' && msg.content) { system_prompt = msg.content; } 
        else if (msg.role === 'user' || msg.role === 'assistant') { history.push(msg); }
    });
    const contents = history.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));
    return { system_prompt, contents };
}

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});