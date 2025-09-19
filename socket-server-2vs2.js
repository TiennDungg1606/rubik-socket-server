const { Server } = require("socket.io");
const http = require("http");
const url = require("url");
const { generateWcaScramble, generate2x2Scramble, generate3x3Scramble, generate4x4Scramble, generatePyraminxScramble } = require("./scramble.js");

// Quản lý phòng game 2vs2 (riêng biệt hoàn toàn)
const gameRooms2vs2 = {}; // Quản lý người chơi trong từng room 2vs2
const scrambles2vs2 = {}; // Quản lý scramble cho từng room 2vs2
const roomsMeta2vs2 = {}; // Quản lý meta phòng 2vs2: event, displayName, password
const roomHosts2vs2 = {}; // Lưu userId chủ phòng cho từng room 2vs2
const roomTurns2vs2 = {}; // Lưu userId người được quyền giải (turn) cho từng room 2vs2

// Quản lý phòng chờ 2vs2
const waitingRooms = {}; // { roomId: { players: [], roomCreator: '', gameStarted: false } }

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
    
    // Các người còn lại là observers
    observers.forEach(observer => {
      observer.role = 'observer';
      observer.team = null;
      observer.position = null;
      observer.isReady = false; // Observer không cần ready
    });
    
    console.log('Five+ players - creator + 3 players + observers');
  }
}

// Hàm dọn dẹp phòng trống
function removeUserAndCleanup(room, userId) {
  if (!room || !rooms[room]) return;
  
  if (userId) {
    rooms[room] = rooms[room].filter(u => u && u.userId !== userId && u.userId !== "");
  }
  
  const filteredUsers = rooms[room].filter(u => u);
  if (filteredUsers.length === 0) {
    delete rooms[room];
    delete scrambles[room];
    if (socket.server.solveCount) delete socket.server.solveCount[room];
    if (global.roomTimeouts && global.roomTimeouts[room]) {
      clearTimeout(global.roomTimeouts[room]);
      delete global.roomTimeouts[room];
    }
    delete roomHosts[room];
    delete roomTurns[room];
    delete roomsMeta[room];
    io.emit("update-active-rooms");
  }
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
  return localScrambles;
}

// Tạo HTTP server để phục vụ REST API và Socket.io cho 2vs2
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
  
  // REST endpoint: /room-users/:roomId (2vs2)
  if (parsed.pathname && parsed.pathname.startsWith("/room-users/")) {
    const roomId = parsed.pathname.split("/room-users/")[1]?.toUpperCase();
    if (roomId && gameRooms2vs2[roomId]) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(gameRooms2vs2[roomId]));
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

  // REST endpoint: /active-rooms (2vs2)
  if (parsed.pathname === "/active-rooms") {
    res.writeHead(200, { "Content-Type": "application/json" });
    
    // Trả về danh sách phòng 2vs2 kèm meta và số lượng user
    const result2vs2 = Object.keys(gameRooms2vs2).map(roomId => ({
      roomId,
      meta: roomsMeta2vs2[roomId] || {},
      usersCount: Array.isArray(gameRooms2vs2[roomId]) ? gameRooms2vs2[roomId].length : 0
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
    
    // Gộp cả 2 loại phòng: 2vs2 game rooms và waiting rooms
    const allRooms = [...result2vs2, ...waitingRoomResults];
    res.end(JSON.stringify(allRooms));
    return;
  }

  // REST endpoint: /room-meta/:roomId (2vs2)
  if (parsed.pathname && parsed.pathname.startsWith("/room-meta/")) {
    const roomId = parsed.pathname.split("/room-meta/")[1]?.toUpperCase();
    res.writeHead(200, { "Content-Type": "application/json" });
    
    // Kiểm tra cả 2vs2 game rooms và waiting rooms
    const meta2vs2 = roomsMeta2vs2[roomId] || {};
    const waitingMeta = waitingRooms[roomId] ? {
      gameMode: '2vs2',
      event: '3x3',
      displayName: waitingRooms[roomId].displayName || roomId,
      password: waitingRooms[roomId].password || null,
      isWaitingRoom: true
    } : {};
    
    // Trả về meta từ phòng nào có dữ liệu
    const finalMeta = meta2vs2.event ? meta2vs2 : waitingMeta;
    res.end(JSON.stringify(finalMeta));
    return;
  }
  
  // Default: 404
  res.writeHead(404);
  res.end();
});

const io = new Server(server, {
  cors: {
    origin: "*", // Cho phép mọi domain kết nối (dễ test)
  },
});

const PORT = process.env.PORT_2VS2 || 3002; // Port riêng cho 2vs2
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Socket.io + REST server for 2vs2 running on port ${PORT}`);
});

io.on("connection", (socket) => {
  // Relay timer-prep event to other users in the room
  socket.on("timer-prep", (data) => {
    if (!data || !data.roomId) return;
    const room = data.roomId.toUpperCase();
    socket.to(room).emit("timer-prep", data);
  });

  // Quản lý interval gửi timer-update liên tục cho từng phòng
  if (!global.timerIntervals) global.timerIntervals = {};
  const timerIntervals = global.timerIntervals;

  // Khi nhận timer-update từ client, server sẽ phát tán liên tục cho các client khác trong phòng
  socket.on("timer-update", (data) => {
    if (!data || !data.roomId) return;
    const room = data.roomId.toUpperCase();
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
        const ms = timerState.ms + elapsed;
        // Cập nhật lastUpdate
        global.roomTimers[room].lastUpdate = now;
        global.roomTimers[room].ms = ms;
        // Gửi timer-update cho tất cả client khác trong phòng
        io.to(room).emit("timer-update", {
          roomId: room,
          userId: timerState.userId,
          ms: ms,
          running: true,
          finished: false
        });
      }, 16); // ~60fps
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
  });
  console.log("🔌 Client connected to 2vs2 server");

  // Map lưu timeout tự hủy phòng nếu chỉ có 1 người (chủ phòng) sau 5 phút
  if (!global.roomTimeouts) global.roomTimeouts = {};
  const roomTimeouts = global.roomTimeouts;

  // Xử lý rời phòng chủ động từ client
  socket.on("leave-room", ({ roomId, userId }) => {
    removeUserAndCleanup(roomId?.toUpperCase(), userId);
  });

  // Join room cho 2vs2
  socket.on("join-room", ({ roomId, userId, userName, isSpectator = false, event, displayName, password }) => {
    const room = roomId.toUpperCase();
    if (!userName || typeof userName !== "string" || !userName.trim() || !userId || typeof userId !== "string" || !userId.trim()) {
      console.log(`❌ Không cho phép join-room với userName/userId rỗng hoặc không hợp lệ: '${userName}' '${userId}'`);
      return;
    }
    console.log(`🎮 2vs2: ${userName} (${userId}) joined room ${room} (socket.id: ${socket.id})`);
    socket.join(room);
    socket.data = socket.data || {};
    socket.data.room = room;
    socket.data.userName = userName;
    socket.data.userId = userId;
    socket.data.gameMode = '2vs2';

    if (!gameRooms2vs2[room]) gameRooms2vs2[room] = [];
    let isNewRoom = false;
    if (gameRooms2vs2[room].length === 0) {
      roomsMeta2vs2[room] = {
        event: event || "3x3",
        displayName: displayName || room,
        password: password || ""
      };
      isNewRoom = true;
      // Gán host là userId đầu tiên
      roomHosts2vs2[room] = userId;
      // Gán lượt chơi ban đầu là host
      roomTurns2vs2[room] = userId;
    } else {
      const roomPassword = roomsMeta2vs2[room]?.password || "";
      if (roomPassword && password !== roomPassword) {
        socket.emit("wrong-password", { message: "Sai mật khẩu phòng!" });
        return;
      }
    }
    if (gameRooms2vs2[room].length >= 4) {
      socket.emit("room-full", { message: "Phòng 2vs2 đã đủ 4 người chơi" });
      return;
    }

    if (!gameRooms2vs2[room].some(u => u.userId === userId)) {
      gameRooms2vs2[room].push({ userId, userName });
    }

    // Broadcast danh sách user, host và turn cho 2vs2
    io.to(room).emit("room-users", { users: gameRooms2vs2[room], hostId: roomHosts2vs2[room] });
    io.to(room).emit("room-turn", { turnUserId: roomTurns2vs2[room] });
    if (isNewRoom) {
      io.emit("update-active-rooms");
    }
    console.log("All 2vs2 rooms:", JSON.stringify(gameRooms2vs2));

    if (!scrambles2vs2[room]) {
      scrambles2vs2[room] = [];
      const eventType = roomsMeta2vs2[room]?.event || "3x3";
      const scrambleList = generateLocalScrambles(eventType);
      scrambles2vs2[room] = scrambleList;
      if (scrambles2vs2[room] && scrambles2vs2[room].length > 0) {
        io.to(room).emit("scramble", { scramble: scrambles2vs2[room][0], index: 0 });
      }
    }
    if (scrambles2vs2[room] && scrambles2vs2[room].length > 0) {
      io.to(room).emit("scramble", { scramble: scrambles2vs2[room][0], index: 0 });
    }

    if (gameRooms2vs2[room].length === 1) {
      // Khi chỉ còn 1 người, luôn set turn về cho host
      roomTurns2vs2[room] = roomHosts2vs2[room];
      io.to(room).emit("room-turn", { turnUserId: roomTurns2vs2[room] });
      if (global.roomTimeouts[room]) {
        clearTimeout(global.roomTimeouts[room]);
      }
      global.roomTimeouts[room] = setTimeout(() => {
        if (gameRooms2vs2[room] && gameRooms2vs2[room].length === 1) {
          console.log(`⏰ Phòng 2vs2 ${room} chỉ có 1 người chơi sau 5 phút, tự động xóa.`);
          delete gameRooms2vs2[room];
          delete scrambles2vs2[room];
          if (socket.server.solveCount) delete socket.server.solveCount[room];
          delete global.roomTimeouts[room];
          delete roomHosts2vs2[room];
          delete roomsMeta2vs2[room]; // Xóa meta khi phòng trống
          io.to(room).emit("room-users", { users: [], hostId: null });
        }
      }, 5 * 60 * 1000);
    } else {
      if (global.roomTimeouts[room]) {
        clearTimeout(global.roomTimeouts[room]);
        delete global.roomTimeouts[room];
        console.log(`❌ Hủy timeout tự hủy phòng 2vs2 ${room} vì đã có thêm người chơi.`);
      }
      if (gameRooms2vs2[room].length >= 2) {
        if (socket.server.solveCount) socket.server.solveCount[room] = 0;
        const eventType = roomsMeta2vs2[room]?.event || "3x3";
        scrambles2vs2[room] = generateLocalScrambles(eventType);
        io.to(room).emit("room-reset");
        if (scrambles2vs2[room] && scrambles2vs2[room].length > 0) {
          io.to(room).emit("scramble", { scramble: scrambles2vs2[room][0], index: 0 });
        }
        // Khi đủ người, set turn về cho host
        roomTurns2vs2[room] = roomHosts2vs2[room];
        io.to(room).emit("room-turn", { turnUserId: roomTurns2vs2[room] });
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

  // Solve event cho 2vs2
  socket.on("solve", ({ roomId, userId, userName, time }) => {
    const room = roomId.toUpperCase();
    console.log(`🧩 2vs2: ${userName} (${userId}) solved in ${time}ms`);
    // Gửi kết quả cho đối thủ
    socket.to(room).emit("opponent-solve", { userId, userName, time });

    // Quản lý lượt giải để gửi scramble tiếp theo cho 2vs2
    if (!socket.server.solveCount) socket.server.solveCount = {};
    if (!socket.server.solveCount[room]) socket.server.solveCount[room] = 0;
    socket.server.solveCount[room]++;
    
    // Logic 2vs2: có thể có nhiều người chơi hơn, cần logic khác
    const totalSolves = socket.server.solveCount[room];
    if (totalSolves % 2 === 0) {
      const idx = totalSolves / 2;
      if (scrambles2vs2[room] && scrambles2vs2[room][idx]) {
        io.to(room).emit("scramble", { scramble: scrambles2vs2[room][idx], index: idx });
      }
    }
    
    // Đổi lượt chơi cho người tiếp theo trong 2vs2
    if (gameRooms2vs2[room] && gameRooms2vs2[room].length >= 2) {
      const userIds = gameRooms2vs2[room].map(u => u.userId);
      // Chuyển lượt cho người tiếp theo (có thể là teammate hoặc opponent)
      const currentIndex = userIds.indexOf(userId);
      const nextIndex = (currentIndex + 1) % userIds.length;
      const nextTurn = userIds[nextIndex];
      if (nextTurn) {
        roomTurns2vs2[room] = nextTurn;
        io.to(room).emit("room-turn", { turnUserId: nextTurn });
      }
    }
  });

  // Rematch events cho 2vs2
  socket.on("rematch-request", ({ roomId, fromUserId }) => {
    const room = roomId.toUpperCase();
    // Gửi yêu cầu tái đấu cho tất cả client khác trong phòng
    socket.to(room).emit("rematch-request", { fromUserId });
  });

  socket.on("rematch-accepted", ({ roomId }) => {
    const room = roomId.toUpperCase();
    // Sinh lại 5 scramble mới cho phòng 2vs2
    const eventType = roomsMeta2vs2[room]?.event || "3x3";
    scrambles2vs2[room] = generateLocalScrambles(eventType);
    // Reset solveCount về 0
    if (socket.server.solveCount) socket.server.solveCount[room] = 0;
    io.to(room).emit("rematch-accepted");
    if (scrambles2vs2[room] && scrambles2vs2[room].length > 0) {
      io.to(room).emit("scramble", { scramble: scrambles2vs2[room][0], index: 0 });
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

  // Disconnect handler cho 2vs2
  socket.on("disconnect", () => {
    console.log("❌ Client disconnected from 2vs2 server");
    const room = socket.data?.room;
    const userId = socket.data?.userId;
    
    if (room && gameRooms2vs2[room]) {
      gameRooms2vs2[room] = gameRooms2vs2[room].filter(u => u && u.userId !== userId && u.userId !== "");
      // Nếu host rời phòng, chọn người còn lại làm host mới
      if (roomHosts2vs2[room] === userId) {
        if (gameRooms2vs2[room].length > 0) {
          roomHosts2vs2[room] = gameRooms2vs2[room][0].userId;
        } else {
          delete roomHosts2vs2[room];
        }
      }
      // Nếu turnUserId rời phòng, chuyển lượt cho người còn lại (nếu còn)
      if (roomTurns2vs2[room] === userId) {
        if (gameRooms2vs2[room].length > 0) {
          roomTurns2vs2[room] = gameRooms2vs2[room][0].userId;
        } else {
          delete roomTurns2vs2[room];
        }
      }
      io.to(room).emit("room-users", { users: gameRooms2vs2[room], hostId: roomHosts2vs2[room] || null });
      io.to(room).emit("room-turn", { turnUserId: roomTurns2vs2[room] || null });
      
      const filteredUsers = gameRooms2vs2[room].filter(u => u);
      if (filteredUsers.length === 0) {
        delete gameRooms2vs2[room];
        delete scrambles2vs2[room];
        if (socket.server.solveCount) delete socket.server.solveCount[room];
        if (global.roomTimeouts && global.roomTimeouts[room]) {
          clearTimeout(global.roomTimeouts[room]);
          delete global.roomTimeouts[room];
        }
        delete roomHosts2vs2[room];
        delete roomTurns2vs2[room];
        delete roomsMeta2vs2[room]; // Xóa meta khi phòng trống
        console.log(`Room 2vs2 ${room} deleted from gameRooms2vs2 object (empty).`);
      } else if (filteredUsers.length === 1) {
        if (socket.server.solveCount) socket.server.solveCount[room] = 0;
        const eventType = roomsMeta2vs2[room]?.event || "3x3";
        scrambles2vs2[room] = generateLocalScrambles(eventType);
        if (scrambles2vs2[room] && scrambles2vs2[room].length > 0) {
          io.to(room).emit("scramble", { scramble: scrambles2vs2[room][0], index: 0 });
        }
        io.to(room).emit("room-reset");
        // Khi chỉ còn 1 người, set turn về cho host
        if (gameRooms2vs2[room].length === 1) {
          roomTurns2vs2[room] = roomHosts2vs2[room];
          io.to(room).emit("room-turn", { turnUserId: roomTurns2vs2[room] });
        }
        if (global.roomTimeouts) {
          if (global.roomTimeouts[room]) {
            clearTimeout(global.roomTimeouts[room]);
          }
          global.roomTimeouts[room] = setTimeout(() => {
            if (gameRooms2vs2[room] && gameRooms2vs2[room].length === 1) {
              console.log(`⏰ Phòng 2vs2 ${room} chỉ còn 1 người chơi sau disconnect, tự động xóa sau 5 phút.`);
              delete gameRooms2vs2[room];
              delete scrambles2vs2[room];
              if (socket.server.solveCount) delete socket.server.solveCount[room];
              delete global.roomTimeouts[room];
              delete roomHosts2vs2[room];
              delete roomTurns2vs2[room];
              io.to(room).emit("room-users", { users: [], hostId: null });
              io.to(room).emit("room-turn", { turnUserId: null });
            }
          }, 5 * 60 * 1000);
        }
      } else {
        if (global.roomTimeouts && global.roomTimeouts[room]) {
          clearTimeout(global.roomTimeouts[room]);
          delete global.roomTimeouts[room];
        }
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
        roomCreator: null, // Sẽ được set khi user đầu tiên join
        gameStarted: false,
        displayName: displayName || roomId, // Lưu tên phòng
        password: password || null // Lưu mật khẩu
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

    // Kiểm tra mật khẩu nếu có
    if (waitingRooms[roomId].password && password !== waitingRooms[roomId].password) {
      socket.emit('wrong-password', { message: 'Sai mật khẩu phòng!' });
      return;
    }

    // Thêm user vào danh sách players nếu chưa có
    const existingPlayerIndex = waitingRooms[roomId].players.findIndex(p => p.userId === userId);
    if (existingPlayerIndex === -1) {
      waitingRooms[roomId].players.push({
        userId,
        userName,
        role: 'player',
        team: null,
        position: null,
        isReady: false
      });
    }

    // Set roomCreator nếu đây là user đầu tiên
    if (!waitingRooms[roomId].roomCreator) {
      waitingRooms[roomId].roomCreator = userId;
    }

    // Sắp xếp lại chỗ ngồi
    reorganizeSeating(waitingRooms[roomId]);

    socket.join(`waiting-${roomId}`);
    
    socket.emit('waiting-room-updated', waitingRooms[roomId]);
    socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
    
    // Emit update active rooms để RoomTab hiển thị phòng chờ
    io.emit("update-active-rooms");
  });

  // Leave waiting room
  socket.on('leave-waiting-room', (data) => {
    const { roomId, userId } = data;
    
    if (waitingRooms[roomId]) {
      // Xóa user khỏi danh sách players
      waitingRooms[roomId].players = waitingRooms[roomId].players.filter(p => p.userId !== userId);
      
      // Nếu không còn ai, xóa waiting room
      if (waitingRooms[roomId].players.length === 0) {
        delete waitingRooms[roomId];
      } else {
        // Sắp xếp lại chỗ ngồi
        reorganizeSeating(waitingRooms[roomId]);
        
        // Emit update cho các user còn lại
        socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
      }
      
      // Emit update active rooms
      io.emit("update-active-rooms");
    }
    
    socket.leave(`waiting-${roomId}`);
  });

  // Toggle ready status
  socket.on('toggle-ready', (data) => {
    const { roomId, userId } = data;
    
    if (waitingRooms[roomId]) {
      const player = waitingRooms[roomId].players.find(p => p.userId === userId);
      if (player) {
        player.isReady = !player.isReady;
        
        // Emit update cho tất cả user trong waiting room
        io.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
      }
    }
  });

  // Toggle observer status
  socket.on('toggle-observer', (data) => {
    const { roomId, userId } = data;
    
    if (waitingRooms[roomId]) {
      const player = waitingRooms[roomId].players.find(p => p.userId === userId);
      if (player) {
        if (player.role === 'observer') {
          // Chuyển từ observer về player
          player.role = 'player';
          player.isReady = false;
        } else {
          // Chuyển từ player về observer
          player.role = 'observer';
          player.isReady = false;
        }
        
        // Sắp xếp lại chỗ ngồi
        reorganizeSeating(waitingRooms[roomId]);
        
        // Emit update cho tất cả user trong waiting room
        io.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
      }
    }
  });

  // Start game
  socket.on('start-game', (data) => {
    const { roomId } = data;
    
    if (waitingRooms[roomId]) {
      // Kiểm tra điều kiện bắt đầu game
      const players = waitingRooms[roomId].players.filter(p => p.role !== 'observer');
      const readyPlayers = players.filter(p => p.isReady);
      
      if (readyPlayers.length >= 2) {
        waitingRooms[roomId].gameStarted = true;
        
        // Emit game-started event
        io.to(`waiting-${roomId}`).emit('game-started', { 
          roomId, 
          gameMode: '2vs2',
          players: waitingRooms[roomId].players 
        });
        
        // Xóa waiting room sau khi start game
        delete waitingRooms[roomId];
        
        // Emit update active rooms
        io.emit("update-active-rooms");
      }
    }
  });

  // Chat trong waiting room
  socket.on('chat', (data) => {
    const { roomId, userId, userName, message } = data;
    
    if (waitingRooms[roomId]) {
      // Gửi tin nhắn cho tất cả user khác trong waiting room (không gửi cho chính người gửi)
      socket.to(`waiting-${roomId}`).emit('chat', { userId, userName, message });
    }
  });

  // Swap seat request
  socket.on('swap-seat-request', (data) => {
    const { roomId, fromUserId, targetUserId, fromSeat, targetSeat } = data;
    
    if (waitingRooms[roomId]) {
      // Broadcast swap request đến tất cả user trong waiting room
      io.to(`waiting-${roomId}`).emit('swap-seat-request', {
        fromUserId,
        targetUserId,
        fromSeat,
        targetSeat
      });
    }
  });

  // Swap seat response
  socket.on('swap-seat-response', (data) => {
    const { roomId, fromUserId, targetUserId, accepted } = data;
    
    if (waitingRooms[roomId]) {
      if (accepted) {
        // Thực hiện swap seat
        const fromPlayer = waitingRooms[roomId].players.find(p => p.userId === fromUserId);
        const targetPlayer = waitingRooms[roomId].players.find(p => p.userId === targetUserId);
        
        if (fromPlayer && targetPlayer) {
          // Swap team và position
          const tempTeam = fromPlayer.team;
          const tempPosition = fromPlayer.position;
          
          fromPlayer.team = targetPlayer.team;
          fromPlayer.position = targetPlayer.position;
          
          targetPlayer.team = tempTeam;
          targetPlayer.position = tempPosition;
          
          // Sắp xếp lại chỗ ngồi
          reorganizeSeating(waitingRooms[roomId]);
        }
      }
      
      // Broadcast response đến tất cả user trong waiting room
      io.to(`waiting-${roomId}`).emit('swap-seat-response', {
        fromUserId,
        targetUserId,
        accepted
      });
    }
  });
});

module.exports = { server, io };
