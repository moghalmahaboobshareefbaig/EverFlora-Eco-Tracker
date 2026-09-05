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
app.use(express.json());
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
