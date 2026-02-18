const express = require('express');
const cors = require('cors');
const https = require('https');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = 3001;

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Simple file-based storage
const DB_FILE = 'users.json';
function loadUsers() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveUsers(users) { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }
function getUser(email) {
    return loadUsers()[email] || { email, plan: 'free', credits: 5 };
}
function updateUser(email, data) {
    const users = loadUsers();
    users[email] = { ...getUser(email), ...data };
    saveUsers(users);
    return users[email];
}

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Call Google Gemini API
function callGemini(prompt) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.GEMINI_API_KEY;
        const body = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 1000, temperature: 0.7 }
        });

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) return reject(new Error(parsed.error.message));
                    const text = parsed.candidates[0].content.parts[0].text;
                    resolve(text);
                } catch(e) {
                    reject(new Error('Failed to parse Gemini response'));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Generate Cold Email
app.post('/api/generate-email', async (req, res) => {
    try {
        const { mode, emailType, yourValue, websiteUrl, name, company, role, context, email } = req.body;

        const user = getUser(email || 'guest');
        if (user.plan === 'free' && user.credits <= 0) {
            return res.json({ success: false, error: 'No credits left. Please upgrade!' });
        }

        let prospectInfo = '';
        if (mode === 'website' && websiteUrl) {
            try {
                const response = await axios.get(websiteUrl, {
                    timeout: 5000,
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                const $ = cheerio.load(response.data);
                const title = $('title').text();
                const desc = $('meta[name="description"]').attr('content') || '';
                prospectInfo = `Company Website: ${websiteUrl}\nTitle: ${title}\nDescription: ${desc}`;
            } catch(e) {
                prospectInfo = `Company Website: ${websiteUrl}`;
            }
        } else {
            prospectInfo = `Name: ${name || 'Unknown'}\nCompany: ${company || 'Unknown'}\nRole: ${role || 'Unknown'}\n${context ? 'Extra Info: ' + context : ''}`;
        }

        const emailTypes = {
            'first-outreach': 'First cold outreach - warm, brief, focus on one specific pain point, end with a soft ask (not pushing for immediate meeting).',
            'follow-up': 'Follow-up to previous email - add new value, reference previous contact subtly, stronger CTA.',
            'meeting-request': 'Request a meeting - show clear ROI, suggest specific short time (15 min), make it easy to say yes.',
            'value-pitch': 'Value proposition pitch - include a specific result/metric, explain ROI clearly, create mild urgency.'
        };

        const prompt = `You are a world-class cold email copywriter. Write a highly personalized cold email.

PROSPECT INFO:
${prospectInfo}

WHAT THE SENDER OFFERS:
${yourValue}

EMAIL TYPE: ${emailTypes[emailType] || emailTypes['first-outreach']}

STRICT REQUIREMENTS:
- Subject line: max 50 characters, personalized, makes them curious
- Body: MAXIMUM 100 words - short emails get more replies
- First line must reference something specific about them or their company
- Include ONE specific pain point relevant to their role
- ONE clear value proposition (one sentence)
- ONE call to action only
- Sound like a real human, not a robot
- NEVER start with "I hope this email finds you well"
- NEVER say "I wanted to reach out"

RESPOND IN EXACTLY THIS FORMAT:
SUBJECT: [subject line]

BODY:
[email body]`;

        const output = await callGemini(prompt);

        const subjectMatch = output.match(/SUBJECT:\s*(.+)/);
        const bodyMatch = output.match(/BODY:\s*([\s\S]+)/);

        if (user.plan === 'free' && email) {
            updateUser(email, { credits: user.credits - 1 });
        }

        res.json({
            success: true,
            subject: subjectMatch ? subjectMatch[1].trim() : 'Quick question',
            body: bodyMatch ? bodyMatch[1].trim() : output.trim(),
            creditsRemaining: user.plan === 'free' ? user.credits - 1 : 999
        });

    } catch (error) {
        console.error('Generation error:', error.message);
        res.status(500).json({ success: false, error: 'AI generation failed: ' + error.message });
    }
});

// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount, plan, email } = req.body;
        const order = await razorpay.orders.create({
            amount: amount * 100,
            currency: process.env.RAZORPAY_CURRENCY || 'INR',
            receipt: `rcpt_${Date.now()}`,
            notes: { email, plan }
        });
        res.json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            razorpayKeyId: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Verify Payment
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, email, plan } = req.body;
        const sign = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSign = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(sign).digest('hex');
        if (razorpay_signature !== expectedSign) {
            return res.status(400).json({ success: false, message: 'Invalid signature' });
        }
        const credits = plan === 'starter' ? 100 : 500;
        updateUser(email, { plan, credits, lastPayment: Date.now() });
        res.json({ success: true, message: 'Payment verified!', plan, credits });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/user/:email', (req, res) => {
    res.json({ success: true, user: getUser(req.params.email) });
});

app.listen(PORT, () => {
    console.log('\n✅ Cold Email Tool is RUNNING!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📧 Landing Page : http://localhost:${PORT}/landing.html`);
    console.log(`⚡ App          : http://localhost:${PORT}/app.html`);
    console.log(`💳 Payment Page : http://localhost:${PORT}/payment.html`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🤖 Using: Google Gemini AI (FREE)');
    console.log('💰 Payments: Razorpay\n');
});
