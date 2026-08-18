const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { loadImageList } = require('./imageLoader');
const { RoomManager, MIN_PLAYERS } = require('./roomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');

app.use(express.static(PUBLIC_DIR));
app.use('/images', express.static(IMAGES_DIR));

const imagePool = loadImageList();
console.log(`[server] 카드 이미지 ${imagePool.length}장 로드 완료`);

const roomManager = new RoomManager(imagePool);

// ---------- 방(Room) 단위 브로드캐스트 헬퍼 ----------
// Socket.io의 room 기능(socket.join(code) + io.to(code).emit(...))으로
// 이벤트가 해당 방 참가자에게만 전달되도록 분리한다.

function broadcastRoomUpdate(room) {
  io.to(room.code).emit('roomUpdate', {
    code: room.code,
    hostId: room.hostId,
    players: room.getPublicPlayers(),
    state: room.state,
    lobbyState: room.lobbyState,
  });
}

function sendHandsToRoom(room) {
  for (const player of room.players.values()) {
    io.to(player.id).emit('yourHand', { hand: player.hand });
  }
}

function startCluePhase(room) {
  room.state = 'clue';
  const prompter = room.players.get(room.prompterId);
  io.to(room.code).emit('cluePhase', {
    prompterId: room.prompterId,
    prompterName: prompter ? prompter.nickname : '',
  });
  sendHandsToRoom(room);
  broadcastRoomUpdate(room);
}

function shuffleForVote(room) {
  const entries = Array.from(room.roundCards.entries()); // [playerId, cardUrl]
  for (let i = entries.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return entries.map(([, cardUrl]) => ({ cardId: cardUrl }));
}

function revealRound(room) {
  room.state = 'reveal';
  const { roundScores, correctVoters, prompterId } = room.calculateScores();

  const revealedCards = Array.from(room.roundCards.entries()).map(([playerId, cardUrl]) => {
    const owner = room.players.get(playerId);
    const votesForCard = Array.from(room.votes.entries())
      .filter(([, ownerId]) => ownerId === playerId)
      .map(([voterId]) => {
        const voter = room.players.get(voterId);
        return voter ? voter.nickname : '알 수 없음';
      });

    return {
      cardId: cardUrl,
      ownerId: playerId,
      ownerName: owner ? owner.nickname : '알 수 없음',
      votes: votesForCard,
      earnedPoints: roundScores[playerId] || 0,
    };
  });

  const gameOver = room.isGameOver();
  if (gameOver) room.state = 'ended';

  io.to(room.code).emit('roundResult', {
    prompterId,
    correctCardId: room.roundCards.get(prompterId),
    correctVoters: correctVoters.map((id) => {
      const p = room.players.get(id);
      return p ? p.nickname : '알 수 없음';
    }),
    revealedCards,
    players: room.getPublicPlayers(),
    gameOver,
  });
}

io.on('connection', (socket) => {
  // ---------- 1. 방 생성 ----------
  socket.on('createRoom', ({ nickname } = {}) => {
    if (!nickname || !nickname.trim()) {
      socket.emit('errorMessage', { message: '닉네임을 입력해주세요.' });
      return;
    }
    if (imagePool.length < MIN_PLAYERS * 6) {
      socket.emit('errorMessage', { message: '서버에 등록된 카드 이미지가 부족합니다. 관리자에게 문의하세요.' });
      return;
    }

    let room;
    try {
      room = roomManager.createRoom(socket.id);
    } catch (err) {
      socket.emit('errorMessage', { message: '생성 가능한 방 개수(최대 20개)를 초과했습니다.' });
      return;
    }

    room.addPlayer(socket.id, nickname.trim());
    socket.join(room.code); // Socket.io room 입장 -> 이후 io.to(room.code)로 이 방에만 브로드캐스트
    socket.data.roomCode = room.code;

    socket.emit('roomCreated', { code: room.code });
    broadcastRoomUpdate(room);
  });

  // ---------- 1. 방 입장 ----------
  socket.on('joinRoom', ({ nickname, code } = {}) => {
    if (!nickname || !nickname.trim() || !code) {
      socket.emit('errorMessage', { message: '닉네임과 방 코드를 입력해주세요.' });
      return;
    }

    const room = roomManager.getRoom(String(code).trim());
    if (!room) {
      socket.emit('errorMessage', { message: '존재하지 않는 방 코드입니다.' });
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('errorMessage', { message: '이미 게임이 시작된 방입니다.' });
      return;
    }
    if (room.isFull()) {
      socket.emit('errorMessage', { message: '방이 가득 찼습니다. (최대 6명)' });
      return;
    }
    const nicknameTaken = Array.from(room.players.values()).some(
      (p) => p.nickname === nickname.trim(),
    );
    if (nicknameTaken) {
      socket.emit('errorMessage', { message: '이미 사용 중인 닉네임입니다.' });
      return;
    }

    room.addPlayer(socket.id, nickname.trim());
    socket.join(room.code);
    socket.data.roomCode = room.code;

    socket.emit('roomJoined', { code: room.code });
    broadcastRoomUpdate(room);
  });

  // ---------- 2. 게임 시작 준비 (방장 전용, 1단계: 참가자 대기) ----------
  socket.on('startGame', () => {
    const room = roomManager.findRoomByPlayer(socket.id);
    if (!room) return;

    if (room.hostId !== socket.id) {
      socket.emit('errorMessage', { message: '방장만 게임을 시작할 수 있습니다.' });
      return;
    }
    if (!room.canStart()) {
      socket.emit('errorMessage', { message: `최소 ${MIN_PLAYERS}명이 모여야 게임을 시작할 수 있습니다.` });
      return;
    }

    room.lobbyState = 'game_ready';
    broadcastRoomUpdate(room);
  });

  // ---------- 2-2. 카드 나눠갖기 (방장 전용, 2단계: 게임 시작) ----------
  socket.on('dealCards', () => {
    const room = roomManager.findRoomByPlayer(socket.id);
    if (!room) return;

    if (room.hostId !== socket.id) {
      socket.emit('errorMessage', { message: '방장만 카드를 나눠줄 수 있습니다.' });
      return;
    }
    if (room.lobbyState !== 'game_ready') {
      socket.emit('errorMessage', { message: '게임이 준비되지 않았습니다.' });
      return;
    }
    if (!room.hasEnoughCardsToStart()) {
      socket.emit('errorMessage', { message: '카드 이미지가 부족하여 게임을 시작할 수 없습니다.' });
      return;
    }

    // ---------- 3. 카드 분배 ----------
    room.startGame();
    io.to(room.code).emit('gameStarted');
    startCluePhase(room);
  });

  // ---------- 4. 출제자 턴: 제시어 + 카드 제출 ----------
  socket.on('submitClue', ({ cardId, clue } = {}) => {
    const room = roomManager.findRoomByPlayer(socket.id);
    if (!room || room.state !== 'clue') return;

    if (room.prompterId !== socket.id) {
      socket.emit('errorMessage', { message: '출제자만 제시어를 낼 수 있습니다.' });
      return;
    }
    if (!clue || !clue.trim()) {
      socket.emit('errorMessage', { message: '제시어를 입력해주세요.' });
      return;
    }
    if (!room.playCard(socket.id, cardId)) {
      socket.emit('errorMessage', { message: '보유하지 않은 카드입니다.' });
      return;
    }

    room.submitClue(clue.trim());
    io.to(room.code).emit('submitPhase', {
      clue: room.currentClue,
      prompterId: room.prompterId,
    });
    sendHandsToRoom(room);
    broadcastRoomUpdate(room);
  });

  // ---------- 5. 나머지 플레이어 카드 제출(비공개) ----------
  socket.on('submitCard', ({ cardId } = {}) => {
    const room = roomManager.findRoomByPlayer(socket.id);
    if (!room || room.state !== 'submit') return;

    if (socket.id === room.prompterId) {
      socket.emit('errorMessage', { message: '출제자는 카드를 제출하지 않습니다.' });
      return;
    }
    if (room.roundCards.has(socket.id)) {
      socket.emit('errorMessage', { message: '이미 카드를 제출했습니다.' });
      return;
    }
    if (!room.playCard(socket.id, cardId)) {
      socket.emit('errorMessage', { message: '보유하지 않은 카드입니다.' });
      return;
    }

    socket.emit('yourHand', { hand: room.players.get(socket.id).hand });
    io.to(room.code).emit('submitProgress', {
      submittedCount: room.roundCards.size,
      totalNeeded: room.turnOrder.length - 1,
    });

    if (room.allNonPrompterSubmitted()) {
      room.state = 'vote';
      const cards = shuffleForVote(room);
      io.to(room.code).emit('votePhase', { cards });
    }
  });

  // ---------- 6. 투표 ----------
  socket.on('submitVote', ({ cardId } = {}) => {
    const room = roomManager.findRoomByPlayer(socket.id);
    if (!room || room.state !== 'vote') return;

    if (socket.id === room.prompterId) {
      socket.emit('errorMessage', { message: '출제자는 투표할 수 없습니다.' });
      return;
    }
    if (room.votes.has(socket.id)) {
      socket.emit('errorMessage', { message: '이미 투표했습니다.' });
      return;
    }

    const ownerId = room.findCardOwner(cardId);
    if (!ownerId) {
      socket.emit('errorMessage', { message: '유효하지 않은 카드입니다.' });
      return;
    }
    if (ownerId === socket.id) {
      socket.emit('errorMessage', { message: '자신이 제출한 카드에는 투표할 수 없습니다.' });
      return;
    }

    room.castVote(socket.id, ownerId);
    io.to(room.code).emit('voteProgress', {
      votedCount: room.votes.size,
      totalNeeded: room.turnOrder.length - 1,
    });

    // ---------- 7. 점수 계산 ----------
    if (room.allNonPrompterVoted()) {
      revealRound(room);
    }
  });

  // ---------- 8. 턴 넘김 ----------
  socket.on('nextRound', () => {
    const room = roomManager.findRoomByPlayer(socket.id);
    if (!room || room.state !== 'reveal') return;

    if (room.hostId !== socket.id) {
      socket.emit('errorMessage', { message: '방장만 다음 라운드를 진행할 수 있습니다.' });
      return;
    }
    if (room.isGameOver()) return;

    if (!room.hasEnoughCardsForNextRound()) {
      room.state = 'ended';
      io.to(room.code).emit('gameOver', {
        players: room.getPublicPlayers(),
        reason: '남은 카드가 부족하여 게임을 종료합니다.',
      });
      return;
    }

    room.prepareNextRound();
    startCluePhase(room);
  });

  // ---------- 연결 종료 처리 ----------
  socket.on('disconnect', () => {
    const room = roomManager.findRoomByPlayer(socket.id);
    if (!room) return;

    room.removePlayer(socket.id);

    if (room.players.size === 0) {
      roomManager.deleteRoom(room.code);
      return;
    }

    if (room.state !== 'lobby' && room.state !== 'ended' && room.players.size < MIN_PLAYERS) {
      room.state = 'ended';
      io.to(room.code).emit('gameOver', {
        players: room.getPublicPlayers(),
        reason: '인원이 부족하여 게임을 종료합니다.',
      });
      return;
    }

    broadcastRoomUpdate(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] Dixit 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
