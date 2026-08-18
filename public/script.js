const socket = io();

// ---------- 전역 상태 ----------
const state = {
  myId: null,
  roomCode: null,
  hostId: null,
  players: [],
  hand: [],
  prompterId: null,
  clue: '',
  selectedCard: null, // 클릭해서 고른 카드(제시어 제출용 / 카드 제출용)
  submittedThisRound: false,
  votedThisRound: false,
  lobbyState: 'waiting', // waiting | game_ready
};

// ---------- DOM 헬퍼 ----------
const $ = (id) => document.getElementById(id);

const screens = {
  landing: $('screen-landing'),
  lobby: $('screen-lobby'),
  game: $('screen-game'),
  gameover: $('screen-gameover'),
};

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

function showError(message) {
  const toast = $('error-toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showError._timer);
  showError._timer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ---------- 화면 1: 랜딩 ----------
$('btn-create-room').addEventListener('click', () => {
  const nickname = $('create-nickname').value.trim();
  socket.emit('createRoom', { nickname });
});

$('btn-join-room').addEventListener('click', () => {
  const nickname = $('join-nickname').value.trim();
  const code = $('join-code').value.trim();
  socket.emit('joinRoom', { nickname, code });
});

$('btn-back-to-landing').addEventListener('click', () => {
  window.location.reload();
});

// ---------- 화면 2: 대기실 ----------
$('btn-home-lobby').addEventListener('click', () => {
  window.location.reload();
});

$('btn-start-game').addEventListener('click', () => {
  socket.emit('startGame');
});

$('btn-deal-cards').addEventListener('click', () => {
  socket.emit('dealCards');
});

$('btn-home-game').addEventListener('click', () => {
  window.location.reload();
});

function renderLobby() {
  $('lobby-code').textContent = state.roomCode;

  const list = $('lobby-players');
  list.innerHTML = '';
  state.players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = `${p.nickname}${p.id === state.hostId ? ' (방장)' : ''}`;
    list.appendChild(li);
  });

  const isHost = state.myId === state.hostId;
  const canStart = isHost && state.players.length >= 3;
  const isGameReady = state.lobbyState === 'game_ready';

  $('btn-start-game').classList.toggle('hidden', !isHost || isGameReady);
  $('btn-start-game').disabled = !canStart;

  $('btn-deal-cards').classList.toggle('hidden', !isHost || !isGameReady);
  $('btn-deal-cards').disabled = false;

  if (isGameReady) {
    $('lobby-hint').textContent = isHost ? '모든 플레이어가 준비됐습니다. "카드 나눠갖기"를 눌러 게임을 시작하세요.' : '방장이 카드를 나눠주기를 기다리는 중입니다...';
  } else if (isHost && state.players.length < 3) {
    $('lobby-hint').textContent = `게임을 시작하려면 최소 3명이 필요합니다. (현재 ${state.players.length}명)`;
  } else if (!isHost) {
    $('lobby-hint').textContent = '방장이 게임을 시작하기를 기다리는 중입니다...';
  } else {
    $('lobby-hint').textContent = '';
  }
}

// ---------- 화면 3: 게임 공통 ----------
function renderScoreboard() {
  const board = $('scoreboard');
  board.innerHTML = '';
  state.players.forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'score-chip' + (p.id === state.prompterId ? ' is-prompter' : '');
    chip.textContent = `${p.nickname}: ${p.score}점`;
    board.appendChild(chip);
  });
}

function renderHand(containerId, selectable, onSelect) {
  const wrap = $(containerId);
  wrap.innerHTML = '';
  state.hand.forEach((cardUrl) => {
    const card = document.createElement('div');
    card.className = 'card' + (state.selectedCard === cardUrl ? ' selected' : '');
    if (!selectable) card.classList.add('disabled');

    const img = document.createElement('img');
    img.src = cardUrl;
    card.appendChild(img);

    if (selectable) {
      card.addEventListener('click', () => onSelect(cardUrl));
    }
    wrap.appendChild(card);
  });
}

function resetPhaseVisibility() {
  ['phase-clue', 'phase-submit', 'phase-vote', 'phase-reveal'].forEach((id) => $(id).classList.add('hidden'));
  $('clue-banner').classList.add('hidden');
}

// ---------- Phase 1: 출제자 턴 ----------
function enterCluePhase(prompterName) {
  resetPhaseVisibility();
  state.selectedCard = null;
  state.submittedThisRound = false;
  state.votedThisRound = false;
  $('btn-next-round').classList.add('hidden');
  $('reveal-wait-msg').classList.add('hidden');

  $('phase-clue').classList.remove('hidden');
  const isPrompter = state.myId === state.prompterId;
  $('clue-phase-title').textContent = isPrompter
    ? '당신이 출제자입니다!'
    : `${prompterName}님이 출제자입니다.`;

  $('clue-input-area').classList.toggle('hidden', !isPrompter);
  $('clue-wait-msg').classList.toggle('hidden', isPrompter);
  $('clue-input').value = '';
  $('btn-submit-clue').disabled = true;

  const onSelectCard = (cardUrl) => {
    state.selectedCard = cardUrl;
    renderHand('my-hand', true, onSelectCard);
    updateClueSubmitButton();
  };
  renderHand('my-hand', isPrompter, onSelectCard);
}

function updateClueSubmitButton() {
  const clue = $('clue-input').value.trim();
  $('btn-submit-clue').disabled = !(clue && state.selectedCard);
}

$('clue-input').addEventListener('input', updateClueSubmitButton);

$('btn-submit-clue').addEventListener('click', () => {
  const clue = $('clue-input').value.trim();
  if (!clue || !state.selectedCard) return;
  socket.emit('submitClue', { cardId: state.selectedCard, clue });
});

// ---------- Phase 2: 카드 제출 ----------
function enterSubmitPhase(clue) {
  resetPhaseVisibility();
  state.clue = clue;
  state.selectedCard = null;
  state.submittedThisRound = false;

  $('clue-banner').classList.remove('hidden');
  $('clue-text').textContent = clue;
  $('prompter-card-back').classList.remove('hidden');

  $('phase-submit').classList.remove('hidden');
  const isPrompter = state.myId === state.prompterId;

  $('submit-wait-msg').classList.remove('hidden');
  $('submit-progress').textContent = '';
  $('submitted-cards').innerHTML = '';
  $('btn-shuffle-cards').classList.add('hidden');
  $('shuffle-wait-msg').classList.add('hidden');

  renderHand('my-hand', !isPrompter, (cardUrl) => {
    if (state.submittedThisRound) return;
    state.selectedCard = cardUrl;
    state.submittedThisRound = true;
    socket.emit('submitCard', { cardId: cardUrl });
    renderHand('my-hand', false, () => {});
  });
}

// ---------- Phase 3: 투표 ----------
function enterVotePhase(cards) {
  resetPhaseVisibility();
  $('clue-banner').classList.remove('hidden');
  $('clue-text').textContent = state.clue;
  $('prompter-card-back').classList.add('hidden');

  $('phase-vote').classList.remove('hidden');
  const isPrompter = state.myId === state.prompterId;
  $('vote-wait-msg').classList.toggle('hidden', !isPrompter);
  $('vote-progress').textContent = '';
  $('btn-reveal-answer').classList.add('hidden');
  $('reveal-wait-msg').classList.add('hidden');

  const grid = $('vote-cards');
  grid.innerHTML = '';
  cards.forEach(({ cardId }) => {
    const card = document.createElement('div');
    card.className = 'card';
    if (isPrompter || state.votedThisRound || cardId === state.selectedCard) {
      card.classList.add('disabled');
    }

    const img = document.createElement('img');
    img.src = cardId;
    card.appendChild(img);

    if (!isPrompter && !state.votedThisRound && cardId !== state.selectedCard) {
      card.addEventListener('click', () => {
        state.votedThisRound = true;
        socket.emit('submitVote', { cardId });
        Array.from(grid.children).forEach((c) => c.classList.add('disabled'));
      });
    }
    grid.appendChild(card);
  });

  renderHand('my-hand', false, () => {});
}

// ---------- Phase 4: 결과 공개 ----------
function enterRevealPhase(data) {
  resetPhaseVisibility();
  $('clue-banner').classList.remove('hidden');
  $('clue-text').textContent = state.clue;
  $('prompter-card-back').classList.add('hidden');

  $('phase-reveal').classList.remove('hidden');

  const grid = $('reveal-cards');
  grid.innerHTML = '';
  data.revealedCards.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'card disabled';
    if (c.cardId === data.correctCardId) card.classList.add('selected');

    const img = document.createElement('img');
    img.src = c.cardId;
    card.appendChild(img);

    const caption = document.createElement('div');
    caption.className = 'card-caption';
    const isCorrect = c.cardId === data.correctCardId;
    caption.textContent = `${c.ownerName}${isCorrect ? ' (정답)' : ''} · 득표 ${c.votes.length} · +${c.earnedPoints}점`;
    card.appendChild(caption);

    grid.appendChild(card);
  });

  const isHost = state.myId === state.hostId;
  if (!data.gameOver) {
    $('btn-next-round').classList.toggle('hidden', !isHost);
    $('reveal-wait-msg').classList.toggle('hidden', isHost);
  }
}

$('btn-shuffle-cards').addEventListener('click', () => {
  socket.emit('shuffleCards');
});

$('btn-reveal-answer').addEventListener('click', () => {
  socket.emit('revealAnswer');
});

$('btn-next-round').addEventListener('click', () => {
  socket.emit('nextRound');
});

// ---------- 화면 4: 게임 종료 ----------
function renderGameOver(players, reason) {
  $('gameover-reason').textContent = reason || '';
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const list = $('final-scores');
  list.innerHTML = '';
  sorted.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = `${p.nickname} - ${p.score}점`;
    list.appendChild(li);
  });
  showScreen('gameover');
}

// ---------- 소켓 이벤트 수신 ----------
socket.on('connect', () => {
  state.myId = socket.id;
});

socket.on('errorMessage', ({ message }) => showError(message));

socket.on('roomCreated', ({ code }) => {
  state.roomCode = code;
  showScreen('lobby');
});

socket.on('roomJoined', ({ code }) => {
  state.roomCode = code;
  showScreen('lobby');
});

socket.on('roomUpdate', ({ code, hostId, players, state: roomState, lobbyState: incomingLobbyState }) => {
  state.roomCode = code;
  state.hostId = hostId;
  state.players = players;
  if (incomingLobbyState) state.lobbyState = incomingLobbyState;

  if (roomState === 'lobby') {
    renderLobby();
  } else {
    renderScoreboard();
  }
});

socket.on('gameStarted', () => {
  showScreen('game');
  renderScoreboard();
});

socket.on('yourHand', ({ hand }) => {
  state.hand = hand;
  // 손패를 받은 후 현재 게임 상태에 맞춰 렌더링 업데이트
  if ($('phase-clue') && !$('phase-clue').classList.contains('hidden')) {
    const isPrompter = state.myId === state.prompterId;
    const onSelectCard = (cardUrl) => {
      state.selectedCard = cardUrl;
      renderHand('my-hand', true, onSelectCard);
      updateClueSubmitButton();
    };
    renderHand('my-hand', isPrompter, onSelectCard);
  } else if ($('phase-submit') && !$('phase-submit').classList.contains('hidden')) {
    const isPrompter = state.myId === state.prompterId;
    renderHand('my-hand', !isPrompter, (cardUrl) => {
      if (state.submittedThisRound) return;
      state.selectedCard = cardUrl;
      state.submittedThisRound = true;
      socket.emit('submitCard', { cardId: cardUrl });
      renderHand('my-hand', false, () => {});
    });
  }
});

socket.on('cluePhase', ({ prompterId, prompterName }) => {
  state.prompterId = prompterId;
  renderScoreboard();
  enterCluePhase(prompterName);
});

socket.on('submitPhase', ({ clue, prompterId }) => {
  state.prompterId = prompterId;
  enterSubmitPhase(clue);
});

socket.on('submitProgress', ({ submittedCount, totalNeeded }) => {
  $('submit-progress').textContent = `제출 완료: ${submittedCount} / ${totalNeeded}`;

  // 제출된 카드를 뒷면으로 표시
  const grid = $('submitted-cards');
  if (submittedCount > grid.children.length) {
    const card = document.createElement('div');
    card.className = 'card disabled';
    const cardBack = document.createElement('div');
    cardBack.className = 'card-back-face';
    cardBack.innerHTML = '<span class="card-back-mark">?</span>';
    card.appendChild(cardBack);
    grid.appendChild(card);
  }

  // 모든 카드가 제출되면 버튼 활성화 (출제자만)
  const isPrompter = state.myId === state.prompterId;
  if (isPrompter && submittedCount === totalNeeded) {
    $('btn-shuffle-cards').classList.remove('hidden');
  }
});

socket.on('votePhase', ({ cards }) => {
  enterVotePhase(cards);
});

socket.on('voteProgress', ({ votedCount, totalNeeded }) => {
  $('vote-progress').textContent = `투표 완료: ${votedCount} / ${totalNeeded}`;

  // 모든 투표가 완료되면 출제자에게 정답 공개 버튼 활성화
  const isPrompter = state.myId === state.prompterId;
  if (isPrompter && votedCount === totalNeeded) {
    $('btn-reveal-answer').classList.remove('hidden');
  }
});

socket.on('roundResult', (data) => {
  state.players = data.players;
  renderScoreboard();
  enterRevealPhase(data);
  if (data.gameOver) {
    setTimeout(() => renderGameOver(data.players, '한 플레이어가 목표 점수에 도달했습니다.'), 1500);
  }
});

socket.on('gameOver', ({ players, reason }) => {
  renderGameOver(players, reason);
});

socket.on('disconnect', () => {
  showError('서버와의 연결이 끊어졌습니다.');
});
