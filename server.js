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

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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

    try {
        let response;

        let isGoogle = model.startsWith('google/');

        if (isGoogle) {
                       const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) throw new Error('GEMINI_API_KEY not configured.');

            const googleModelName = model.split('/')[1];
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${googleModelName}:streamGenerateContent?key=${apiKey}`;

            // The transformer function will now build the *entire* correct body
            const requestBody = transformMessagesForGoogle(messages);

            response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

        } else { // For OpenRouter and other providers
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured.');

            const apiUrl = "https://openrouter.ai/api/v1/chat/completions";
            response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ model, messages, stream: true })
            });
        }

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorData}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let googleBuffer = ''; // Buffer for Google responses

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

                        const chunk = decoder.decode(value);

           if (isGoogle) {
                // Robust Google chunk handling - works for single or multi-chunk responses
                console.log("Raw Google chunk:", chunk);
                googleBuffer += chunk;
                
                // Try parsing the buffer continuously
                let parseAttempts = 0;
                while (parseAttempts < 3) { // Prevent infinite loops
                    try {
                        const parsed = JSON.parse(googleBuffer.trim());
                        console.log("Google parsed response:", parsed);
                        
                       // Extract text from Google response - handle streaming chunks
                        if (Array.isArray(parsed)) {
                            // Process each chunk in the array
                            parsed.forEach(chunk => {
                                if (chunk?.candidates?.[0]?.content?.parts?.[0]?.text) {
                                    const text = chunk.candidates[0].content.parts[0].text;
                                    console.log("Extracted text chunk:", text);
                                    
                                    // Send each chunk as separate SSE event
                                    const sseData = { candidates: [{ content: { parts: [{ text }] } }] };
                                    res.write(`data: ${JSON.stringify(sseData)}\n\n`);
                                }
                            });
                        } else if (parsed?.candidates?.[0]?.content?.parts?.[0]?.text) {
                            // Handle single object format
                            const text = parsed.candidates[0].content.parts[0].text;
                            console.log("Extracted text:", text);
                            
                            const sseData = { candidates: [{ content: { parts: [{ text }] } }] };
                            res.write(`data: ${JSON.stringify(sseData)}\n\n`);
                        }
                        // Successfully parsed, clear buffer and break
                        googleBuffer = '';
                        break;
                        
                    } catch (e) {
                        // If buffer doesn't end with ] or }, wait for more chunks
                        const trimmed = googleBuffer.trim();
                        if (!trimmed.endsWith(']') && !trimmed.endsWith('}')) {
                            break; // Wait for more data
                        }
                        
                        // If it looks complete but still fails, try removing incomplete parts
                        if (parseAttempts === 0 && trimmed.includes('}{')) {
                            // Handle multiple JSON objects - take the first complete one
                            const firstComplete = trimmed.split('}{')[0] + '}';
                            try {
                                const parsed = JSON.parse(firstComplete);
                                googleBuffer = googleBuffer.substring(firstComplete.length);
                                continue;
                            } catch {}
                        }
                        
                        parseAttempts++;
                        if (parseAttempts >= 3) {
                            console.warn("Could not parse Google response after 3 attempts:", e);
                            googleBuffer = ''; // Reset to prevent infinite issues
                        }
                        break;
                    }
                }
            } else {
                // OpenRouter stream is already clean, just forward it
                res.write(chunk);
            }
}
    } catch (error) {
        console.error('Server stream error:', error);
        res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
    } finally {
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
