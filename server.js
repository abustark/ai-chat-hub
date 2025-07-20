// FULL REPLACEMENT for server.js

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- NEW, ROBUST Google message transformer ---
function transformMessagesForGoogle(messages) {
    let system_prompt = null;
    const history = [];
    
    // Separate the system prompt from the conversation history
    messages.forEach(msg => {
        if (msg.role === 'system' && msg.content) {
            system_prompt = msg.content;
        } else if (msg.role === 'user' || msg.role === 'assistant') {
            history.push(msg);
        }
    });

    const contents = history.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));
    
    return { system_prompt, contents };
}


app.post('/api/chat', async (req, res) => {
    const { model, messages } = req.body;

    try {
        let response;

        if (model.startsWith('google/')) {
            // --- HANDLE DIRECT GOOGLE API CALL ---
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) throw new Error('GEMINI_API_KEY not configured.');
            
            const googleModelName = model.split('/')[1];
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${googleModelName}:generateContent?key=${apiKey}`;

            // --- NEW --- Transform messages and build the request body
            const { system_prompt, contents } = transformMessagesForGoogle(messages);
            
            const requestBody = { contents };
            if (system_prompt) {
                requestBody.systemInstruction = {
                    role: "user", // The role for system instructions must be 'user'
                    parts: [{ text: system_prompt }]
                };
            }

            response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error?.message || 'Unknown Google API Error');
            }

            const data = await response.json();
            const reply = data.candidates[0].content.parts[0].text;
            return res.json({ choices: [{ message: { content: reply } }] });

        } else {
            // --- HANDLE OPENROUTER API CALL (as before) ---
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured.');
            
            const apiUrl = "https://openrouter.ai/api/v1/chat/completions";

            response = await fetch(apiUrl, {
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

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
    console.log('--- Checking Environment Variables ---');
    console.log('OpenRouter Key Loaded:', process.env.OPENROUTER_API_KEY ? 'Yes' : 'No');
    console.log('Gemini Key Loaded:    ', process.env.GEMINI_API_KEY ? 'Yes' : 'No');
    console.log('------------------------------------');
});