/**
 * JWT authentication middleware and helper functions.
 */
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

const JWT_SECRET  = process.env.JWT_SECRET || 'spellstorm-dev-secret';
const SALT_ROUNDS = 12;
const TOKEN_TTL   = '7d';

/**
 * Hash a plain-text password.
 * @param {string} password
 * @returns {Promise<string>} hashed password
 */
async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare a plain-text password against a hash.
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Sign a JWT for a user.
 * @param {{ id: number, username: string }} user
 * @returns {string} token
 */
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

/**
 * Verify and decode a JWT.
 * @param {string} token
 * @returns {{ id: number, username: string } | null}
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Express middleware: requires a valid JWT in Authorization header.
 * Attaches decoded payload to req.user.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: missing token' });
  }

  const token   = authHeader.slice(7);
  const payload = verifyToken(token);

  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized: invalid token' });
  }

  req.user = payload;
  next();
}

/**
 * Authenticate a Socket.io connection via handshake auth token.
 * Returns the decoded user or throws.
 * @param {object} socket
 * @returns {{ id: number, username: string }}
 */
function authenticateSocket(socket) {
  const token = socket.handshake.auth?.token;
  if (!token) throw new Error('No token provided');

  const payload = verifyToken(token);
  if (!payload) throw new Error('Invalid token');

  return payload;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, requireAuth, authenticateSocket };
