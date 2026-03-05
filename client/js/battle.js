/**
 * SpellStorm — Battle Royale Client Module
 *
 * Handles all battle-mode socket events and UI logic.
 * Loaded after game.js; shares the same socket instance via window.socket.
 */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  let battleRoomId       = null;
  let battleRoundId      = null;
  let battleSubMode      = 'party'; // 'party' | 'elimination'
  let battleRound        = 0;
  let battleTotalRounds  = 10;
  let battleMySocketId   = null;
  let battleHasSubmitted = false;
  let battleTimerRAF     = null;
  let battleTimerStart   = null;
  let battleTimerMs      = 15000;
  let battleQueueStart   = null;
  let battleQueueTimer   = null;

  // Selected sub-mode on the menu screen
  let selectedSubMode = 'party';

  // ── DOM refs ───────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);

  // ── Initialization (called after DOM ready) ────────────────────────────────

  function init() {
    // Sub-mode selector buttons
    document.querySelectorAll('.submode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.submode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedSubMode = btn.dataset.submode;
      });
    });

    // Battle menu actions
    $('btn-battle-auto')?.addEventListener('click', () => {
      if (!requireAuth()) return;
      joinBattleQueue(selectedSubMode);
    });

    $('btn-battle-create')?.addEventListener('click', () => {
      if (!requireAuth()) return;
      getSocket().emit('battle:create', { subMode: selectedSubMode });
    });

    $('btn-battle-join-code')?.addEventListener('click', () => {
      if (!requireAuth()) return;
      const code = ($('battle-code-input')?.value || '').trim().toUpperCase();
      if (!code) { showToast('Please enter a lobby code.', 'error'); return; }
      getSocket().emit('battle:join', { code });
    });

    $('battle-code-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btn-battle-join-code')?.click();
    });

    // FIX: was 'screen-home'
    $('battle-menu-back')?.addEventListener('click', () => showScreen('home'));

    // Lobby actions
    $('btn-lobby-start')?.addEventListener('click', () => {
      getSocket().emit('battle:start');
    });

    // FIX: was 'screen-battle-menu'
    $('btn-lobby-leave')?.addEventListener('click', () => {
      getSocket().emit('battle:leave');
      showScreen('battle-menu');
    });

    $('btn-copy-code')?.addEventListener('click', () => {
      const code = $('lobby-code-value')?.textContent;
      if (code) {
        navigator.clipboard.writeText(code).then(() => showToast('Code copied!', 'success'));
      }
    });

    // Battle queue cancel — FIX: was 'screen-battle-menu'
    $('btn-battle-queue-cancel')?.addEventListener('click', () => {
      getSocket().emit('battle:queue:leave');
      clearInterval(battleQueueTimer);
      showScreen('battle-menu');
    });

    // Battle game submit
    $('btn-battle-submit')?.addEventListener('click', submitBattleAnswer);
    $('battle-answer-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitBattleAnswer();
    });

    // Battle results actions — FIX: were 'screen-battle-menu' / 'screen-home'
    $('btn-battle-again')?.addEventListener('click', () => showScreen('battle-menu'));
    $('btn-battle-results-home')?.addEventListener('click', () => showScreen('home'));
  }

  function attachSocketEvents(socket) {
    battleMySocketId = socket.id;

    // ── Lobby events ────────────────────────────────────────────────────────

    // FIX: was 'screen-battle-lobby'
    socket.on('battle:lobby:created', ({ code, lobby }) => {
      renderLobby(lobby, code, true);
      showScreen('battle-lobby');
    });

    socket.on('battle:lobby:joined', ({ code, lobby }) => {
      renderLobby(lobby, code, false);
      showScreen('battle-lobby');  // FIX: was 'screen-battle-lobby'
    });

    socket.on('battle:lobby:update', ({ lobby }) => {
      const code   = lobby.code;
      const isHost = lobby.hostSocketId === socket.id;
      renderLobby(lobby, code, isHost);
    });

    // FIX: was 'screen-battle-menu'
    socket.on('battle:lobby:left', () => {
      showScreen('battle-menu');
    });

    // ── Queue events ────────────────────────────────────────────────────────

    socket.on('battle:queue:joined', ({ subMode, queueSize }) => {
      battleSubMode = subMode;
      $('battle-queue-submode').textContent = subMode === 'party' ? 'Party' : 'Elimination';
      $('battle-queue-badge').textContent   = `Battle · ${subMode === 'party' ? 'Party' : 'Elimination'}`;
      $('battle-queue-size').textContent    = queueSize;

      battleQueueStart = Date.now();
      clearInterval(battleQueueTimer);
      battleQueueTimer = setInterval(() => {
        const secs = Math.floor((Date.now() - battleQueueStart) / 1000);
        const el = $('battle-queue-wait');
        if (el) el.textContent = `${secs}s`;
      }, 1000);

      showScreen('battle-queue');  // FIX: was 'screen-battle-queue'
    });

    socket.on('battle:queue:left', () => {
      clearInterval(battleQueueTimer);
    });

    socket.on('battle:queue:sizes', ({ party, elimination }) => {
      const badge = $('battle-auto-queue-size');
      if (badge) {
        const count = selectedSubMode === 'party' ? party : elimination;
        badge.textContent = `${count} in queue`;
        badge.classList.toggle('hidden', count === 0);
      }
      const qSize = $('battle-queue-size');
      if (qSize && battleSubMode) {
        qSize.textContent = battleSubMode === 'party' ? party : elimination;
      }
    });

    // ── Battle game events ──────────────────────────────────────────────────

    socket.on('battle:found', ({ roomId, subMode, players, totalRounds }) => {
      battleRoomId      = roomId;
      battleSubMode     = subMode;
      battleTotalRounds = totalRounds;
      battleMySocketId  = socket.id;

      clearInterval(battleQueueTimer);

      // Show found overlay
      const overlay = $('battle-found-overlay');
      if (overlay) {
        overlay.classList.remove('hidden');
        const list = $('battle-found-players');
        if (list) {
          list.innerHTML = players.map(p =>
            `<div class="battle-found-player">${p.username}</div>`
          ).join('<div class="battle-found-vs-dot">·</div>');
        }

        let count = 4;
        const countEl = $('battle-found-countdown');
        if (countEl) countEl.textContent = count;

        const tick = setInterval(() => {
          count--;
          if (countEl) countEl.textContent = count;
          if (count <= 0) {
            clearInterval(tick);
            overlay.classList.add('hidden');
            setupBattleScreen(players, subMode);
            showScreen('battle');  // FIX: was 'screen-battle'
          }
        }, 1000);
      }
    });

    socket.on('battle:round:start', ({ roundId, round, totalRounds, word, difficulty, timerMs, scores }) => {
      battleRoundId      = roundId;
      battleRound        = round;
      battleTotalRounds  = totalRounds;
      battleHasSubmitted = false;

      $('battle-round').textContent           = round;
      $('battle-total-rounds').textContent    = totalRounds;
      $('battle-word-difficulty').textContent = difficulty.toUpperCase();

      const feedback = $('battle-answer-feedback');
      if (feedback) { feedback.textContent = ''; feedback.style.color = ''; }

      // Animate word
      renderBattleWord(word);

      // Enable input
      const input = $('battle-answer-input');
      if (input) { input.value = ''; input.disabled = false; input.focus(); }
      const submitBtn = $('btn-battle-submit');
      if (submitBtn) submitBtn.disabled = false;

      // Update player list
      renderBattlePlayers(scores);

      // Start visual timer
      startBattleTimer(timerMs);
    });

    // FIX: 'answer:wrong' from the server goes to the battle UI when in battle mode.
    // game.js also has an answer:wrong handler but it targets the 1v1 elements (which
    // are invisible during battle), so having both listeners is safe.
    socket.on('answer:wrong', () => {
      if (!battleRoomId) return; // only act if we are in a battle

      const feedback = $('battle-answer-feedback');
      if (feedback) {
        feedback.textContent = '✗ Incorrect';
        feedback.style.color = 'var(--danger)';
      }
      const input = $('battle-answer-input');
      if (input) {
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 400);
      }
    });

    socket.on('battle:answer:result', ({ socketId, correct, pointsEarned, rank, scores }) => {
      renderBattlePlayers(scores);

      if (socketId === battleMySocketId) {
        const feedback = $('battle-answer-feedback');
        if (correct) {
          if (feedback) {
            feedback.textContent = `+${pointsEarned} pts · ${ordinal(rank)} to answer!`;
            feedback.style.color = 'var(--success)';
          }
          const wrap = $('battle-answer-wrap');
          if (wrap) {
            wrap.classList.add('correct');
            setTimeout(() => wrap.classList.remove('correct'), 600);
          }
        }
      }
    });

    socket.on('battle:round:end', ({ word, scores, eliminatedIds, nextRoundInMs }) => {
      stopBattleTimer();

      const input = $('battle-answer-input');
      if (input) input.disabled = true;
      const submitBtn = $('btn-battle-submit');
      if (submitBtn) submitBtn.disabled = true;

      const feedback = $('battle-answer-feedback');
      if (!battleHasSubmitted && feedback) {
        feedback.textContent = `The word was: ${word}`;
        feedback.style.color = 'var(--text-secondary)';
      }

      // Mark eliminated players in the list
      renderBattlePlayers(scores, eliminatedIds);

      if (eliminatedIds.length > 0) {
        const elNames = scores
          .filter(p => eliminatedIds.includes(p.socketId))
          .map(p => p.username);
        if (elNames.length) showToast(`💀 ${elNames.join(', ')} eliminated!`, 'warning');
      }
    });

    // FIX: showBattleResults internally called showScreen('screen-battle-results')
    socket.on('battle:end', ({ rankings, subMode }) => {
      stopBattleTimer();
      showBattleResults(rankings, subMode);
    });

    socket.on('battle:resume', (data) => {
      battleRoomId       = data.roomId;
      battleSubMode      = data.subMode;
      battleRoundId      = data.roundId;
      battleRound        = data.round;
      battleTotalRounds  = data.totalRounds;
      battleHasSubmitted = false;

      setupBattleScreen(data.scores, data.subMode);
      showScreen('battle');  // FIX: was 'screen-battle'

      $('battle-round').textContent           = data.round;
      $('battle-total-rounds').textContent    = data.totalRounds;
      $('battle-word-difficulty').textContent = (data.difficulty || '').toUpperCase();
      renderBattleWord(data.word || '?');
      renderBattlePlayers(data.scores || []);

      if (data.timerRemainingMs > 0) {
        startBattleTimer(data.timerRemainingMs);
        const input = $('battle-answer-input');
        if (input) { input.disabled = false; input.focus(); }
      }
    });

    socket.on('battle:opponent:disconnected', ({ username }) => {
      showToast(`${username} disconnected (10s grace)`, 'warning');
    });

    socket.on('battle:opponent:reconnected', ({ username, timedOut }) => {
      if (timedOut) {
        showToast(`${username} timed out — eliminated`, 'error');
      } else {
        showToast(`${username} reconnected`, 'success');
      }
    });

    socket.on('battle:error', ({ message }) => {
      showToast(message, 'error');
    });
  }

  // ── Battle answer submission ───────────────────────────────────────────────

  function submitBattleAnswer() {
    if (battleHasSubmitted) return;
    const input = $('battle-answer-input');
    const answer = (input?.value || '').trim();
    if (!answer) return;

    battleHasSubmitted = true;
    if (input) input.disabled = true;
    const btn = $('btn-battle-submit');
    if (btn) btn.disabled = true;

    getSocket().emit('battle:submit', {
      roomId:  battleRoomId,
      answer,
      roundId: battleRoundId,
    });
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  function setupBattleScreen(players, subMode) {
    const badge = $('battle-submode-badge');
    if (badge) badge.textContent = subMode === 'party' ? '🎉 Party' : '💀 Elimination';
    renderBattlePlayers(players);
  }

  function renderBattleWord(word) {
    const container = $('battle-word');
    if (!container) return;
    container.innerHTML = word.split('').map((ch, i) =>
      `<span class="word-letter" style="animation-delay:${(i * 0.06).toFixed(2)}s">${ch}</span>`
    ).join('');
  }

  function renderBattlePlayers(scores, newlyEliminatedIds = []) {
    const list = $('battle-players-list');
    if (!list) return;

    list.innerHTML = scores.map((p, i) => {
      const isMe      = p.socketId === battleMySocketId;
      const isElim    = p.eliminated;
      const isNewElim = newlyEliminatedIds.includes(p.socketId);
      const statusIcon = isElim ? '💀' : p.roundCorrect ? '✓' : '⏳';
      const rankNum   = i + 1;

      return `<div class="battle-player-row ${isMe ? 'is-me' : ''} ${isElim ? 'eliminated' : ''} ${isNewElim ? 'just-eliminated' : ''}">
        <span class="bpr-rank">${rankNum}</span>
        <span class="bpr-name">${p.username}${isMe ? ' (you)' : ''}</span>
        <span class="bpr-score">${p.score}pts</span>
        <span class="bpr-status">${statusIcon}</span>
      </div>`;
    }).join('');
  }

  function renderLobby(lobby, code, isHost) {
    const codeEl = $('lobby-code-value');
    if (codeEl) codeEl.textContent = code;

    const tagEl = $('lobby-submode-tag');
    if (tagEl) tagEl.textContent = lobby.subMode === 'party' ? '🎉 Party' : '💀 Elimination';

    const countEl = $('lobby-player-count');
    if (countEl) countEl.textContent = lobby.players.length;

    const maxEl = $('lobby-max-players');
    if (maxEl) maxEl.textContent = lobby.maxPlayers;

    const listEl = $('lobby-players-list');
    if (listEl) {
      listEl.innerHTML = lobby.players.map(p => `
        <div class="lobby-player-row">
          <span class="lobby-player-crown">${p.isHost ? '👑' : '　'}</span>
          <span class="lobby-player-name">${p.username}${p.socketId === getSocket()?.id ? ' (you)' : ''}</span>
        </div>
      `).join('');
    }

    const startBtn = $('btn-lobby-start');
    if (startBtn) {
      startBtn.disabled    = !isHost || lobby.players.length < 2;
      startBtn.textContent = isHost ? 'Start Game' : 'Waiting for host…';
    }

    const hintEl = $('lobby-min-hint');
    if (hintEl) {
      hintEl.textContent = lobby.players.length < 2
        ? 'Waiting for at least 2 players…'
        : `${lobby.players.length} player${lobby.players.length > 1 ? 's' : ''} ready`;
    }
  }

  function showBattleResults(rankings, subMode) {
    const me = rankings.find(r => r.socketId === battleMySocketId);

    const icon  = $('battle-results-icon');
    const title = $('battle-results-title');
    const sub   = $('battle-results-subtitle');

    if (me?.isWinner) {
      if (icon)  icon.textContent  = '🏆';
      if (title) title.textContent = 'You Won!';
    } else if (me?.rank === 2) {
      if (icon)  icon.textContent  = '🥈';
      if (title) title.textContent = '2nd Place!';
    } else if (me?.rank === 3) {
      if (icon)  icon.textContent  = '🥉';
      if (title) title.textContent = '3rd Place!';
    } else {
      if (icon)  icon.textContent  = '💀';
      if (title) title.textContent = me?.eliminated ? 'Eliminated!' : `${ordinal(me?.rank || 0)} Place`;
    }

    if (sub) sub.textContent = `Battle Royale · ${subMode === 'party' ? 'Party' : 'Elimination'} · ${battleTotalRounds} rounds`;

    const rankList = $('battle-rankings');
    if (rankList) {
      rankList.innerHTML = rankings.map(r => `
        <div class="battle-rank-row ${r.isWinner ? 'winner' : ''} ${r.socketId === battleMySocketId ? 'is-me' : ''}">
          <span class="brr-rank">${rankIcon(r.rank)}</span>
          <span class="brr-name">${r.username}</span>
          <span class="brr-score">${r.score} pts</span>
        </div>
      `).join('');
    }

    showScreen('battle-results');  // FIX: was 'screen-battle-results'
  }

  // ── Visual timer ──────────────────────────────────────────────────────────

  function startBattleTimer(ms) {
    stopBattleTimer();
    battleTimerStart = performance.now();
    battleTimerMs    = ms;

    const arc    = $('battle-timer-arc');
    const label  = $('battle-timer');
    const circum = 2 * Math.PI * 34; // r=34

    if (arc) {
      arc.style.strokeDasharray  = circum;
      arc.style.strokeDashoffset = '0';
    }

    function tick(now) {
      const elapsed   = now - battleTimerStart;
      const remaining = Math.max(0, ms - elapsed);
      const frac      = remaining / ms;

      if (arc) {
        arc.style.strokeDashoffset = `${circum * (1 - frac)}`;
        arc.style.stroke = remaining <= 3000 ? '#ef4444' : '#6366f1';
      }
      if (label) label.textContent = Math.ceil(remaining / 1000);

      if (remaining > 0) {
        battleTimerRAF = requestAnimationFrame(tick);
      }
    }

    battleTimerRAF = requestAnimationFrame(tick);
  }

  function stopBattleTimer() {
    if (battleTimerRAF) { cancelAnimationFrame(battleTimerRAF); battleTimerRAF = null; }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function joinBattleQueue(subMode) {
    battleSubMode = subMode;
    getSocket().emit('battle:queue', { subMode });
  }

  function getSocket() {
    return window.socket;
  }

  function requireAuth() {
    if (!window.currentUser) {
      showToast('Please login to play Battle Royale.', 'error');
      showScreen('auth');
      return false;
    }
    return true;
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function rankIcon(rank) {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `#${rank}`;
  }

  // These are provided by main.js globals
  function showScreen(id) { window.showScreen?.(id); }
  function showToast(msg, type) { window.showToast?.(msg, type); }

  // ── Export ────────────────────────────────────────────────────────────────

  window.battleModule = { init, attachSocketEvents };

})();
