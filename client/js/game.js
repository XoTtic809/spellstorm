/**
 * SpellStorm — Game Client Module
 *
 * Handles Socket.io connection, matchmaking, game events,
 * timer animation, answer submission, and results rendering.
 */

const Game = (() => {

  // ── State ─────────────────────────────────────────────────────────────────

  let socket         = null;
  let currentRoomId  = null;
  let currentMode    = null;
  let localTimer     = null;   // Visual timer (server is authoritative)
  let roundMs        = 6000;
  let roundStartTime = null;
  let selfUsername   = null;
  let opponentUsername = null;
  let hasSubmitted   = false;

  const TIMER_CIRCUMFERENCE = 326.7; // 2π × 52

  // ── DOM refs ──────────────────────────────────────────────────────────────

  const els = {
    // Match found overlay
    matchFoundOverlay: document.getElementById('match-found-overlay'),
    mfPlayer1:         document.getElementById('mf-player1'),
    mfPlayer2:         document.getElementById('mf-player2'),
    mfCountdown:       document.getElementById('mf-countdown'),

    // Game screen
    gameWord:          document.getElementById('game-word'),
    wordDifficulty:    document.getElementById('word-difficulty'),
    timerArc:          document.getElementById('timer-arc'),
    timerValue:        document.getElementById('game-timer'),
    answerInput:       document.getElementById('answer-input'),
    answerWrap:        document.getElementById('answer-input-wrap'),
    answerFeedback:    document.getElementById('answer-feedback'),
    submitBtn:         document.getElementById('btn-submit-answer'),
    gameRound:         document.getElementById('game-round'),
    gameTotalRounds:   document.getElementById('game-total-rounds'),
    scoreSelf:         null, // set after knowing which player we are
    scoreOpp:          null,
    gameP1Name:        document.getElementById('game-p1-name'),
    gameP2Name:        document.getElementById('game-p2-name'),
    gameP1Rank:        document.getElementById('game-p1-rank'),
    gameP2Rank:        document.getElementById('game-p2-rank'),
    gameModeTag:       document.getElementById('game-mode-tag'),
    gameScoreP1:       document.getElementById('game-score-p1'),
    gameScoreP2:       document.getElementById('game-score-p2'),
    p1Warnings:        document.getElementById('game-p1-warnings'),
    p2Warnings:        document.getElementById('game-p2-warnings'),

    // Queue
    queueSize:   document.getElementById('queue-size'),
    queueRating: document.getElementById('queue-rating'),
    queueWait:   document.getElementById('queue-wait'),
    queueBadge:  document.getElementById('queue-mode-badge'),

    // Results
    resIcon:          document.getElementById('results-icon'),
    resTitle:         document.getElementById('results-title'),
    resSub:           document.getElementById('results-subtitle'),
    resSelfName:      document.getElementById('res-self-name'),
    resSelfScore:     document.getElementById('res-self-score'),
    resOppName:       document.getElementById('res-opp-name'),
    resOppScore:      document.getElementById('res-opp-score'),
    resRatingSection: document.getElementById('results-rating-section'),
    resRatingChange:  document.getElementById('res-rating-change'),
    resNewRating:     document.getElementById('res-new-rating'),
    resRankName:      document.getElementById('res-rank-name'),
    resRankNext:      document.getElementById('res-rank-next'),
    resRankProgress:  document.getElementById('res-rank-progress'),
  };

  // ── Connection ────────────────────────────────────────────────────────────

  function connect() {
    if (socket) return socket;

    const token = Auth.getToken();
    if (!token) return null;

    socket = io({ auth: { token }, transports: ['websocket'] });

    socket.on('connect', () => {
      console.log('[Game] Socket connected:', socket.id);
    });

    socket.on('disconnect', (reason) => {
      console.log('[Game] Socket disconnected:', reason);
      if (reason === 'io server disconnect') {
        Main.showToast('Disconnected from server.', 'error');
      }
    });

    socket.on('connect_error', (err) => {
      console.error('[Game] Connection error:', err.message);
      Main.showToast('Connection failed: ' + err.message, 'error');
    });

    socket.on('error', ({ message }) => {
      Main.showToast(message, 'error');
    });

    // ── Queue events ──────────────────────────────────────────────────────

    socket.on('queue:joined', ({ mode, sizes }) => {
      updateQueueSizes(sizes);
    });

    socket.on('queue:sizes', (sizes) => {
      updateQueueSizes(sizes);
    });

    // ── Match events ──────────────────────────────────────────────────────

    socket.on('match:found', onMatchFound);
    socket.on('round:start', onRoundStart);
    socket.on('round:correct', onRoundCorrect);
    socket.on('round:timeout', onRoundTimeout);
    socket.on('match:end', onMatchEnd);

    // ── Answer events ─────────────────────────────────────────────────────

    socket.on('answer:wrong', ({ answer }) => {
      showAnswerFeedback('wrong', '✗ Incorrect');
      els.answerWrap.classList.add('shake');
      els.answerWrap.addEventListener('animationend', () => {
        els.answerWrap.classList.remove('shake');
      }, { once: true });
    });

    socket.on('answer:duplicate', () => {
      showAnswerFeedback('wrong', 'Already submitted this round');
    });

    socket.on('answer:too_late', () => {
      showAnswerFeedback('wrong', 'Too slow — round expired');
    });

    // ── Anti-cheat events ─────────────────────────────────────────────────

    socket.on('anticheat:warning', (data) => {
      AntiCheat.onServerWarning(data);
    });

    socket.on('anticheat:lose_round', ({ username, warnings }) => {
      if (username === selfUsername) {
        showAnswerFeedback('wrong', '⚠ Tab switch — you lost the round!');
      }
    });

    socket.on('anticheat:forfeit', ({ username, reason }) => {
      AntiCheat.showWarning(3, reason);
    });

    return socket;
  }

  function disconnect() {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  }

  // ── Queue ─────────────────────────────────────────────────────────────────

  let queueWaitInterval = null;
  let queueStartTime    = null;

  function joinQueue(mode) {
    if (!connect()) {
      Main.showToast('Please login first', 'error');
      Main.showScreen('auth');
      return;
    }

    currentMode = mode;
    selfUsername = Auth.getUser()?.username;

    // Update queue UI
    const user = Auth.getUser();
    els.queueRating.textContent = user?.rating ?? '—';
    els.queueBadge.textContent  = mode === 'ranked' ? 'Ranked' : 'Casual';

    socket.emit('queue:join', { mode });

    // Wait timer
    queueStartTime = Date.now();
    queueWaitInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - queueStartTime) / 1000);
      els.queueWait.textContent = secs + 's';
    }, 1000);

    Main.showScreen('queue');
  }

  function leaveQueue() {
    clearInterval(queueWaitInterval);
    if (socket) socket.emit('queue:leave');
    Main.showScreen('home');
  }

  function updateQueueSizes(sizes) {
    const mode = currentMode || 'ranked';
    els.queueSize.textContent = sizes[mode] ?? '—';
  }

  // ── Match Found ───────────────────────────────────────────────────────────

  function onMatchFound(data) {
    clearInterval(queueWaitInterval);

    currentRoomId    = data.roomId;
    selfUsername     = data.self.username;
    opponentUsername = data.opponent.username;

    // Show match found overlay
    els.mfPlayer1.textContent = selfUsername;
    els.mfPlayer2.textContent = opponentUsername;
    els.matchFoundOverlay.classList.remove('hidden');

    // Countdown animation
    let count = 3;
    els.mfCountdown.textContent = count;

    const tick = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(tick);
        els.matchFoundOverlay.classList.add('hidden');
        return;
      }
      els.mfCountdown.textContent = count;
      els.mfCountdown.style.animation = 'none';
      void els.mfCountdown.offsetWidth;
      els.mfCountdown.style.animation = 'countdownPop 0.4s cubic-bezier(0.34,1.56,0.64,1) both';
    }, 1000);

    // Setup game screen
    setupGameScreen(data);
    Main.showScreen('game');

    // Activate anti-cheat
    AntiCheat.activate(currentRoomId, socket);
  }

  function setupGameScreen(data) {
    const self = data.self;
    const opp  = data.opponent;

    // P1 = self, P2 = opponent (always)
    els.gameP1Name.textContent = self.username;
    els.gameP2Name.textContent = opp.username;
    els.gameP1Rank.textContent = self.rank?.name ?? '';
    els.gameP2Rank.textContent = opp.rank?.name ?? '';
    els.gameScoreP1.textContent = '0';
    els.gameScoreP2.textContent = '0';
    els.gameTotalRounds.textContent = '7';
    els.gameModeTag.textContent     = data.mode === 'ranked' ? 'Ranked' : 'Casual';

    applyRankColor(els.gameP1Rank, self.rank?.name);
    applyRankColor(els.gameP2Rank, opp.rank?.name);
    resetWarningDots(els.p1Warnings);
    resetWarningDots(els.p2Warnings);
  }

  // ── Round ─────────────────────────────────────────────────────────────────

  function onRoundStart(data) {
    hasSubmitted = false;
    els.gameTotalRounds.textContent = data.totalRounds;
    els.gameRound.textContent       = data.round;

    // Update scores
    updateScores(data.scores);

    // Display word with animated letters
    displayWord(data.word);
    els.wordDifficulty.textContent = data.difficulty.toUpperCase();

    // Reset input
    els.answerInput.value = '';
    clearAnswerFeedback();
    els.answerInput.disabled  = false;
    els.answerInput.focus();

    // Start visual timer
    roundMs        = data.timerMs || 6000;
    roundStartTime = Date.now();
    startVisualTimer(roundMs);
  }

  function displayWord(word) {
    els.gameWord.innerHTML = '';
    word.split('').forEach((char, i) => {
      const span = document.createElement('span');
      span.className  = 'word-letter';
      span.textContent = char;
      span.style.animationDelay = `${i * 0.06}s`;
      els.gameWord.appendChild(span);
    });
  }

  function startVisualTimer(ms) {
    clearInterval(localTimer);

    const totalMs   = ms;
    const arcLen    = TIMER_CIRCUMFERENCE;
    const startTime = Date.now();

    function tick() {
      const elapsed = Date.now() - startTime;
      const frac    = Math.max(0, 1 - elapsed / totalMs);
      const secsLeft = Math.ceil((totalMs - elapsed) / 1000);

      // Arc
      els.timerArc.style.strokeDashoffset = arcLen * (1 - frac);

      // Danger state at ≤ 2s
      const danger = secsLeft <= 2;
      els.timerArc.classList.toggle('danger', danger);
      els.timerValue.classList.toggle('danger', danger);
      els.timerValue.textContent = Math.max(0, secsLeft);

      if (elapsed < totalMs) {
        localTimer = requestAnimationFrame(tick);
      } else {
        els.timerValue.textContent = '0';
        els.answerInput.disabled   = true;
      }
    }

    localTimer = requestAnimationFrame(tick);
  }

  function stopVisualTimer() {
    cancelAnimationFrame(localTimer);
  }

  function onRoundCorrect(data) {
    stopVisualTimer();
    els.answerInput.disabled = true;

    updateScores(data.scores);

    const iSelf = data.winner === selfUsername;

    if (iSelf) {
      els.answerWrap.classList.add('correct');
      showAnswerFeedback('correct', '✓ Correct!');
      flashScreen();
      setTimeout(() => els.answerWrap.classList.remove('correct'), 1500);
    } else {
      showAnswerFeedback('wrong', `${data.winner} got it${data.reason === 'opponent_tabswitch' ? '' : ` — "${data.word}"`}`);
    }

    clearAnswerFeedback(2200);
  }

  function onRoundTimeout(data) {
    stopVisualTimer();
    els.answerInput.disabled = true;
    updateScores(data.scores);
    showAnswerFeedback('wrong', `Time! The word was "${data.word}"`);
    clearAnswerFeedback(2200);
  }

  // ── Answer Submission ────────────────────────────────────────────────────

  function submitAnswer() {
    if (hasSubmitted || !currentRoomId) return;
    const answer = els.answerInput.value.trim();
    if (!answer) return;

    hasSubmitted = true;
    socket.emit('game:submit', { roomId: currentRoomId, answer });
  }

  // ── Match End ─────────────────────────────────────────────────────────────

  async function onMatchEnd(data) {
    AntiCheat.deactivate();
    stopVisualTimer();
    clearAnswerFeedback();

    const won = data.winner === selfUsername;
    const tie = data.winner === null;

    // Refresh local user data
    await Auth.refreshUser();

    // Populate results screen
    els.resIcon.textContent = tie ? '🤝' : won ? '🏆' : '💀';
    els.resTitle.textContent = tie ? 'Draw!' : won ? 'Victory!' : 'Defeat';
    els.resTitle.className   = 'results-title ' + (tie ? 'tie' : won ? 'win' : 'lose');
    els.resSub.textContent   = data.forfeit ? (won ? 'Opponent forfeited' : 'You forfeited') : '';

    els.resSelfName.textContent  = data.self.username;
    els.resOppName.textContent   = data.opponent.username;
    els.resSelfScore.textContent = data.self.score;
    els.resOppScore.textContent  = data.opponent.score;

    // Rating change (ranked only)
    if (currentMode === 'ranked' && data.self.ratingDelta !== undefined) {
      els.resRatingSection.classList.remove('hidden');
      const delta = data.self.ratingDelta;
      els.resRatingChange.textContent = (delta >= 0 ? '+' : '') + delta;
      els.resRatingChange.className   = 'rating-change ' + (delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral');
      els.resNewRating.textContent    = data.self.newRating;

      if (data.self.rank) {
        const rank = data.self.rank;
        els.resRankName.textContent   = rank.name;
        els.resRankNext.textContent   = getNextRankName(rank.name);
        els.resRankProgress.style.width = (rank.progress * 100).toFixed(1) + '%';
      }
    } else {
      els.resRatingSection.classList.add('hidden');
    }

    setTimeout(() => Main.showScreen('results'), 400);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function updateScores(scores) {
    // scores = { username1: n, username2: n }
    const entries = Object.entries(scores);
    for (const [name, score] of entries) {
      if (name === selfUsername) {
        els.gameScoreP1.textContent = score;
      } else {
        els.gameScoreP2.textContent = score;
      }
    }
  }

  function showAnswerFeedback(type, msg) {
    els.answerFeedback.textContent = msg;
    els.answerFeedback.className   = 'answer-feedback ' + type;
  }

  function clearAnswerFeedback(delay = 0) {
    if (delay) {
      setTimeout(() => {
        els.answerFeedback.textContent = '';
        els.answerFeedback.className   = 'answer-feedback';
      }, delay);
    } else {
      els.answerFeedback.textContent = '';
      els.answerFeedback.className   = 'answer-feedback';
    }
  }

  function flashScreen() {
    const flash = document.createElement('div');
    flash.className = 'round-correct-flash';
    document.body.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove(), { once: true });
  }

  function applyRankColor(el, rankName) {
    const colorMap = {
      Bronze:   '#cd7f32',
      Silver:   '#c0c0c0',
      Gold:     '#ffd700',
      Platinum: '#00e5ff',
      Diamond:  '#b39ddb',
      Master:   '#ff4081',
    };
    const color = colorMap[rankName] || 'rgba(255,255,255,0.4)';
    el.style.borderColor = color;
    el.style.color       = color;
  }

  function resetWarningDots(container) {
    container.querySelectorAll('.warning-dot').forEach(d => {
      d.classList.remove('active', 'danger');
    });
  }

  function getNextRankName(current) {
    const order = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master'];
    const idx = order.indexOf(current);
    return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : 'MAX';
  }

  // ── Event Listeners ───────────────────────────────────────────────────────

  document.getElementById('btn-submit-answer').addEventListener('click', submitAnswer);

  document.getElementById('answer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAnswer();
  });

  document.getElementById('btn-queue-cancel').addEventListener('click', leaveQueue);

  return {
    connect,
    disconnect,
    joinQueue,
    leaveQueue,
    getSocket: () => socket,
    getCurrentMode: () => currentMode,
  };
})();
