require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Init DB
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        wallet_balance DECIMAL(12,2) DEFAULT 0,
        total_invested DECIMAL(12,2) DEFAULT 0,
        total_earnings DECIMAL(12,2) DEFAULT 0,
        role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS investments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        amount DECIMAL(12,2) NOT NULL,
        plan VARCHAR(50) DEFAULT 'standard',
        roi_percent DECIMAL(5,2) DEFAULT 30,
        status VARCHAR(20) DEFAULT 'active',
        start_date TIMESTAMP DEFAULT NOW(),
        maturity_date TIMESTAMP,
        earnings DECIMAL(12,2) DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        type VARCHAR(20) NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'completed',
        reference VARCHAR(255),
        paystack_ref VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ DB Ready');
  } catch (e) { console.error('DB Error', e); }
}
initDB();

const JWT_SECRET = process.env.JWT_SECRET || 'dav_secret_2026_super_secure_key';

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ROUTES
app.get('/', (req, res) => {
  res.json({ 
    status: 'DAV Investment Platform LIVE 🔥',
    endpoints: ['/api/auth/register', '/api/auth/login', '/api/wallet/fund', '/api/wallet/verify', '/api/invest', '/api/dashboard'],
    db: 'Neon Connected',
    paystack: 'Ready',
    time: new Date()
  });
});

app.get('/health', (req, res) => res.json({ ok: true, db: 'connected' }));

// AUTH
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email, wallet_balance',
      [name, email.toLowerCase(), hashed]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, wallet_balance: user.wallet_balance } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// WALLET FUND - Initialize Paystack
app.post('/api/wallet/fund', auth, async (req, res) => {
  const { amount, email } = req.body;
  if (!amount || amount < 100) return res.status(400).json({ error: 'Min ₦100' });
  try {
    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: email || req.user.email,
      amount: amount * 100,
      callback_url: `https://${req.get('host')}/api/wallet/verify`,
      metadata: { user_id: req.user.id }
    }, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
    });
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, paystack_ref) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, 'funding', amount, 'pending', response.data.data.reference]
    );
    res.json({ authorization_url: response.data.data.authorization_url, reference: response.data.data.reference });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'Paystack error', details: e.response?.data });
  }
});

// VERIFY PAYMENT
app.get('/api/wallet/verify', async (req, res) => {
  const { reference, trxref } = req.query;
  const ref = reference || trxref;
  try {
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${ref}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const data = response.data.data;
    if (data.status === 'success') {
      const userId = data.metadata?.user_id;
      const amount = data.amount / 100;
      await pool.query('UPDATE transactions SET status = $1 WHERE paystack_ref = $2', ['completed', ref]);
      await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
      // Redirect to frontend success (you'll set Vercel URL later)
      return res.redirect(`https://dav-frontend.vercel.app/dashboard?funding=success&amount=${amount}`);
    }
    res.json({ status: 'failed', data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DASHBOARD
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const user = await pool.query('SELECT id, name, email, wallet_balance, total_invested, total_earnings FROM users WHERE id = $1', [req.user.id]);
    const investments = await pool.query('SELECT * FROM investments WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    const transactions = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [req.user.id]);
    res.json({ user: user.rows[0], investments: investments.rows, transactions: transactions.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// INVEST
app.post('/api/invest', auth, async (req, res) => {
  const { amount, plan } = req.body;
  const plans = { standard: 30, premium: 50, vip: 80 };
  const roi = plans[plan] || 30;
  try {
    const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [req.user.id]);
    const balance = parseFloat(userRes.rows[0].wallet_balance);
    if (balance < amount) return res.status(400).json({ error: 'Insufficient wallet balance. Fund wallet first.' });
    
    await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1, total_invested = total_invested + $1 WHERE id = $2', [amount, req.user.id]);
    const maturity = new Date();
    maturity.setDate(maturity.getDate() + 7);
    const inv = await pool.query(
      'INSERT INTO investments (user_id, amount, plan, roi_percent, maturity_date) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, amount, plan, roi, maturity]
    );
    await pool.query('INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, $2, $3, $4)', [req.user.id, 'investment', amount, 'completed']);
    res.json({ success: true, investment: inv.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ADMIN - ALL USERS
app.get('/api/admin/users', auth, async (req, res) => {
  const users = await pool.query('SELECT id, name, email, wallet_balance, total_invested, created_at FROM users ORDER BY created_at DESC');
  res.json(users.rows);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🔥 DAV LIVE on ${PORT}`));
