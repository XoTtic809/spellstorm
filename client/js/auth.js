/**
 * SpellStorm — Authentication Module
 * Handles login, register, token storage, and user state.
 */

const Auth = (() => {
  const TOKEN_KEY = 'ss_token';
  const USER_KEY  = 'ss_user';

  let currentUser = null;

  // ── Storage ──────────────────────────────────────────────────────────────

  function saveSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    currentUser = user;
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    currentUser = null;
  }

  function loadSession() {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw   = localStorage.getItem(USER_KEY);
    if (!token || !raw) return false;

    try {
      currentUser = JSON.parse(raw);
      return true;
    } catch {
      clearSession();
      return false;
    }
  }

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function getUser()  { return currentUser; }
  function isLoggedIn() { return !!currentUser && !!getToken(); }

  // ── API Calls ─────────────────────────────────────────────────────────────

  async function register(username, password) {
    const res = await fetch('/api/auth/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    saveSession(data.token, data.user);
    return data.user;
  }

  async function login(username, password) {
    const res = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    saveSession(data.token, data.user);
    return data.user;
  }

  function logout() {
    clearSession();
  }

  // Refresh user data from server
  async function refreshUser() {
    const token = getToken();
    if (!token) return null;

    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      clearSession();
      return null;
    }

    const user = await res.json();
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    currentUser = user;
    return user;
  }

  return { register, login, logout, loadSession, saveSession, getToken, getUser, isLoggedIn, refreshUser };
})();
