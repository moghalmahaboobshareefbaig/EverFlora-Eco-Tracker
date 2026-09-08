import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// Serve static assets safely
app.use(express.static(__dirname));

const MONGODB_URI = process.env.MONGODB_URI
    ?.trim()
    .replace(/^MONGODB_URI=/, '')
    .replace(/^['"]|['"]$/g, '');

if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured. Add it to .env before starting the server.');
}

let databaseStatus = 'connecting';

mongoose.connection.on('connected', () => {
    databaseStatus = 'connected';
    console.log('Connected to MongoDB Atlas Database');
});

mongoose.connection.on('disconnected', () => {
    databaseStatus = 'disconnected';
});

mongoose.connection.on('error', (err) => {
    databaseStatus = 'error';
    console.error('MongoDB Connection Error:', err.message);
});

mongoose.connect(MONGODB_URI, {
    family: 4,
    serverSelectionTimeoutMS: 10000
}).catch((err) => {
    databaseStatus = 'error';
    console.error('MongoDB Connection Failed:', err.message);
});

// Mongoose Schemas & Models
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: 'Eco-Volunteer' }
});

const plantSchema = new mongoose.Schema({
  userId: String,
  name: String,
  date: String,
  location: String,
  height: String,
  status: { type: String, default: 'Healthy' }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Plant = mongoose.models.Plant || mongoose.model('Plant', plantSchema);

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || `http://localhost:${process.env.PORT || 5000}/api/auth/google/callback`;
const plantNetApiKey = process.env.PLANTNET_API_KEY?.trim();

// Static Page Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'curl-everflora.html'));
});

// Health Check Endpoint
app.get('/api/health', (req, res) => {
    const isDatabaseConnected = databaseStatus === 'connected';
    res.status(isDatabaseConnected ? 200 : 503).json({
        status: isDatabaseConnected ? 'online' : 'degraded',
        database: databaseStatus,
        service: 'everflora',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/auth/google', (req, res) => {
    if (!googleClientId || !googleClientSecret) {
        return res.status(503).json({ error: 'Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' });
    }

    const params = new URLSearchParams({
        client_id: googleClientId,
        redirect_uri: googleRedirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'select_account'
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/google/status', (req, res) => {
    res.json({
        configured: Boolean(googleClientId && googleClientSecret),
        error: 'Google sign-in is not configured on this deployment yet.'
    });
});

app.get('/api/auth/google/callback', async (req, res) => {
    const code = String(req.query.code || '');
    if (!code || !googleClientId || !googleClientSecret) {
        return res.redirect('/?google_error=Google sign-in could not be completed.');
    }

    try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code, client_id: googleClientId, client_secret: googleClientSecret, redirect_uri: googleRedirectUri, grant_type: 'authorization_code' })
        });
        const tokens = await tokenResponse.json();
        if (!tokenResponse.ok || !tokens.access_token) throw new Error('Google token exchange failed');

        const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
        const profile = await profileResponse.json();
        if (!profile.email) throw new Error('Google profile did not include an email');

        let user = await User.findOne({ email: profile.email });
        if (!user) user = await new User({ name: profile.name || profile.email.split('@')[0], email: profile.email, role: 'Eco-Volunteer' }).save();
        const userData = encodeURIComponent(JSON.stringify({ id: user._id, name: user.name, email: user.email, role: user.role }));
        res.redirect(`/?google_user=${userData}`);
    } catch (err) {
        console.error('Google OAuth Error:', err.message);
        res.redirect('/?google_error=Google sign-in failed. Please try again.');
    }
});

app.post('/api/assistant', (req, res) => {
    const question = String(req.body?.question || '').toLowerCase().trim();
    let answer = 'I can help with plants, care tasks, drives, analytics, profiles, and using EverFlora. Try asking "How do I add a plant?"';
    if (/add|register|plant.*(new|create)/.test(question)) answer = 'Open Add Plant from the menu, enter the plant name, date, location, and height, then choose Save Plant.';
    else if (/water|care|task|healthy/.test(question)) answer = 'Check Pending Tasks on Home for the next care action. Mark a task Done after you finish it to update your impact score.';
    else if (/drive|event|join|community/.test(question)) answer = 'Open Drives to see upcoming plantation activities and choose Join drive to add yourself to a community mission.';
    else if (/analytics|impact|carbon|co2|tree/.test(question)) answer = 'Analytics estimates 5.2 kg of CO2 offset per plant and adds impact points for plants and completed care tasks.';
    else if (/profile|account|photo|contact/.test(question)) answer = 'Open My Profile for your account details and profile picture. Account and Contacts are available from the menu.';
    else if (/south|india|neem|coconut|drumstick|curry/.test(question)) answer = 'EverFlora starts with plants suited to South India, including neem, coconut, drumstick, curry leaf, banyan, and jackfruit.';
    res.json({ answer });
});

app.post('/api/identify-plant', async (req, res) => {
    if (!plantNetApiKey) {
        return res.status(503).json({ error: 'Plant identification is not configured. Add PLANTNET_API_KEY in Render.' });
    }

    const imageData = String(req.body?.image || '');
    const match = imageData.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(400).json({ error: 'Please upload a valid plant image.' });

    try {
        const imageBuffer = Buffer.from(match[2], 'base64');
        const form = new FormData();
        form.append('images', new Blob([imageBuffer], { type: match[1] }), 'plant-image');
        form.append('organs', 'leaf');
        const identificationResponse = await fetch(`https://my-api.plantnet.org/v2/identify/all?api-key=${encodeURIComponent(plantNetApiKey)}`, { method: 'POST', body: form });
        const identification = await identificationResponse.json();
        if (!identificationResponse.ok || !identification.results?.length) throw new Error(identification.message || 'No plant match found');

        const result = identification.results[0];
        const scientificName = result.species?.scientificNameWithoutAuthor || result.species?.scientificName || 'Unknown plant';
        const commonName = result.species?.commonNames?.[0] || scientificName;
        let research = 'No public research summary was found for this species.';
        let researchUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(scientificName.replaceAll(' ', '_'))}`;
        const researchResponse = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(scientificName.replaceAll(' ', '_'))}`);
        if (researchResponse.ok) {
            const researchData = await researchResponse.json();
            research = researchData.extract || research;
            researchUrl = researchData.content_urls?.desktop?.page || researchUrl;
        }

        res.json({ commonName, scientificName, confidence: Math.round((result.score || 0) * 100), research, researchUrl });
    } catch (error) {
        console.error('Plant identification error:', error.message);
        res.status(502).json({ error: 'The plant research service could not identify this image. Try a clear leaf photo.' });
    }
});

// Register Route
app.post('/api/register', async (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    const validRoles = ['Eco-Volunteer', 'Field Officer', 'Auditor', 'Admin'];
    const userRole = validRoles.includes(role) ? role : 'Eco-Volunteer';

    try {
        const existing = await User.findOne({ email });
        if (existing) {
            return res.status(400).json({ error: 'Email already registered.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ name, email, password: hashedPassword, role: userRole });
        await newUser.save();

        res.status(201).json({
            success: true,
            user: { id: newUser._id, name: newUser.name, email: newUser.email, role: newUser.role }
        });
    } catch (err) {
        res.status(500).json({ error: 'Database server error.' });
    }
});

// Login Route
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ error: 'User not found. Please register.' });
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(400).json({ error: 'Invalid password credentials.' });
        }

        res.status(200).json({
            success: true,
            user: { id: user._id, name: user.name, email: user.email, role: user.role }
        });
    } catch (err) {
        res.status(500).json({ error: 'Database server error.' });
    }
});

// Dashboard Route
app.get('/api/dashboard/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const plants = await Plant.find({ userId });
        res.json({ plants });
    } catch (err) {
        res.status(500).json({ error: 'Error fetching data.' });
    }
});

// Add Plant Route
app.post('/api/plants', async (req, res) => {
    const { userId, name, date, location, height } = req.body;
    try {
        const newPlant = new Plant({ userId, name, date, location, height });
        await newPlant.save();
        res.status(201).json(newPlant);
    } catch (err) {
        res.status(500).json({ error: 'Failed to add plant.' });
    }
});

// Render/Production Server Listener
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    console.log(`EverFlora Server running at ${serverUrl}/`);
});

export default app;
