const express = require('express');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');

if (process.env.RENDER === 'true') {
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
app.use(express.static('.'));
app.use(cors());
app.use(express.json());

// Middleware to verify Firebase token
const checkAuth = async (req, res, next) => {
    let idToken;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        idToken = req.headers.authorization.split('Bearer ')[1];
    } else if (req.query.token) {
        idToken = req.query.token;
    }

    if (idToken) {
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

app.get('/api/firebase-config', (req, res) => {
    res.json({
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID
    });
});

app.post('/api/chat', checkAuth, async (req, res) => {
    const { model, messages } = req.body;

    console.log("--- New Chat Request Received ---");
    console.log("Model:", model);
    console.log("Messages being sent to AI:", JSON.stringify(messages, null, 2));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const isGoogle = model.startsWith('google/');

    try {
        if (isGoogle) {
            // --- NON-STREAMING LOGIC FOR GOOGLE GEMINI ---
            console.log("Using non-streaming handler for Google model.");
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) throw new Error('GEMINI_API_KEY not configured.');

            const googleModelName = model.split('/')[1];
            // IMPORTANT: Use the non-streaming endpoint
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${googleModelName}:generateContent?key=${apiKey}`;
            const requestBody = transformMessagesForGoogle(messages);

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorData = await response.text();
                throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorData}`);
            }

            const fullData = await response.json();
            console.log("Received full response from Google:", JSON.stringify(fullData, null, 2));

            // Extract the full text and send it as a single data event
            const fullText = fullData.candidates?.[0]?.content?.parts?.[0]?.text || "";
            const sseData = { choices: [{ delta: { content: fullText } }] };
            res.write(`data: ${JSON.stringify(sseData)}\n\n`);

        } else {
            // --- STREAMING LOGIC FOR OPENROUTER ---
            console.log("Using streaming handler for OpenRouter model.");
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured.');

            const apiUrl = "https://openrouter.ai/api/v1/chat/completions";
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ model, messages, stream: true })
            });

            if (!response.ok) {
                const errorData = await response.text();
                throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorData}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                res.write(chunk);
            }
        }
    } catch (error) {
        console.error('Server stream error:', error);
        res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
    } finally {
        // Always send a [DONE] message for the frontend to correctly finish.
        res.write('data: [DONE]\n\n');
        res.end();
    }
});

/**
 * Transforms the generic message format into the specific format
 * required by the Google Gemini API, building a valid request body.
 * @param {Array<Object>} messages - The array of message objects.
 * @returns {Object} - The complete, final request body for the Google API.
 */
function transformMessagesForGoogle(messages) {
    const requestBody = { contents: [] };
    let systemPromptFound = false;

    // The Gemini API requires the system prompt to be the very first part of the request.
    // It also doesn't like an empty user message right after a system prompt.
    messages.forEach(msg => {
        if (msg.role === 'system' && msg.content && !systemPromptFound) {
            // Add the system prompt in the correct format
            requestBody.systemInstruction = {
                role: "user", // The role for system instructions must be 'user'
                parts: [{ text: msg.content }]
            };
            systemPromptFound = true;
        } else if (msg.role === 'user' || msg.role === 'assistant') {
            // Add user and assistant messages to the main contents
            requestBody.contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            });
        }
    });

    return requestBody;
}

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});