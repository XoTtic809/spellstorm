/**
 * SpellStorm — Anti-Cheat Frontend Module
 *
 * Detects tab switches and focus loss during an active match.
 * Reports events to the server via Socket.io.
 * Displays warning popup on first offense.
 */

const AntiCheat = (() => {
  let active    = false;
  let roomId    = null;
  let socket    = null;
  let warnings  = 0;

  const overlay  = document.getElementById('anticheat-overlay');
  const msgEl    = document.getElementById('anticheat-msg');
  const dismissBtn = document.getElementById('anticheat-dismiss');
  const pips     = document.querySelectorAll('#anticheat-overlay .pip');

  const MESSAGES = [
    'Warning 1/3: Do not switch tabs during a match!',
    'Warning 2/3: You just lost the round! One more and you forfeit!',
    'Warning 3/3: You have forfeited the match!',
  ];

  // ── Activation ────────────────────────────────────────────────────────────

  function activate(matchRoomId, socketInstance) {
    roomId = matchRoomId;
    socket = socketInstance;
    active = true;
    warnings = 0;
    updatePips(0);

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
  }

  function deactivate() {
    active = false;
    roomId = null;
    socket = null;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('blur', onBlur);
    hideOverlay();
  }

  // ── Event Handlers ─────────────────────────────────────────────────────────

  let _blurCooling = false; // prevent double-trigger from blur+visibilitychange

  function onVisibilityChange() {
    if (!active) return;
    if (document.visibilityState === 'hidden') {
      triggerTabSwitch();
    }
  }

  function onBlur() {
    if (!active || _blurCooling) return;
    if (document.visibilityState !== 'hidden') {
      // blur without visibility change (focus moved to another window element)
      triggerTabSwitch();
    }
  }

  function triggerTabSwitch() {
    if (!active || !socket) return;

    // Brief cooldown to avoid double-firing
    if (_blurCooling) return;
    _blurCooling = true;
    setTimeout(() => { _blurCooling = false; }, 600);

    warnings = Math.min(warnings + 1, 3);
    updatePips(warnings);
    socket.emit('game:tab_switch', { roomId });
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  function showWarning(warningCount, message) {
    warnings = warningCount;
    updatePips(warningCount);
    msgEl.textContent = message || MESSAGES[warningCount - 1] || MESSAGES[2];
    overlay.classList.remove('hidden');
  }

  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  function updatePips(count) {
    pips.forEach((pip, i) => {
      pip.classList.remove('active');
      if (i < count) pip.classList.add('active');
    });
  }

  // ── Server events (called by game.js) ────────────────────────────────────

  function onServerWarning({ warnings: w, message }) {
    showWarning(w, message);
  }

  dismissBtn.addEventListener('click', hideOverlay);

  return { activate, deactivate, onServerWarning, showWarning };
})();
