// FULL REPLACEMENT for server.js

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Helper function to transform messages for Google's API format
function transformMessagesForGoogle(messages) {
    // Google's API expects a specific format. It doesn't use a 'system' role directly.
    // We'll prepend the system message to the first user message.
    let system_prompt = "You are a helpful AI assistant.";
    const newMessages = [];

    messages.forEach(msg => {
        if (msg.role === 'system') {
            system_prompt = msg.content;
            return; // Skip adding system message directly
        }
        newMessages.push(msg);
    });

    if (newMessages.length > 0 && newMessages[0].role === 'user') {
        newMessages[0].content = `${system_prompt}\n\nUser: ${newMessages[0].content}`;
    }
    
    // Convert to Google's 'contents' format
    return newMessages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user', // Google uses 'model' instead of 'assistant'
        parts: [{ text: msg.content }]
    }));
}


app.post('/api/chat', async (req, res) => {
    const { model, messages } = req.body;

    try {
        let response;

        // --- ADVANCED ROUTING LOGIC ---
        if (model.startsWith('google/')) {
            // --- HANDLE DIRECT GOOGLE API CALL ---
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) throw new Error('GEMINI_API_KEY not configured.');
            
            const googleModelName = model.split('/')[1];
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${googleModelName}:generateContent?key=${apiKey}`;

            const transformedMessages = transformMessagesForGoogle(messages);

            response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: transformedMessages })
            });

            if (!response.ok) {
                const errorData = await response.json();
                // Reformat Google's error to be consistent
                throw new Error(errorData.error?.message || 'Unknown Google API Error');
            }

            const data = await response.json();
            // Extract and re-package the response to match the format our frontend expects
            const reply = data.candidates[0].content.parts[0].text;
            return res.json({ choices: [{ message: { content: reply } }] });

        } else {
            // --- HANDLE OPENROUTER API CALL (as before) ---
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured.');
            
            const apiUrl = "https://openrouter.ai/api/v1/chat/completions";

            response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
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