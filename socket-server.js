
const { Server } = require("socket.io");
const http = require("http");
const url = require("url");
const { generateWcaScramble, generate2x2Scramble, generate3x3Scramble, generate4x4Scramble, generatePyraminxScramble } = require("./scramble.js");

const rooms = {}; // Quản lý người chơi trong từng room
const scrambles = {}; // Quản lý scramble cho từng room
const roomsMeta = {}; // Quản lý meta phòng: event, displayName, password
const roomHosts = {}; // Lưu userId chủ phòng cho từng room
const roomTurns = {}; // Lưu userId người được quyền giải (turn) cho từng room
const roomTurnSequences = {}; // Lưu trật tự luân phiên của từng phòng (2vs2)
const roomTurnIndices = {}; // Lưu vị trí hiện tại trong chu kỳ lượt chơi (2vs2)
const roomTurnSequencesNormalized = {}; // Lưu userId đã normalize cho việc so khớp lượt
// Đã loại bỏ logic người xem (spectator)

// Quản lý phòng chờ 2vs2
const waitingRooms = {}; // { roomId: { players: [], roomCreator: '', gameStarted: false } }

const INSUFFICIENT_COUNTDOWN_MS = 5 * 60 * 1000;

function ensureInsufficientTimeouts() {
  if (!global.insufficientRoomTimeouts) {
    global.insufficientRoomTimeouts = {};
  }
  return global.insufficientRoomTimeouts;
}

function clearInsufficientTimeout(room) {
  const timeouts = ensureInsufficientTimeouts();
  if (timeouts[room]) {
    clearTimeout(timeouts[room]);
    delete timeouts[room];
  }
}

function isObserverUser(user) {
  if (!user) return false;
  return !!(user.isObserver || user.role === 'observer');
}

// Hàm sắp xếp lại chỗ ngồi thông minh
function reorganizeSeating(room) {

  
  const players = room.players;
  const totalPlayers = players.length;
  
  // Reset tất cả positions và teams
  players.forEach(player => {
    if (player.role !== 'observer') {
      player.team = null;
      player.position = null;
    }
  });
  
  // Sắp xếp lại theo thứ tự ưu tiên
  if (totalPlayers === 1) {
    // Chỉ có 1 người = chủ phòng
    const player = players[0];
    player.role = 'creator';
    player.team = 'team1';
    player.position = 1;
    player.isReady = true; // Chủ phòng luôn sẵn sàng

  } else if (totalPlayers === 2) {
    // 2 người = chủ phòng + 1 người chơi
    const [creator, player] = players;
    creator.role = 'creator';
    creator.team = 'team1';
    creator.position = 1;
    creator.isReady = true; // Chủ phòng luôn sẵn sàng
    
    player.role = 'player';
    player.team = 'team1';
    player.position = 2;

  } else if (totalPlayers === 3) {
    // 3 người = chủ phòng + 2 người chơi
    const [creator, player1, player2] = players;
    creator.role = 'creator';
    creator.team = 'team1';
    creator.position = 1;
    creator.isReady = true; // Chủ phòng luôn sẵn sàng
    
    player1.role = 'player';
    player1.team = 'team1';
    player1.position = 2;
    
    player2.role = 'player';
    player2.team = 'team2';
    player2.position = 1;
    console.log('Three players - creator + player1 in team1, player2 in team2');
  } else if (totalPlayers === 4) {
    // 4 người = chủ phòng + 3 người chơi
    const [creator, player1, player2, player3] = players;
    creator.role = 'creator';
    creator.team = 'team1';
    creator.position = 1;
    creator.isReady = true; // Chủ phòng luôn sẵn sàng
    
    player1.role = 'player';
    player1.team = 'team1';
    player1.position = 2;
    
    player2.role = 'player';
    player2.team = 'team2';
    player2.position = 1;
    
    player3.role = 'player';
    player3.team = 'team2';
    player3.position = 2;
    console.log('Four players - full teams');
  } else {
    // 5+ người = chủ phòng + 3 người chơi + observers
    const [creator, player1, player2, player3, ...observers] = players;
    
    creator.role = 'creator';
    creator.team = 'team1';
    creator.position = 1;
    creator.isReady = true; // Chủ phòng luôn sẵn sàng
    
    player1.role = 'player';
    player1.team = 'team1';
    player1.position = 2;
    
    player2.role = 'player';
    player2.team = 'team2';
    player2.position = 1;
    
    player3.role = 'player';
    player3.team = 'team2';
    player3.position = 2;
    
    // Tất cả người còn lại là observers
    observers.forEach(observer => {
      observer.role = 'observer';
      observer.team = null;
      observer.position = null;
      observer.isObserver = true;
    });
    console.log(`Five+ players - full teams + ${observers.length} observers`);
  }
  

}

const normalizeId = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

function buildTurnOrderFromPlayers(players) {
  const team1 = players
    .filter(player => player.team === 'team1')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const team2 = players
    .filter(player => player.team === 'team2')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  if (team1.length > 0 || team2.length > 0) {
    return [...team1, ...team2].map(player => player.userId);
  }

  return [...players]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map(player => player.userId);
}

function setTurnSequenceForRoom(roomId, players, preferredCurrentId) {
  const activePlayers = players.filter(player => player && !player.isObserver);
  if (activePlayers.length === 0) {
    delete roomTurnSequences[roomId];
    delete roomTurnSequencesNormalized[roomId];
    delete roomTurnIndices[roomId];
    if (roomsMeta[roomId]) {
      delete roomsMeta[roomId].playerOrder;
    }
    delete roomTurns[roomId];
    return [];
  }

  let order = buildTurnOrderFromPlayers(activePlayers);
  if (!order.length) {
    order = activePlayers.map(player => player.userId);
  }

  roomTurnSequences[roomId] = order;
  roomTurnSequencesNormalized[roomId] = order.map(normalizeId);
  roomsMeta[roomId] = roomsMeta[roomId] || {};
  roomsMeta[roomId].playerOrder = order;

  const normalizedPreferred = normalizeId(preferredCurrentId);
  let initialIndex = normalizedPreferred ? roomTurnSequencesNormalized[roomId].indexOf(normalizedPreferred) : -1;
  if (initialIndex === -1) {
    const existingIndex = typeof roomTurnIndices[roomId] === 'number' ? roomTurnIndices[roomId] : 0;
    initialIndex = existingIndex;
  }
  if (initialIndex < 0 || initialIndex >= order.length) {
    initialIndex = 0;
  }

  roomTurnIndices[roomId] = initialIndex;
  roomTurns[roomId] = order[initialIndex];
  return order;
}

// Đặt timeout xóa phòng nếu không đủ người trong 5 phút
function setupRoomTimeout(room) {
  if (!room || !roomsMeta[room]) return;
  
  // Xác định loại phòng và số người tối thiểu
  const gameMode = roomsMeta[room]?.gameMode || "1vs1";
  const is2vs2Room = gameMode === "2vs2";
  const minPlayers = is2vs2Room ? 4 : 2;
  
  // Xóa timeout cũ nếu có
  if (global.roomTimeouts && global.roomTimeouts[room]) {
    clearTimeout(global.roomTimeouts[room]);
  }
  
  // Đặt timeout mới (5 phút = 300000ms)
  global.roomTimeouts[room] = setTimeout(() => {
    if (rooms[room] && rooms[room].length < minPlayers) {
      const roomType = gameMode;
      console.log(`Room ${room} (${roomType}) deleted due to insufficient players (<${minPlayers}) after 5 minutes`);
      
      // Thông báo cho tất cả users trong phòng
      io.to(room).emit("room-deleted", { 
        message: `Phòng đã bị xóa do không đủ người chơi sau 5 phút` 
      });
      
      // Xóa phòng
      delete rooms[room];
      delete scrambles[room];
      if (io.sockets && io.sockets.server && io.sockets.server.solveCount) delete io.sockets.server.solveCount[room];
      delete roomHosts[room];
      delete roomTurns[room];
      delete roomsMeta[room];
      delete global.roomTimeouts[room];
      io.emit("update-active-rooms");
    }
  }, 300000); // 5 phút
}

function deleteRoomFully(room, reason = "cleanup") {
  if (rooms[room]) {
    io.to(room).emit("room-users", { users: [], hostId: null });
    io.to(room).emit("room-turn", { turnUserId: null });
    io.to(room).emit("room-reset");
  }

  if (rooms[room]) delete rooms[room];
  if (scrambles[room]) delete scrambles[room];
  if (io.sockets && io.sockets.server && io.sockets.server.solveCount) delete io.sockets.server.solveCount[room];

  if (global.roomTimeouts && global.roomTimeouts[room]) {
    clearTimeout(global.roomTimeouts[room]);
    delete global.roomTimeouts[room];
  }

  clearInsufficientTimeout(room);

  if (roomHosts[room]) delete roomHosts[room];
  if (roomTurns[room]) delete roomTurns[room];
  if (roomTurnSequences[room]) delete roomTurnSequences[room];
  if (roomTurnSequencesNormalized[room]) delete roomTurnSequencesNormalized[room];
  if (roomTurnIndices[room]) delete roomTurnIndices[room];
  if (roomsMeta[room]) {
    if (roomsMeta[room].insufficientDeadline) {
      delete roomsMeta[room].insufficientDeadline;
    }
    delete roomsMeta[room];
  }

  io.emit("update-active-rooms");
  console.log(`Room ${room} deleted from rooms object (${reason}).`);
}

function scheduleInsufficientCountdown(room, deadline) {
  const timeouts = ensureInsufficientTimeouts();
  const now = Date.now();
  const remaining = Math.max(deadline - now, 0);

  if (timeouts[room]) {
    clearTimeout(timeouts[room]);
  }

  if (remaining === 0) {
    io.to(room).emit("room-force-close", { reason: "timeout", roomId: room });
    deleteRoomFully(room, "2vs2-timeout");
    return;
  }

  timeouts[room] = setTimeout(() => {
    const currentUsers = rooms[room];
    if (!currentUsers) return;
    const activeCount = currentUsers.filter(u => u && !isObserverUser(u)).length;
    if (activeCount === 0 || activeCount < 4) {
      io.to(room).emit("room-force-close", { reason: activeCount === 0 ? "empty" : "timeout", roomId: room });
      deleteRoomFully(room, activeCount === 0 ? "2vs2-empty-during-timeout" : "2vs2-timeout");
    } else {
      clearInsufficientTimeout(room);
      if (roomsMeta[room]) {
        delete roomsMeta[room].insufficientDeadline;
      }
    }
  }, remaining);
}

// Xóa user khỏi phòng và dọn dẹp nếu phòng trống
function removeUserAndCleanup(room, userId) {
  if (!room || !rooms[room]) return;

  const normalizedUserId = typeof userId === "string" ? userId : undefined;

  rooms[room] = rooms[room]
    .filter(u => u && u.userId && u.userId !== normalizedUserId);

  const currentUsers = rooms[room];

  if (!currentUsers) return;

  if (roomHosts[room] === normalizedUserId) {
    if (currentUsers.length > 0) {
      roomHosts[room] = currentUsers[0].userId;
    } else {
      delete roomHosts[room];
    }
  }

  if (roomTurns[room] === normalizedUserId) {
    if (currentUsers.length > 0) {
      roomTurns[room] = currentUsers[0].userId;
    } else {
      delete roomTurns[room];
    }
  }

  io.to(room).emit("room-users", { users: currentUsers, hostId: roomHosts[room] || null });

  const filteredUsers = currentUsers.filter(Boolean);
  const gameMode = roomsMeta[room]?.gameMode || "1vs1";
  const is2vs2Room = gameMode === "2vs2";
  const activePlayers = filteredUsers.filter(u => !isObserverUser(u));
  const activeCount = is2vs2Room ? activePlayers.length : filteredUsers.length;

  if (is2vs2Room) {
    handle2vs2Cleanup(room, activeCount, normalizedUserId);
    return;
  }

  io.to(room).emit("room-turn", { turnUserId: roomTurns[room] || null });

  if (filteredUsers.length === 0) {
    deleteRoomFully(room, "empty");
    return;
  }

  if (filteredUsers.length === 1) {
    if (io.sockets && io.sockets.server && io.sockets.server.solveCount) io.sockets.server.solveCount[room] = 0;
    const eventType = roomsMeta[room]?.event || "3x3";
    scrambles[room] = generateLocalScrambles(eventType);
    if (scrambles[room] && scrambles[room].length > 0) {
      io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
    }
    io.to(room).emit("room-reset");
    if (rooms[room].length === 1) {
      roomTurns[room] = roomHosts[room];
      io.to(room).emit("room-turn", { turnUserId: roomTurns[room] });
    }
    if (!global.roomTimeouts) global.roomTimeouts = {};
    if (global.roomTimeouts[room]) {
      clearTimeout(global.roomTimeouts[room]);
    }
    global.roomTimeouts[room] = setTimeout(() => {
      if (rooms[room] && rooms[room].length === 1) {
        deleteRoomFully(room, "1vs1-timeout");
      }
    }, 5 * 60 * 1000);
    io.emit("update-active-rooms");
    return;
  }

  if (global.roomTimeouts && global.roomTimeouts[room]) {
    clearTimeout(global.roomTimeouts[room]);
    delete global.roomTimeouts[room];
  }
  io.emit("update-active-rooms");
}

function handle2vs2Cleanup(room, activeCount, removedUserId) {
  const requiredPlayers = 4;
  const now = Date.now();
  if (!roomsMeta[room]) roomsMeta[room] = {};

  const playersSnapshot = Array.isArray(rooms[room]) ? rooms[room] : [];
  setTurnSequenceForRoom(room, playersSnapshot, roomTurns[room]);
  io.to(room).emit("room-turn", { turnUserId: roomTurns[room] || null });

  if (activeCount === 0) {
    io.to(room).emit("room-force-close", { reason: "empty", roomId: room });
    deleteRoomFully(room, "2vs2-empty");
    return;
  }

  if (activeCount < requiredPlayers) {
    const triggeredByRemoval = typeof removedUserId === "string" && removedUserId.length > 0;
    let deadline = roomsMeta[room].insufficientDeadline;
    if (!deadline || triggeredByRemoval) {
      deadline = now + INSUFFICIENT_COUNTDOWN_MS;
      roomsMeta[room].insufficientDeadline = deadline;
    }

    scheduleInsufficientCountdown(room, deadline);

    io.to(room).emit("room-insufficient-players", {
      roomId: room,
      remainingPlayers: activeCount,
      requiredPlayers,
      deadline
    });
    io.emit("update-active-rooms");
    return;
  }

  if (roomsMeta[room].insufficientDeadline) {
    delete roomsMeta[room].insufficientDeadline;
    clearInsufficientTimeout(room);
    io.to(room).emit("room-players-restored", { roomId: room });
  }
  io.emit("update-active-rooms");
}

function generateLocalScrambles(event = "3x3") {
  const localScrambles = [];
  for (let i = 0; i < 5; i++) {
    if (event === "2x2") {
      localScrambles.push(generate2x2Scramble());
    } else if (event === "4x4") {
      localScrambles.push(generate4x4Scramble());
    } else if (event === "pyraminx") {
      localScrambles.push(generatePyraminxScramble());
    } else {
      localScrambles.push(generate3x3Scramble());
    }
  }
  // console.log(`✅ Generated 5 local scrambles for ${event}`); // Ẩn log chi tiết scramble
  return localScrambles;
}



// Tạo HTTP server để phục vụ REST API và Socket.io
const allowedOrigins = [
  "https://rubik-app-buhb.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001"
];
const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const parsed = url.parse(req.url, true);
  // REST endpoint: /room-users/:roomId
  if (parsed.pathname && parsed.pathname.startsWith("/room-users/")) {
    const roomId = parsed.pathname.split("/room-users/")[1]?.toUpperCase();
    if (roomId && rooms[roomId]) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rooms[roomId]));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
    }
    return;
  }
  // REST endpoint: /create-waiting-room
  if (parsed.pathname === "/create-waiting-room") {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const { roomId, gameMode, event, displayName, password } = JSON.parse(body);
 
        
        // Tạo waiting room nếu chưa tồn tại
        if (!waitingRooms[roomId]) {
          waitingRooms[roomId] = {
            roomId,
            players: [],
            roomCreator: null, // Sẽ được set khi user đầu tiên join
            gameStarted: false,
            displayName: displayName || roomId, // Lưu tên phòng
            password: password || null // Lưu mật khẩu
          };

          
          // Emit update-active-rooms để thông báo cho tất cả client
          io.emit("update-active-rooms");

        }
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, roomId }));
      } catch (error) {
        console.error('Error creating waiting room:', error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 'Failed to create waiting room' }));
      }
    });
    return;
  }

  // REST endpoint: /active-rooms
  if (parsed.pathname === "/active-rooms") {
    res.writeHead(200, { "Content-Type": "application/json" });
    // Trả về danh sách phòng kèm meta và số lượng user
    const result = Object.keys(rooms).map(roomId => ({
      roomId,
      meta: {
        ...roomsMeta[roomId],
        displayName: roomsMeta[roomId]?.displayName || roomId // Đảm bảo luôn có displayName
      },
      usersCount: Array.isArray(rooms[roomId]) ? rooms[roomId].length : 0
    }));
    
    // Thêm waiting rooms 2vs2
    const waitingRoomResults = Object.keys(waitingRooms).map(roomId => ({
      roomId,
      meta: { 
        gameMode: '2vs2',
        event: '3x3', // default event
        displayName: waitingRooms[roomId].displayName || roomId,
        password: waitingRooms[roomId].password || null,
        isWaitingRoom: true
      },
      usersCount: waitingRooms[roomId].players.length,
      isWaitingRoom: true
    }));
    
    // Gộp cả 2 loại phòng
    const allRooms = [...result, ...waitingRoomResults];
    res.end(JSON.stringify(allRooms));
    return;
  }

  // REST endpoint: /room-meta/:roomId
  if (parsed.pathname && parsed.pathname.startsWith("/room-meta/")) {
    const roomId = parsed.pathname.split("/room-meta/")[1]?.toUpperCase();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(roomsMeta[roomId] || {}));
    return;
  }
  // Đã loại bỏ endpoint /room-spectators vì không còn logic spectator
  // Default: 404
  res.writeHead(404);
  res.end();
});

const io = new Server(server, {
  cors: {
    origin: "*", // Cho phép mọi domain kết nối (dễ test)
  },
});

const PORT = process.env.PORT || 3001;
server.listen(3001, '0.0.0.0', () => {
  console.log(`🚀 Socket.io + REST server running on port 3001`);
});

io.on("connection", (socket) => {
  // Relay timer-prep event to other users in the room
  socket.on("timer-prep", (data) => {
    if (!data || !data.roomId) return;
    const room = data.roomId.toUpperCase();
    socket.to(room).emit("timer-prep", data);
  });

  // NEW: Separate 2vs2 timer-prep event handling
  socket.on("timer-prep-2vs2", (data) => {
    if (!data || !data.roomId) return;
    const room = data.roomId.toUpperCase();
    const gameMode = roomsMeta[room]?.gameMode || "1vs1";
    
    // Only handle 2vs2 timer-prep for 2vs2 rooms
    if (gameMode === "2vs2") {
      // Validate that the user has the turn
      const currentUserId = data.userId;
      const currentTurn = roomTurns[room];
      if (currentUserId && currentTurn && currentUserId === currentTurn) {
        socket.to(room).emit("timer-prep-2vs2", data);
      }
    }
  });

  // Quản lý interval gửi timer-update liên tục cho từng phòng
  if (!global.timerIntervals) global.timerIntervals = {};
  const timerIntervals = global.timerIntervals;

  // Khi nhận timer-update từ client, server sẽ phát tán liên tục cho các client khác trong phòng
  socket.on("timer-update", (data) => {
    if (!data || !data.roomId) return;
    const room = data.roomId.toUpperCase();
    const gameMode = roomsMeta[room]?.gameMode || "1vs1";
    
    // For 1vs1 rooms, use existing logic
    if (gameMode === "1vs1") {
      // Lưu trạng thái timer hiện tại cho phòng
      if (!global.roomTimers) global.roomTimers = {};
      global.roomTimers[room] = {
        ms: data.ms,
        running: data.running,
        finished: data.finished,
        userId: data.userId,
        lastUpdate: Date.now()
      };
      // Nếu đang giải, bắt đầu interval gửi timer-update liên tục
      if (data.running) {
        if (timerIntervals[room]) clearInterval(timerIntervals[room]);
        timerIntervals[room] = setInterval(() => {
          const timerState = global.roomTimers[room];
          if (!timerState || !timerState.running) {
            clearInterval(timerIntervals[room]);
            delete timerIntervals[room];
            return;
          }
          // Tính toán ms mới dựa trên thời gian thực tế
          const now = Date.now();
          const elapsed = now - timerState.lastUpdate;
          const updatedMs = timerState.ms + elapsed;
          timerState.ms = updatedMs;
          timerState.lastUpdate = now;
          io.to(room).emit("timer-update", {
            roomId: room,
            userId: timerState.userId,
            ms: updatedMs,
            running: true,
            finished: false
          });
        }, 50); // gửi mỗi 50ms
      } else {
        // Khi dừng giải, gửi timer-update cuối cùng và dừng interval
        if (timerIntervals[room]) {
          clearInterval(timerIntervals[room]);
          delete timerIntervals[room];
        }
        io.to(room).emit("timer-update", {
          roomId: room,
          userId: data.userId,
          ms: data.ms,
          running: false,
          finished: data.finished
        });
      }
    }
  });

  // NEW: Separate 2vs2 timer-update handling
  socket.on("timer-update-2vs2", (data) => {
    if (!data || !data.roomId) return;
    const room = data.roomId.toUpperCase();
    const gameMode = roomsMeta[room]?.gameMode || "1vs1";
    
    // Only handle 2vs2 timer-update for 2vs2 rooms
    if (gameMode === "2vs2") {
      // Validate that the user has the turn
      const currentUserId = data.userId;
      const currentTurn = roomTurns[room];
      if (!currentUserId || !currentTurn || currentUserId !== currentTurn) {
        return; // Invalid turn, ignore
      }
      
      // Lưu trạng thái timer hiện tại cho phòng 2vs2
      if (!global.roomTimers2vs2) global.roomTimers2vs2 = {};
      global.roomTimers2vs2[room] = {
        ms: data.ms,
        running: data.running,
        finished: data.finished,
        userId: data.userId,
        lastUpdate: Date.now()
      };
      
      // Nếu đang giải, bắt đầu interval gửi timer-update liên tục
      if (data.running) {
        if (!global.timerIntervals2vs2) global.timerIntervals2vs2 = {};
        const timerIntervals2vs2 = global.timerIntervals2vs2;
        
        if (timerIntervals2vs2[room]) clearInterval(timerIntervals2vs2[room]);
        timerIntervals2vs2[room] = setInterval(() => {
          const timerState = global.roomTimers2vs2[room];
          if (!timerState || !timerState.running) {
            clearInterval(timerIntervals2vs2[room]);
            delete timerIntervals2vs2[room];
            return;
          }
          // Tính toán ms mới dựa trên thời gian thực tế
          const now = Date.now();
          const elapsed = now - timerState.lastUpdate;
          const updatedMs = timerState.ms + elapsed;
          timerState.ms = updatedMs;
          timerState.lastUpdate = now;
          io.to(room).emit("timer-update-2vs2", {
            roomId: room,
            userId: timerState.userId,
            ms: updatedMs,
            running: true,
            finished: false
          });
        }, 50); // gửi mỗi 50ms
      } else {
        // Khi dừng giải, gửi timer-update cuối cùng và dừng interval
        if (global.timerIntervals2vs2 && global.timerIntervals2vs2[room]) {
          clearInterval(global.timerIntervals2vs2[room]);
          delete global.timerIntervals2vs2[room];
        }
        io.to(room).emit("timer-update-2vs2", {
          roomId: room,
          userId: data.userId,
          ms: data.ms,
          running: false,
          finished: data.finished
        });
      }
    }
  });
  console.log("🔌 Client connected");


  // Map lưu timeout tự hủy phòng nếu chỉ có 1 người (chủ phòng) sau 5 phút
  if (!global.roomTimeouts) global.roomTimeouts = {};
  const roomTimeouts = global.roomTimeouts;

  // Xử lý rời phòng chủ động từ client
  socket.on("leave-room", ({ roomId, userId }) => {
    removeUserAndCleanup(roomId?.toUpperCase(), userId);
  });

socket.on("join-room", ({ roomId, userId, userName, isSpectator = false, event, displayName, password, gameMode }) => {
    const room = roomId.toUpperCase();
    if (!userName || typeof userName !== "string" || !userName.trim() || !userId || typeof userId !== "string" || !userId.trim()) {
      return;
    }
    socket.join(room);
    socket.data = socket.data || {};
    socket.data.room = room;
    socket.data.userName = userName;
    socket.data.userId = userId;
  socket.userId = userId;

    if (!rooms[room]) rooms[room] = [];
    let isNewRoom = false;
    if (rooms[room] && rooms[room].length === 0) {
      roomsMeta[room] = {
        event: event || "3x3",
        displayName: displayName || room,
        password: password || "",
        gameMode: gameMode || "1vs1"
      };
      isNewRoom = true;
      // Gán host là userId đầu tiên
      roomHosts[room] = userId;
      // Gán lượt chơi ban đầu là host
      roomTurns[room] = userId;
    } else {
      // Cập nhật roomsMeta với displayName nếu có (cho phòng đã tồn tại)
      if (displayName && displayName !== room) {
        if (!roomsMeta[room]) {
          roomsMeta[room] = {};
        }
        roomsMeta[room].displayName = displayName;
      }
      
      const roomPassword = roomsMeta[room]?.password || "";
      if (roomPassword && password !== roomPassword) {
        socket.emit("wrong-password", { message: "Sai mật khẩu phòng!" });
        return;
      }
    }
    
    // Check if room is full based on game mode
    const maxPlayers = gameMode === '2vs2' ? 4 : 2;
    if (rooms[room] && rooms[room].length > maxPlayers) {
      socket.emit("room-full", { message: `Phòng đã đủ ${maxPlayers} người chơi` });
      return;
    }

    const existingUser = rooms[room].find(u => u.userId === userId);
    if (existingUser) {
      existingUser.userName = userName;
      if (roomsMeta[room]?.playerMap && roomsMeta[room].playerMap[userId]) {
        Object.assign(existingUser, roomsMeta[room].playerMap[userId]);
      }
    } else {
      const baseUser = { userId, userName };
      if (roomsMeta[room]?.playerMap && roomsMeta[room].playerMap[userId]) {
        rooms[room].push({ ...baseUser, ...roomsMeta[room].playerMap[userId] });
      } else {
        rooms[room].push(baseUser);
      }
    }

    // Kiểm tra và dọn dẹp phòng nếu trống (sau khi join/leave)
    removeUserAndCleanup(room, undefined); // undefined để không xóa ai, chỉ kiểm tra phòng trống
    
    // Đặt timeout xóa phòng nếu không đủ người trong 5 phút
    setupRoomTimeout(room);

    // Broadcast danh sách user, host và turn
    io.to(room).emit("room-users", { users: rooms[room], hostId: roomHosts[room] });
    io.to(room).emit("room-turn", { turnUserId: roomTurns[room] });
    if (isNewRoom) {
      io.emit("update-active-rooms");
    }
    console.log("All rooms:", JSON.stringify(rooms));

    if (!scrambles[room]) {
      scrambles[room] = [];
      const eventType = roomsMeta[room]?.event || "3x3";
      const scrambleList = generateLocalScrambles(eventType);
      scrambles[room] = scrambleList;
      if (scrambles[room] && scrambles[room].length > 0) {
        io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
      }
    }
    if (scrambles[room] && scrambles[room].length > 0) {
      io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
    }

    if (rooms[room] && rooms[room].length === 1) {
      // Khi chỉ còn 1 người, luôn set turn về cho host
      roomTurns[room] = roomHosts[room];
      io.to(room).emit("room-turn", { turnUserId: roomTurns[room] });
      if (roomTimeouts[room]) {
        clearTimeout(roomTimeouts[room]);
      }
      roomTimeouts[room] = setTimeout(() => {
        if (rooms[room] && rooms[room].length === 1) {
          console.log(`⏰ Phòng ${room} chỉ có 1 người chơi sau 5 phút, tự động xóa.`);
          delete rooms[room];
          delete scrambles[room];
          if (socket.server.solveCount) delete socket.server.solveCount[room];
          delete roomTimeouts[room];
          delete roomHosts[room];
          delete roomsMeta[room]; // Xóa meta khi phòng trống
          io.to(room).emit("room-users", { users: [], hostId: null });
        }
      }, 5 * 60 * 1000);
      // console.log(`⏳ Đặt timeout tự hủy phòng ${room} sau 5 phút nếu không có ai vào thêm.`);
    } else {
      if (roomTimeouts[room]) {
        clearTimeout(roomTimeouts[room]);
        delete roomTimeouts[room];
        console.log(`❌ Hủy timeout tự hủy phòng ${room} vì đã có thêm người chơi.`);
      }
      if (rooms[room] && rooms[room].length === 2) {
        if (socket.server.solveCount) socket.server.solveCount[room] = 0;
        const eventType = roomsMeta[room]?.event || "3x3";
        scrambles[room] = generateLocalScrambles(eventType);
        io.to(room).emit("room-reset");
        if (scrambles[room] && scrambles[room].length > 0) {
          io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
        }
        // Khi đủ 2 người, set turn về cho host
        roomTurns[room] = roomHosts[room];
        io.to(room).emit("room-turn", { turnUserId: roomTurns[room] });
      }
    }
    socket.emit("room-joined");
  });

  // Chat event: relay chat message to all users in the room
  socket.on("chat", ({ roomId, userId, userName, message }) => {
    const room = roomId.toUpperCase();
    if (!room || !userId || !userName || !message) return;
    
    // Kiểm tra xem có phải waiting room không
    if (waitingRooms[room]) {
      // Gửi tin nhắn cho tất cả user khác trong waiting room (không gửi cho chính người gửi)
      socket.to(`waiting-${room}`).emit("chat", { userId, userName, message });
    } else {
      // Gửi tin nhắn cho tất cả user khác trong phòng thường (không gửi cho chính người gửi)
      socket.to(room).emit("chat", { userId, userName, message });
    }
  });

  socket.on("solve", ({ roomId, userId, userName, time }) => {
    const room = roomId.toUpperCase();
    const gameMode = roomsMeta[room]?.gameMode || "1vs1";
    if (!socket.server.solveCount) socket.server.solveCount = {};
    if (!socket.server.solveCount[room]) socket.server.solveCount[room] = 0;

    const normalizedTime = typeof time === "number" ? time : null;

    if (gameMode === "2vs2") {
      const roomPlayers = Array.isArray(rooms[room]) ? rooms[room] : [];
      const playerMeta = roomPlayers.find(p => p && p.userId === userId);

      io.to(room).emit("player-solve", {
        userId,
        userName,
        time: normalizedTime,
        team: playerMeta?.team || null,
        position: typeof playerMeta?.position === "number" ? playerMeta.position : null
      });

      socket.server.solveCount[room]++;

      const normalizedSolverId = normalizeId(userId);
      const playersInRoom = Array.isArray(roomPlayers) ? roomPlayers : [];
      let order = Array.isArray(roomTurnSequences[room]) ? roomTurnSequences[room] : [];
      let normalizedOrder = Array.isArray(roomTurnSequencesNormalized[room]) ? roomTurnSequencesNormalized[room] : [];

      if (!order.length || order.length !== normalizedOrder.length) {
        order = setTurnSequenceForRoom(room, playersInRoom, roomTurns[room]);
        normalizedOrder = Array.isArray(roomTurnSequencesNormalized[room]) ? roomTurnSequencesNormalized[room] : [];
      }

      if (!normalizedOrder.includes(normalizedSolverId)) {
        order = setTurnSequenceForRoom(room, playersInRoom, userId);
        normalizedOrder = Array.isArray(roomTurnSequencesNormalized[room]) ? roomTurnSequencesNormalized[room] : [];
      }

      const solvesPerRound = order.length > 0 ? order.length : 4;
      const totalSolves = socket.server.solveCount[room];
      if (solvesPerRound > 0 && totalSolves % solvesPerRound === 0) {
        const idx = totalSolves / solvesPerRound;
        if (scrambles[room] && scrambles[room][idx]) {
          io.to(room).emit("scramble", { scramble: scrambles[room][idx], index: idx });
        }
      }

      if (!order.length) {
        return;
      }

      let currentIndex = normalizedOrder.indexOf(normalizedSolverId);
      if (currentIndex === -1) {
        currentIndex = typeof roomTurnIndices[room] === "number" ? roomTurnIndices[room] : 0;
      }

      const nextIndex = (currentIndex + 1) % order.length;
      roomTurnIndices[room] = nextIndex;
      const nextTurnUserId = order[nextIndex];
      if (nextTurnUserId) {
        roomTurns[room] = nextTurnUserId;
        io.to(room).emit("room-turn", { turnUserId: nextTurnUserId });
      }

      return;
    }

    // 1vs1 logic
    socket.server.solveCount[room]++;
    socket.to(room).emit("opponent-solve", { userId, userName, time: normalizedTime });
    io.to(room).emit("player-solve", { userId, userName, time: normalizedTime, team: null, position: null });

    const totalSolves = socket.server.solveCount[room];
    if (totalSolves % 2 === 0) {
      const idx = totalSolves / 2;
      if (scrambles[room] && scrambles[room][idx]) {
        io.to(room).emit("scramble", { scramble: scrambles[room][idx], index: idx });
      }
    }

    if (rooms[room] && rooms[room].length === 2) {
      const userIds = rooms[room].map(u => u.userId);
      const nextTurn = userIds.find(id => id !== userId);
      if (nextTurn) {
        roomTurns[room] = nextTurn;
        io.to(room).emit("room-turn", { turnUserId: nextTurn });
      }
    }
  })
    // --- Rematch events ---
  socket.on("rematch-request", ({ roomId, fromUserId }) => {
    const room = roomId.toUpperCase();
    // Gửi yêu cầu tái đấu cho tất cả client khác trong phòng
    socket.to(room).emit("rematch-request", { fromUserId });
  });

socket.on("rematch-accepted", ({ roomId }) => {
  const room = roomId.toUpperCase();
  // Sinh lại 5 scramble mới cho phòng này đúng thể loại
  const eventType = roomsMeta[room]?.event || "3x3";
  scrambles[room] = generateLocalScrambles(eventType);
  // Reset solveCount về 0
  if (socket.server.solveCount) socket.server.solveCount[room] = 0;
  io.to(room).emit("rematch-accepted");
  if (scrambles[room] && scrambles[room].length > 0) {
    io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
  }
});

  socket.on("rematch-declined", ({ roomId }) => {
    const room = roomId.toUpperCase();
    // Gửi thông báo từ chối tái đấu cho tất cả client khác trong phòng
    socket.to(room).emit("rematch-declined");
  });

  // Khi 1 người hủy yêu cầu tái đấu (cancel khi đang chờ)
  socket.on("rematch-cancel", ({ roomId }) => {
    const room = roomId.toUpperCase();
    // Gửi thông báo hủy tái đấu cho tất cả client khác trong phòng
    socket.to(room).emit("rematch-cancel");
  });
  
  // --- Lock due to 2 DNF events ---
  socket.on("lock-due-2dnf", ({ roomId, myDnfCount, oppDnfCount }) => {
    const room = roomId.toUpperCase();
    // Broadcast sự kiện khóa do 2 lần DNF cho tất cả client trong phòng
    io.to(room).emit("lock-due-2dnf", { 
      roomId, 
      myDnfCount, 
      oppDnfCount,
      lockedByUserId: socket.data?.userId || 'unknown'
    });
  });

  socket.on("unlock-due-rematch", ({ roomId }) => {
    const room = roomId.toUpperCase();
    
    // Broadcast sự kiện mở khóa do tái đấu cho tất cả client trong phòng
    io.to(room).emit("unlock-due-rematch", { roomId });

  });

  // Relay camera toggle event to other users in the room
  socket.on("user-cam-toggle", (data) => {
    if (!data || !data.roomId) return;
    const room = data.roomId.toUpperCase();
    socket.to(room).emit("user-cam-toggle", data);
  });

  // Relay microphone toggle event to other users in the room
  socket.on("user-mic-toggle", (data) => {
    if (!data || !data.roomId) return;
    const room = data.roomId.toUpperCase();
    socket.to(room).emit("user-mic-toggle", data);
  });

  // Relay all WebRTC signaling messages (simple-peer expects 'signal')
  socket.on("signal", ({ roomId, userId, userName, signal }) => {
    const room = roomId.toUpperCase();
    // Gửi cho tất cả client khác trong phòng
    socket.to(room).emit("signal", { userId, userName, signal });
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected");
    const room = socket.data?.room;
    const userId = socket.data?.userId || socket.userId;

    if (room && rooms[room]) {
      removeUserAndCleanup(room, userId);
    }

    const cleanupWaitingRoom = (waitingRoomId) => {
      const waitingRoom = waitingRooms[waitingRoomId];
      if (!waitingRoom) return;

      const playerIndex = waitingRoom.players.findIndex(p => p.id === userId);
      if (playerIndex === -1) return;

      const leavingPlayer = waitingRoom.players[playerIndex];
      const wasCreator = leavingPlayer?.role === 'creator';

      waitingRoom.players.splice(playerIndex, 1);

      if (waitingRoom.players.length === 0) {
        delete waitingRooms[waitingRoomId];
        io.emit("update-active-rooms");
        return;
      }

      if (wasCreator) {
        const newCreator = waitingRoom.players[0];
        if (newCreator) {
          newCreator.role = 'creator';
          waitingRoom.roomCreator = newCreator.id;
          console.log(`New creator assigned on disconnect: ${newCreator.name} (${newCreator.id})`);
        }
      }

      reorganizeSeating(waitingRoom);
      io.to(`waiting-${waitingRoomId}`).emit('waiting-room-updated', waitingRoom);
      io.emit("update-active-rooms");
    };

    const waitingRoomIds = socket.data?.waitingRoomIds;
    if (waitingRoomIds instanceof Set && waitingRoomIds.size > 0) {
      waitingRoomIds.forEach(roomId => cleanupWaitingRoom(roomId));
      waitingRoomIds.clear();
      delete socket.data.waitingRoomIds;
    } else if (userId) {
      Object.keys(waitingRooms).forEach(roomId => cleanupWaitingRoom(roomId));
    }

    if (rooms[""]) {
      const filteredEmptyRoom = rooms[""]?.filter(u => u);
      if (filteredEmptyRoom.length === 0) {
        delete rooms[""];
        delete scrambles[""];
        if (socket.server.solveCount) delete socket.server.solveCount[""];
        if (global.roomTimeouts && global.roomTimeouts[""]) {
          clearTimeout(global.roomTimeouts[""]);
          delete global.roomTimeouts[""];
        }
        delete roomHosts[""];
        console.log('Room "" deleted from rooms object (empty).');
      }
    }
  });

  // ===== WAITING ROOM 2VS2 LOGIC =====
  
  // Join waiting room
  socket.on('join-waiting-room', (data) => {
    const { roomId, userId, userName, displayName, password } = data;

    
    if (!waitingRooms[roomId]) {
      waitingRooms[roomId] = {
        roomId,
        players: [],
        roomCreator: userId, // Người đầu tiên join sẽ là chủ phòng
        gameStarted: false,
        createdAt: Date.now(), // Thêm timestamp để track thời gian tạo
        displayName: displayName || roomId, // Tên phòng hiển thị
        password: password || null // Mật khẩu phòng
      };
    } else {
      // Cập nhật displayName và password nếu có
      if (displayName) {
        waitingRooms[roomId].displayName = displayName;
      }
      if (password) {
        waitingRooms[roomId].password = password;
      }
    }
      
      // Set timeout xóa phòng sau 5 phút không bắt đầu
      setTimeout(() => {
        if (waitingRooms[roomId] && !waitingRooms[roomId].gameStarted) {
          console.log(`⏰ Waiting room ${roomId} deleted after 5 minutes of inactivity`);
          delete waitingRooms[roomId];
          io.emit("update-active-rooms");
        }
      }, 5 * 60 * 1000); // 5 phút
    
    // Kiểm tra xem user đã có trong phòng chưa
    const existingPlayerIndex = waitingRooms[roomId].players.findIndex(p => p.id === userId);
    
    if (existingPlayerIndex === -1) {
      // Thêm player mới
      const newPlayer = {
        id: userId,
        name: userName, // Lưu userName vào field name
        userName: userName, // Cũng lưu vào field userName để đảm bảo
        isReady: false,
        isObserver: false,
        team: null, // Sẽ được assign khi join team
        role: 'player' // Mặc định là player, sẽ được set thành 'creator' nếu là người đầu tiên
      };
      
 
      
      // Thêm player mới vào danh sách
      waitingRooms[roomId].players.push(newPlayer);
  
      
      // Sử dụng thuật toán sắp xếp thông minh
      reorganizeSeating(waitingRooms[roomId]);
    }
    
    socket.data = socket.data || {};
    socket.data.userId = socket.data.userId || userId;
    socket.data.userName = socket.data.userName || userName;
    if (!(socket.data.waitingRoomIds instanceof Set)) {
      socket.data.waitingRoomIds = new Set();
    }
    socket.data.waitingRoomIds.add(roomId);
    socket.userId = socket.userId || userId;

    socket.join(`waiting-${roomId}`);
    
    socket.emit('waiting-room-updated', waitingRooms[roomId]);
    socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
    
    // Emit update active rooms để RoomTab hiển thị phòng chờ
    io.emit("update-active-rooms");
    
    // Log số người trong phòng chờ
    const totalPlayers = waitingRooms[roomId].players.length;
    const team1Count = waitingRooms[roomId].players.filter(p => p.team === 'team1').length;
    const team2Count = waitingRooms[roomId].players.filter(p => p.team === 'team2').length;
    const observerCount = waitingRooms[roomId].players.filter(p => p.isObserver).length;
    console.log(`📊 Waiting room ${roomId}: ${totalPlayers} players (Team1: ${team1Count}, Team2: ${team2Count}, Observers: ${observerCount})`);
  });
  
  // Toggle ready status
  socket.on('toggle-ready', (data) => {
    const { roomId, userId } = data;
    
    if (!waitingRooms[roomId]) return;
    
    const player = waitingRooms[roomId].players.find(p => p.id === userId);
    if (player && player.role === 'player' && !player.isObserver) {
      player.isReady = !player.isReady;
      
      socket.emit('waiting-room-updated', waitingRooms[roomId]);
      socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
      

    } else if (player && player.role === 'creator') {
      socket.emit('error', { message: 'Chủ phòng không cần bấm sẵn sàng, hãy bấm Bắt đầu' });
    } else if (player && player.role === 'observer') {
      socket.emit('error', { message: 'Người xem không thể bấm sẵn sàng' });
    }
  });
  
  // Toggle observer status
  socket.on('toggle-observer', (data) => {
    const { roomId, userId } = data;
    
    if (!waitingRooms[roomId]) return;
    
    const player = waitingRooms[roomId].players.find(p => p.id === userId);
    if (player) {
      // Cho phép chủ phòng chuyển thành observer nhưng vẫn giữ vai trò creator
      if (player.role === 'creator') {
        // Chủ phòng có thể toggle observer nhưng vẫn giữ role creator
        player.isObserver = !player.isObserver;
        player.isReady = true; // Chủ phòng luôn sẵn sàng
      } else {
        // Toggle observer status cho player thường
        player.isObserver = !player.isObserver;
        player.isReady = false;
        
        // Sử dụng thuật toán sắp xếp thông minh cho player thường
        reorganizeSeating(waitingRooms[roomId]);
      }
      
      socket.emit('waiting-room-updated', waitingRooms[roomId]);
      socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
    }
  });
  
  // Start game
  socket.on('start-game', (data) => {
    const { roomId, userId } = data;
    
    if (!waitingRooms[roomId]) return;
    
    const player = waitingRooms[roomId].players.find(p => p.id === userId);
    if (!player || player.role !== 'creator') {
      socket.emit('error', { message: 'Chỉ chủ phòng mới có thể bắt đầu game' });
      return;
    }
    
    // Kiểm tra điều kiện bắt đầu
    const team1Players = waitingRooms[roomId].players.filter(p => p.team === 'team1' && !p.isObserver);
    const team2Players = waitingRooms[roomId].players.filter(p => p.team === 'team2' && !p.isObserver);
    
    if (team1Players.length !== 2 || team2Players.length !== 2) {
      socket.emit('error', { message: 'Cần đủ 2 người mỗi đội để bắt đầu' });
      return;
    }
    
    if (!team1Players.every(p => p.isReady) || !team2Players.every(p => p.isReady)) {
      socket.emit('error', { message: 'Tất cả người chơi phải sẵn sàng' });
      return;
    }
    
    // Đánh dấu game đã bắt đầu
    waitingRooms[roomId].gameStarted = true;
    
    // Cập nhật roomsMeta với displayName từ waiting room
    if (!roomsMeta[roomId]) {
      roomsMeta[roomId] = {};
    }
    roomsMeta[roomId].displayName = waitingRooms[roomId].displayName || roomId;
    roomsMeta[roomId].gameMode = '2vs2';
    roomsMeta[roomId].event = '3x3'; // default event
    roomsMeta[roomId].password = waitingRooms[roomId].password || '';

    // Snapshot toàn bộ người chơi (kể cả observer) cùng thông tin team/position
    const playersSnapshot = waitingRooms[roomId].players.map(player => ({
      userId: player.id,
      userName: player.name,
      team: player.team || null,
      position: player.position ?? null,
      role: player.role,
      isObserver: !!player.isObserver,
      isReady: !!player.isReady
    }));
    rooms[roomId] = playersSnapshot;
    roomsMeta[roomId].playerMap = playersSnapshot.reduce((acc, player) => {
      acc[player.userId] = {
        team: player.team || null,
        position: typeof player.position === 'number' ? player.position : null
      };
      return acc;
    }, {});

    // Cập nhật roomHosts và roomTurns
    roomHosts[roomId] = waitingRooms[roomId].roomCreator;
    const order = setTurnSequenceForRoom(roomId, playersSnapshot, null);
    const currentTurnUserId = roomTurns[roomId] || (order[0] ?? waitingRooms[roomId].roomCreator);
    roomTurns[roomId] = currentTurnUserId;
    if (!order.length) {
      delete roomTurnSequences[roomId];
      delete roomTurnSequencesNormalized[roomId];
      delete roomTurnIndices[roomId];
    }
    
    // Emit room-users để clients cập nhật pendingUsers
    io.to(roomId).emit("room-users", { users: rooms[roomId], hostId: roomHosts[roomId] });
    io.to(roomId).emit("room-turn", { turnUserId: roomTurns[roomId] || null });
    
    // Chuyển hướng tất cả players sang room game
    socket.emit('game-started', { roomId, gameMode: '2vs2' });
    socket.to(`waiting-${roomId}`).emit('game-started', { roomId, gameMode: '2vs2' });
    
    // Xóa waiting room sau khi bắt đầu game (delay 2 giây để đảm bảo clients đã redirect)
    setTimeout(() => {
      if (waitingRooms[roomId]) {
        delete waitingRooms[roomId];
        io.emit("update-active-rooms");
      }
    }, 2000); // 2 giây delay
  });
  
  // Leave waiting room
  socket.on('leave-waiting-room', (data) => {
    const { roomId, userId } = data;
    
    if (!waitingRooms[roomId]) return;
    
    // Lưu thông tin người rời để xử lý
    const leavingPlayer = waitingRooms[roomId].players.find(p => p.id === userId);
    const wasCreator = leavingPlayer?.role === 'creator';
    
    // Xóa người rời khỏi danh sách
    waitingRooms[roomId].players = waitingRooms[roomId].players.filter(p => p.id !== userId);
    
    // Nếu phòng trống, xóa phòng
    if (waitingRooms[roomId].players.length === 0) {
      delete waitingRooms[roomId];
      io.emit("update-active-rooms");
      return;
    }
    
    // Nếu chủ phòng rời, chọn chủ phòng mới
    if (wasCreator) {
      const newCreator = waitingRooms[roomId].players[0]; // Chọn người đầu tiên làm chủ phòng mới
      if (newCreator) {
        newCreator.role = 'creator';
        waitingRooms[roomId].roomCreator = newCreator.id;
      }
    }
    
    // Sắp xếp lại chỗ ngồi thông minh
    reorganizeSeating(waitingRooms[roomId]);
    
    if (socket.data?.waitingRoomIds instanceof Set) {
      socket.data.waitingRoomIds.delete(roomId);
      if (socket.data.waitingRoomIds.size === 0) {
        delete socket.data.waitingRoomIds;
      }
    }
    
    socket.leave(`waiting-${roomId}`);
    socket.emit('waiting-room-updated', waitingRooms[roomId]);
    socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
    io.emit("update-active-rooms");
    

  });
  // Swap seat handlers - đơn giản như chat
  socket.on('swap-seat-request', (data) => {
    const { roomId, fromUserId, toUserId, fromPosition, toPosition } = data;
    
    console.log('Server received swap-seat-request:', data);
    
    if (!waitingRooms[roomId]) {
      console.log('Room not found:', roomId);
      return;
    }
    
    const fromPlayer = waitingRooms[roomId].players.find(p => p.id === fromUserId);
    const toPlayer = waitingRooms[roomId].players.find(p => p.id === toUserId);
    
    if (!fromPlayer || !toPlayer) {
      console.log('Players not found');
      return;
    }
    
    // Broadcast đến tất cả user trong room (như chat)
    console.log('Broadcasting swap-seat-request to room:', `waiting-${roomId}`);
    io.to(`waiting-${roomId}`).emit('swap-seat-request', {
      fromPlayer,
      toPlayer,
      fromPosition,
      toPosition,
      targetUserId: toUserId
    });
  });

  socket.on('swap-seat-response', (data) => {
    const { roomId, accepted, fromUserId, toUserId, fromPosition, toPosition } = data;
    
    console.log('Server received swap-seat-response:', data);
    
    if (!waitingRooms[roomId]) return;
    
    if (accepted) {
      // Thực hiện đổi chỗ
      const fromPlayer = waitingRooms[roomId].players.find(p => p.id === fromUserId);
      const toPlayer = waitingRooms[roomId].players.find(p => p.id === toUserId);
      
      if (fromPlayer && toPlayer) {
        // Đổi position
        const tempPosition = fromPlayer.position;
        fromPlayer.position = toPlayer.position;
        toPlayer.position = tempPosition;
        
        // Đổi team nếu cần
        const tempTeam = fromPlayer.team;
        fromPlayer.team = toPlayer.team;
        toPlayer.team = tempTeam;
        
        console.log('Seats swapped successfully');
      }
    }
    
    // Broadcast phản hồi đến tất cả user trong room (như chat)
    console.log('Broadcasting swap-seat-response to room:', `waiting-${roomId}`);
    io.to(`waiting-${roomId}`).emit('swap-seat-response', {
      accepted,
      fromUserId,
      toUserId,
      fromPosition,
      toPosition,
      targetUserId: fromUserId // Người yêu cầu cần nhận phản hồi
    });
    
    // Broadcast update room state
    io.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
  });
});