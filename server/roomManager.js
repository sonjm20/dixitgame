const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const MAX_ROOMS = 20;
const HAND_SIZE = 6;
const WIN_SCORE = 30;

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateRoomCode(existingCodes) {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000)); // 4자리 숫자 코드
  } while (existingCodes.has(code));
  return code;
}

class Room {
  constructor(code, hostId, imagePool) {
    this.code = code;
    this.hostId = hostId;
    this.players = new Map(); // socketId -> { id, nickname, score, hand: [] }
    this.imagePool = imagePool; // 서버 전체 카드 이미지 목록(참조 공유, 방마다 별도 셔플)

    this.state = 'lobby'; // lobby | clue | submit | vote | reveal | ended
    this.lobbyState = 'waiting'; // waiting | game_ready
    this.deck = [];
    this.discard = [];
    this.turnOrder = []; // 출제자 순서 (플레이어 socketId 배열)
    this.currentPrompterIndex = 0;
    this.currentClue = '';
    this.roundCards = new Map(); // socketId -> cardUrl (이번 라운드 제출 카드, 출제자 포함)
    this.votes = new Map(); // voterSocketId -> ownerSocketId (누구 카드에 투표했는지)
  }

  get prompterId() {
    return this.turnOrder[this.currentPrompterIndex];
  }

  addPlayer(id, nickname) {
    this.players.set(id, { id, nickname, score: 0, hand: [] });
  }

  removePlayer(id) {
    this.players.delete(id);
    this.turnOrder = this.turnOrder.filter((pid) => pid !== id);
    this.roundCards.delete(id);
    this.votes.delete(id);

    if (this.hostId === id) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
  }

  isFull() {
    return this.players.size >= MAX_PLAYERS;
  }

  canStart() {
    return this.state === 'lobby' && this.players.size >= MIN_PLAYERS;
  }

  hasEnoughCardsToStart() {
    return this.imagePool.length >= this.players.size * HAND_SIZE;
  }

  startGame() {
    this.deck = shuffle(this.imagePool);
    this.turnOrder = Array.from(this.players.keys());
    this.currentPrompterIndex = 0;

    for (const player of this.players.values()) {
      player.score = 0;
      player.hand = this.deck.splice(0, HAND_SIZE);
    }

    this.state = 'clue';
  }

  submitClue(clue) {
    this.currentClue = clue;
    this.state = 'submit';
  }

  // 자신의 패에서 카드를 제거하고 이번 라운드 제출 카드로 등록한다.
  playCard(playerId, cardUrl) {
    const player = this.players.get(playerId);
    if (!player) return false;
    const idx = player.hand.indexOf(cardUrl);
    if (idx === -1) return false;
    player.hand.splice(idx, 1);
    this.roundCards.set(playerId, cardUrl);
    return true;
  }

  nonPrompterIds() {
    return this.turnOrder.filter((id) => id !== this.prompterId);
  }

  allNonPrompterSubmitted() {
    return this.nonPrompterIds().every((id) => this.roundCards.has(id));
  }

  allNonPrompterVoted() {
    return this.nonPrompterIds().every((id) => this.votes.has(id));
  }

  castVote(voterId, ownerId) {
    this.votes.set(voterId, ownerId);
  }

  findCardOwner(cardUrl) {
    for (const [playerId, url] of this.roundCards.entries()) {
      if (url === cardUrl) return playerId;
    }
    return null;
  }

  // 딕싯 점수 계산 규칙 적용, 결과 객체 반환
  calculateScores() {
    const { prompterId } = this;
    const nonPrompterIds = this.nonPrompterIds();
    const correctVoters = nonPrompterIds.filter((id) => this.votes.get(id) === prompterId);

    const roundScores = {};
    for (const id of this.turnOrder) roundScores[id] = 0;

    const allCorrect = correctVoters.length === nonPrompterIds.length;
    const allWrong = correctVoters.length === 0;

    if (allCorrect || allWrong) {
      // 전원 정답 또는 전원 오답: 출제자 0점, 나머지 전원 2점
      for (const id of nonPrompterIds) roundScores[id] += 2;
    } else {
      // 그 외: 출제자와 정답자 각 3점
      roundScores[prompterId] += 3;
      for (const id of correctVoters) roundScores[id] += 3;
    }

    // 보너스: 자신의 가짜 카드에 투표한 사람 수만큼 1점씩 추가
    for (const [, ownerId] of this.votes.entries()) {
      if (ownerId !== prompterId) {
        roundScores[ownerId] = (roundScores[ownerId] || 0) + 1;
      }
    }

    for (const [id, points] of Object.entries(roundScores)) {
      const player = this.players.get(id);
      if (player) player.score += points;
    }

    return { roundScores, correctVoters, prompterId };
  }

  hasEnoughCardsForNextRound() {
    return this.deck.length >= this.turnOrder.length;
  }

  // 사용한 카드 버리고 1장씩 보충, 다음 사람에게 출제자 턴 넘김
  prepareNextRound() {
    for (const [playerId, cardUrl] of this.roundCards.entries()) {
      this.discard.push(cardUrl);
      const player = this.players.get(playerId);
      if (player && this.deck.length > 0) {
        player.hand.push(this.deck.shift());
      }
    }

    this.roundCards.clear();
    this.votes.clear();
    this.currentClue = '';
    this.currentPrompterIndex = (this.currentPrompterIndex + 1) % this.turnOrder.length;
    this.state = 'clue';
  }

  isGameOver() {
    for (const player of this.players.values()) {
      if (player.score >= WIN_SCORE) return true;
    }
    return false;
  }

  getPublicPlayers() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      score: p.score,
      handCount: p.hand.length,
    }));
  }
}

class RoomManager {
  constructor(imagePool) {
    this.rooms = new Map(); // code -> Room
    this.imagePool = imagePool;
  }

  createRoom(hostId) {
    if (this.rooms.size >= MAX_ROOMS) {
      const err = new Error('ROOM_LIMIT_REACHED');
      throw err;
    }
    const code = generateRoomCode(new Set(this.rooms.keys()));
    const room = new Room(code, hostId, this.imagePool);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code);
  }

  deleteRoom(code) {
    this.rooms.delete(code);
  }

  findRoomByPlayer(playerId) {
    for (const room of this.rooms.values()) {
      if (room.players.has(playerId)) return room;
    }
    return null;
  }
}

module.exports = {
  RoomManager,
  Room,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_ROOMS,
  HAND_SIZE,
  WIN_SCORE,
};
