/**
 * SpellStorm — Main UI Controller
 *
 * Manages screen transitions, home screen state,
 * leaderboard, profile, and global toast notifications.
 */

const Main = (() => {

  // ── Screen Navigation ─────────────────────────────────────────────────────

  const screens = {
    home:            document.getElementById('screen-home'),
    auth:            document.getElementById('screen-auth'),
    queue:           document.getElementById('screen-queue'),
    game:            document.getElementById('screen-game'),
    results:         document.getElementById('screen-results'),
    leaderboard:     document.getElementById('screen-leaderboard'),
    profile:         document.getElementById('screen-profile'),
    'battle-menu':   document.getElementById('screen-battle-menu'),
    'battle-lobby':  document.getElementById('screen-battle-lobby'),
    'battle-queue':  document.getElementById('screen-battle-queue'),
    'battle':        document.getElementById('screen-battle'),
    'battle-results': document.getElementById('screen-battle-results'),
  };

  let currentScreen = 'home';

  function showScreen(name) {
    if (!screens[name]) return;
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
    currentScreen = name;
  }

  // ── Toast Notifications ───────────────────────────────────────────────────

  const toastContainer = document.getElementById('toast-container');

  function showToast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className  = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), duration + 300);
  }

  // ── Home Screen ───────────────────────────────────────────────────────────

  function updateHomeScreen() {
    const user = Auth.getUser();
    const authRow     = document.getElementById('home-auth');
    const userInfoRow = document.getElementById('home-user-info');

    if (user) {
      authRow.classList.add('hidden');
      userInfoRow.classList.remove('hidden');
      document.getElementById('home-username').textContent = user.username;
      document.getElementById('home-rating').textContent   = `${user.rating} rating`;
      document.getElementById('home-rank-icon').textContent = user.rank?.icon ?? '';
    } else {
      authRow.classList.remove('hidden');
      userInfoRow.classList.add('hidden');
    }
  }

  // ── Auth Screen ───────────────────────────────────────────────────────────

  // Tab switching
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      document.getElementById('form-login').classList.toggle('hidden', target !== 'login');
      document.getElementById('form-register').classList.toggle('hidden', target !== 'register');
    });
  });

  // Switch links
  document.querySelectorAll('.switch-to-register').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.auth-tab')[1].click();
    });
  });

  document.querySelectorAll('.switch-to-login').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.auth-tab')[0].click();
    });
  });

  // Login form
  document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl  = document.getElementById('login-error');
    const btn      = e.target.querySelector('.btn');
    const btnText  = btn.querySelector('.btn-text');
    const loader   = btn.querySelector('.btn-loader');

    errorEl.classList.add('hidden');
    btnText.classList.add('hidden');
    loader.classList.remove('hidden');
    btn.disabled = true;

    try {
      await Auth.login(username, password);
      window.currentUser = Auth.getUser();
      updateHomeScreen();
      showScreen('home');
      showToast('Welcome back, ' + username + '!', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      btnText.classList.remove('hidden');
      loader.classList.add('hidden');
      btn.disabled = false;
    }
  });

  // Register form
  document.getElementById('form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username  = document.getElementById('reg-username').value.trim();
    const password  = document.getElementById('reg-password').value;
    const confirm   = document.getElementById('reg-confirm').value;
    const errorEl   = document.getElementById('register-error');
    const btn       = e.target.querySelector('.btn');
    const btnText   = btn.querySelector('.btn-text');
    const loader    = btn.querySelector('.btn-loader');

    errorEl.classList.add('hidden');

    if (password !== confirm) {
      errorEl.textContent = 'Passwords do not match.';
      errorEl.classList.remove('hidden');
      return;
    }

    btnText.classList.add('hidden');
    loader.classList.remove('hidden');
    btn.disabled = true;

    try {
      await Auth.register(username, password);
      window.currentUser = Auth.getUser();
      updateHomeScreen();
      showScreen('home');
      showToast('Account created! Welcome, ' + username + '!', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      btnText.classList.remove('hidden');
      loader.classList.add('hidden');
      btn.disabled = false;
    }
  });

  // Back button
  document.getElementById('auth-back').addEventListener('click', () => showScreen('home'));

  // ── Home Buttons ──────────────────────────────────────────────────────────

  document.getElementById('btn-play-ranked').addEventListener('click', () => {
    if (!Auth.isLoggedIn()) {
      showScreen('auth');
      return;
    }
    Game.joinQueue('ranked');
  });

  document.getElementById('btn-play-casual').addEventListener('click', () => {
    if (!Auth.isLoggedIn()) {
      showScreen('auth');
      return;
    }
    Game.joinQueue('casual');
  });

  document.getElementById('btn-play-battle').addEventListener('click', () => {
    if (!Auth.isLoggedIn()) {
      showScreen('auth');
      return;
    }
    showScreen('battle-menu');
  });

  document.getElementById('btn-login').addEventListener('click', () => {
    document.querySelectorAll('.auth-tab')[0].click();
    showScreen('auth');
  });

  document.getElementById('btn-register').addEventListener('click', () => {
    document.querySelectorAll('.auth-tab')[1].click();
    showScreen('auth');
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    Auth.logout();
    Game.disconnect();
    window.currentUser = null;
    window.socket      = null;
    updateHomeScreen();
    showToast('Logged out', 'info');
  });

  document.getElementById('btn-leaderboard').addEventListener('click', () => {
    showScreen('leaderboard');
    loadLeaderboard();
  });

  document.getElementById('btn-profile-nav').addEventListener('click', () => {
    if (!Auth.isLoggedIn()) {
      showScreen('auth');
      return;
    }
    showScreen('profile');
    loadProfile(Auth.getUser().username);
  });

  // ── Results Screen ────────────────────────────────────────────────────────

  document.getElementById('btn-play-again').addEventListener('click', () => {
    const mode = Game.getCurrentMode() || 'ranked';
    Game.joinQueue(mode);
  });

  document.getElementById('btn-results-home').addEventListener('click', () => {
    updateHomeScreen();
    showScreen('home');
  });

  // ── Leaderboard ───────────────────────────────────────────────────────────

  document.getElementById('lb-back').addEventListener('click', () => showScreen('home'));

  async function loadLeaderboard() {
    const tbody = document.getElementById('leaderboard-body');
    tbody.innerHTML = '<tr><td colspan="6" class="lb-loading">Loading…</td></tr>';

    try {
      const res  = await fetch('/api/leaderboard?limit=100');
      const data = await res.json();

      if (!data.players || data.players.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="lb-loading">No players yet</td></tr>';
        return;
      }

      tbody.innerHTML = data.players.map(p => {
        const posClass = p.position <= 3 ? ' top-3' : '';
        const rankStyle = `color:${p.rank?.color ?? '#aaa'}; border-color:${p.rank?.color ?? '#aaa'}`;

        return `<tr>
          <td class="lb-position${posClass}">${formatPosition(p.position)}</td>
          <td style="font-weight:600">${escHtml(p.username)}</td>
          <td>
            <span class="lb-rank-badge" style="${rankStyle}">
              ${p.rank?.icon ?? ''} ${escHtml(p.rank?.name ?? '')}
            </span>
          </td>
          <td style="font-family:var(--font-display);font-weight:700">${p.rating}</td>
          <td><span style="color:var(--success)">${p.wins}W</span> / <span style="color:var(--danger)">${p.losses}L</span></td>
          <td>${p.winRatio}%</td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="6" class="lb-loading">Failed to load leaderboard</td></tr>';
    }
  }

  function formatPosition(pos) {
    if (pos === 1) return '🥇';
    if (pos === 2) return '🥈';
    if (pos === 3) return '🥉';
    return '#' + pos;
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  document.getElementById('profile-back').addEventListener('click', () => showScreen('home'));

  async function loadProfile(username) {
    const card = document.getElementById('profile-card');

    try {
      const res  = await fetch('/api/profile/' + encodeURIComponent(username));
      const user = await res.json();

      if (!res.ok) throw new Error(user.error);

      document.getElementById('profile-avatar').textContent   = username[0].toUpperCase();
      document.getElementById('profile-username').textContent = user.username;
      document.getElementById('profile-rating').textContent   = user.rating + ' Rating';

      const badge = document.getElementById('profile-rank-badge');
      badge.textContent = (user.rank?.icon ?? '') + ' ' + (user.rank?.name ?? '');
      badge.style.color = user.rank?.color ?? '';
      badge.style.borderColor = user.rank?.color ?? '';

      document.getElementById('prof-wins').textContent     = user.wins;
      document.getElementById('prof-losses').textContent   = user.losses;
      document.getElementById('prof-winratio').textContent = user.winRatio + '%';
      document.getElementById('prof-streak').textContent   = user.bestStreak;

      // Matches
      const matchesEl = document.getElementById('profile-matches');
      if (!user.recentMatches || user.recentMatches.length === 0) {
        matchesEl.innerHTML = '<div class="match-loading">No matches yet</div>';
      } else {
        matchesEl.innerHTML = user.recentMatches.map(m => {
          const cls   = m.won ? 'won' : 'lost';
          const delta = m.won ? `+${m.ratingChange}` : `${m.ratingChange}`;
          const dCls  = m.won ? 'pos' : 'neg';
          return `<div class="match-entry ${cls}">
            <span class="match-opponent">vs ${escHtml(m.opponent)}</span>
            <span class="match-score">${m.myScore} – ${m.opponentScore}</span>
            ${m.mode === 'ranked' ? `<span class="match-delta ${dCls}">${delta}</span>` : '<span class="match-delta neutral">Casual</span>'}
          </div>`;
        }).join('');
      }
    } catch (err) {
      card.innerHTML = `<p style="color:var(--danger)">Failed to load profile: ${err.message}</p>`;
    }
  }

  // ── Particles ─────────────────────────────────────────────────────────────

  function spawnParticles() {
    const container = document.getElementById('particles');
    const colors    = ['#6c63ff', '#ff4d94', '#00e5ff', '#ffd700'];
    const count     = 18;

    for (let i = 0; i < count; i++) {
      const particle = document.createElement('div');
      particle.className = 'particle';

      const size  = Math.random() * 8 + 3;
      const color = colors[Math.floor(Math.random() * colors.length)];
      const x     = Math.random() * 100;
      const delay = Math.random() * 12;
      const dur   = Math.random() * 12 + 10;

      particle.style.cssText = `
        left: ${x}%;
        width: ${size}px;
        height: ${size}px;
        background: ${color};
        animation-duration: ${dur}s;
        animation-delay: ${delay}s;
      `;

      container.appendChild(particle);
    }
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    spawnParticles();

    // Restore session
    if (Auth.loadSession()) {
      updateHomeScreen();
      window.currentUser = Auth.getUser();
      // Reconnect socket silently
      Game.connect();
    }

    // Init battle module
    if (window.battleModule) window.battleModule.init();

    showScreen('home');
  }

  init();

  // Expose globals for cross-module use (battle.js, game.js callbacks)
  window.showScreen = showScreen;
  window.showToast  = showToast;

  return { showScreen, showToast, updateHomeScreen };

})();
