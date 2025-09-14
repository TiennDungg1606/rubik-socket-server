
const { Server } = require("socket.io");
const http = require("http");
const url = require("url");
const { generateWcaScramble, generate2x2Scramble, generate3x3Scramble, generate4x4Scramble, generatePyraminxScramble } = require("./scramble.js");

const rooms = {}; // Quản lý người chơi trong từng room
const scrambles = {}; // Quản lý scramble cho từng room
const roomsMeta = {}; // Quản lý meta phòng: event, displayName, password
const roomHosts = {}; // Lưu userId chủ phòng cho từng room
const roomTurns = {}; // Lưu userId người được quyền giải (turn) cho từng room
// Đã loại bỏ logic người xem (spectator)

// Quản lý phòng chờ 2vs2
const waitingRooms = {}; // { roomId: { players: [], roomCreator: '', gameStarted: false } }

// Hàm sắp xếp lại chỗ ngồi thông minh
function reorganizeSeating(room) {
  console.log('=== REORGANIZING SEATING ===');
  console.log('Players before reorganization:', room.players.map(p => ({ name: p.name, role: p.role, team: p.team, position: p.position })));
  
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
    console.log('Single player - assigned as CREATOR');
  } else if (totalPlayers === 2) {
    // 2 người = chủ phòng + 1 người chơi
    const [creator, player] = players;
    creator.role = 'creator';
    creator.team = 'team1';
    creator.position = 1;
    
    player.role = 'player';
    player.team = 'team1';
    player.position = 2;
    console.log('Two players - creator + player in team1');
  } else if (totalPlayers === 3) {
    // 3 người = chủ phòng + 2 người chơi
    const [creator, player1, player2] = players;
    creator.role = 'creator';
    creator.team = 'team1';
    creator.position = 1;
    
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
  
  console.log('Players after reorganization:', room.players.map(p => ({ name: p.name, role: p.role, team: p.team, position: p.position })));
}

// Xóa user khỏi phòng và dọn dẹp nếu phòng trống
function removeUserAndCleanup(room, userId) {
  if (!room || !rooms[room]) return;
  rooms[room] = rooms[room].filter(u => u && u.userId !== userId && u.userId !== "");
  // Nếu host rời phòng, chọn người còn lại làm host mới
  if (roomHosts[room] === userId) {
    if (rooms[room].length > 0) {
      roomHosts[room] = rooms[room][0].userId;
    } else {
      delete roomHosts[room];
    }
  }
  // Nếu turnUserId rời phòng, chuyển lượt cho người còn lại (nếu còn)
  if (roomTurns[room] === userId) {
    if (rooms[room].length > 0) {
      roomTurns[room] = rooms[room][0].userId;
    } else {
      delete roomTurns[room];
    }
  }
  io.to(room).emit("room-users", { users: rooms[room], hostId: roomHosts[room] || null });
  io.to(room).emit("room-turn", { turnUserId: roomTurns[room] || null });
  const filteredUsers = rooms[room].filter(u => u);
  if (filteredUsers.length === 0) {
    delete rooms[room];
    delete scrambles[room];
    if (io.sockets && io.sockets.server && io.sockets.server.solveCount) delete io.sockets.server.solveCount[room];
    if (global.roomTimeouts && global.roomTimeouts[room]) {
      clearTimeout(global.roomTimeouts[room]);
      delete global.roomTimeouts[room];
    }
    delete roomHosts[room];
    delete roomTurns[room];
    delete roomsMeta[room];
    io.emit("update-active-rooms");
    console.log(`Room ${room} deleted from rooms object (empty).`);
  } else if (filteredUsers.length === 1) {
    if (io.sockets && io.sockets.server && io.sockets.server.solveCount) io.sockets.server.solveCount[room] = 0;
    const eventType = roomsMeta[room]?.event || "3x3";
    scrambles[room] = generateLocalScrambles(eventType);
    if (scrambles[room] && scrambles[room].length > 0) {
      io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
    }
    io.to(room).emit("room-reset");
    // Khi chỉ còn 1 người, set turn về cho host
    if (rooms[room].length === 1) {
      roomTurns[room] = roomHosts[room];
      io.to(room).emit("room-turn", { turnUserId: roomTurns[room] });
    }
    if (global.roomTimeouts) {
      if (global.roomTimeouts[room]) {
        clearTimeout(global.roomTimeouts[room]);
      }
      global.roomTimeouts[room] = setTimeout(() => {
        if (rooms[room] && rooms[room].length === 1) {
          delete rooms[room];
          delete scrambles[room];
          if (io.sockets && io.sockets.server && io.sockets.server.solveCount) delete io.sockets.server.solveCount[room];
          delete global.roomTimeouts[room];
          delete roomHosts[room];
          delete roomTurns[room];
          io.to(room).emit("room-users", { users: [], hostId: null });
          io.to(room).emit("room-turn", { turnUserId: null });
          io.emit("update-active-rooms");
        }
      }, 5 * 60 * 1000);
    }
    io.emit("update-active-rooms");
  } else {
    if (global.roomTimeouts && global.roomTimeouts[room]) {
      clearTimeout(global.roomTimeouts[room]);
      delete global.roomTimeouts[room];
    }
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
        const { roomId, gameMode, event, displayName } = JSON.parse(body);
        console.log('Creating waiting room via API:', { roomId, gameMode, event, displayName });
        
        // Tạo waiting room nếu chưa tồn tại
        if (!waitingRooms[roomId]) {
          waitingRooms[roomId] = {
            roomId,
            players: [],
            roomCreator: null, // Sẽ được set khi user đầu tiên join
            gameStarted: false
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
      meta: roomsMeta[roomId] || {},
      usersCount: Array.isArray(rooms[roomId]) ? rooms[roomId].length : 0
    }));
    
    // Thêm waiting rooms 2vs2
    const waitingRoomResults = Object.keys(waitingRooms).map(roomId => ({
      roomId,
      meta: { 
        gameMode: '2vs2',
        event: '3x3', // default event
        displayName: `Waiting ${roomId}`,
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
        io.to(room).emit("timer-update", {
          roomId: room,
          userId: timerState.userId,
          ms,
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
  });
  console.log("🔌 Client connected");


  // Map lưu timeout tự hủy phòng nếu chỉ có 1 người (chủ phòng) sau 5 phút
  if (!global.roomTimeouts) global.roomTimeouts = {};
  const roomTimeouts = global.roomTimeouts;

  // Xử lý rời phòng chủ động từ client
  socket.on("leave-room", ({ roomId, userId }) => {
    removeUserAndCleanup(roomId?.toUpperCase(), userId);
  });

socket.on("join-room", ({ roomId, userId, userName, isSpectator = false, event, displayName, password }) => {
    const room = roomId.toUpperCase();
    if (!userName || typeof userName !== "string" || !userName.trim() || !userId || typeof userId !== "string" || !userId.trim()) {
      console.log(`❌ Không cho phép join-room với userName/userId rỗng hoặc không hợp lệ: '${userName}' '${userId}'`);
      return;
    }
    console.log(`👥 ${userName} (${userId}) joined room ${room} as player (socket.id: ${socket.id})`);
    socket.join(room);
    socket.data = socket.data || {};
    socket.data.room = room;
    socket.data.userName = userName;
    socket.data.userId = userId;

    if (!rooms[room]) rooms[room] = [];
    let isNewRoom = false;
    if (rooms[room].length === 0) {
      roomsMeta[room] = {
        event: event || "3x3",
        displayName: displayName || room,
        password: password || ""
      };
      isNewRoom = true;
      // Gán host là userId đầu tiên
      roomHosts[room] = userId;
      // Gán lượt chơi ban đầu là host
      roomTurns[room] = userId;
    } else {
      const roomPassword = roomsMeta[room]?.password || "";
      if (roomPassword && password !== roomPassword) {
        socket.emit("wrong-password", { message: "Sai mật khẩu phòng!" });
        return;
      }
    }
    if (rooms[room].length >= 2) {
      socket.emit("room-full", { message: "Phòng đã đủ 2 người chơi" });
      return;
    }

    if (!rooms[room].some(u => u.userId === userId)) {
      rooms[room].push({ userId, userName });
    }

    // Kiểm tra và dọn dẹp phòng nếu trống (sau khi join/leave)
    removeUserAndCleanup(room, undefined); // undefined để không xóa ai, chỉ kiểm tra phòng trống

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

    if (rooms[room].length === 1) {
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
      if (rooms[room].length === 2) {
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
    // Gửi tin nhắn cho tất cả user trong phòng
    io.to(room).emit("chat", { userId, userName, message });
  });

  socket.on("solve", ({ roomId, userId, userName, time }) => {
    const room = roomId.toUpperCase();
    // console.log(`🧩 ${userName} (${userId}) solved in ${time}ms`);
    // Gửi kết quả cho đối thủ
    socket.to(room).emit("opponent-solve", { userId, userName, time });

    // Quản lý lượt giải để gửi scramble tiếp theo
    if (!socket.server.solveCount) socket.server.solveCount = {};
    if (!socket.server.solveCount[room]) socket.server.solveCount[room] = 0;
    socket.server.solveCount[room]++;
    // Khi tổng số lượt giải là số chẵn (2,4,6,8,10) thì gửi scramble tiếp theo
    const totalSolves = socket.server.solveCount[room];
    if (totalSolves % 2 === 0) {
      const idx = totalSolves / 2;
      if (scrambles[room] && scrambles[room][idx]) {
        io.to(room).emit("scramble", { scramble: scrambles[room][idx], index: idx });
      }
    }
    // Đổi lượt chơi cho người còn lại
    if (rooms[room] && rooms[room].length === 2) {
      const userIds = rooms[room].map(u => u.userId);
      // Chuyển lượt cho người còn lại
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
    const userId = socket.data?.userId;
    if (room && rooms[room]) {
      rooms[room] = rooms[room].filter(u => u && u.userId !== userId && u.userId !== "");
      // Nếu host rời phòng, chọn người còn lại làm host mới
      if (roomHosts[room] === userId) {
        if (rooms[room].length > 0) {
          roomHosts[room] = rooms[room][0].userId;
        } else {
          delete roomHosts[room];
        }
      }
      // Nếu turnUserId rời phòng, chuyển lượt cho người còn lại (nếu còn)
      if (roomTurns[room] === userId) {
        if (rooms[room].length > 0) {
          roomTurns[room] = rooms[room][0].userId;
        } else {
          delete roomTurns[room];
        }
      }
      io.to(room).emit("room-users", { users: rooms[room], hostId: roomHosts[room] || null });
      io.to(room).emit("room-turn", { turnUserId: roomTurns[room] || null });
  // console.log("Current players in room", room, rooms[room]);
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
        delete roomsMeta[room]; // Xóa meta khi phòng trống
        console.log(`Room ${room} deleted from rooms object (empty).`);
      } else if (filteredUsers.length === 1) {
        if (socket.server.solveCount) socket.server.solveCount[room] = 0;
        const eventType = roomsMeta[room]?.event || "3x3";
        scrambles[room] = generateLocalScrambles(eventType);
        if (scrambles[room] && scrambles[room].length > 0) {
          io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
        }
        io.to(room).emit("room-reset");
        // Khi chỉ còn 1 người, set turn về cho host
        if (rooms[room].length === 1) {
          roomTurns[room] = roomHosts[room];
          io.to(room).emit("room-turn", { turnUserId: roomTurns[room] });
        }
        if (global.roomTimeouts) {
          if (global.roomTimeouts[room]) {
            clearTimeout(global.roomTimeouts[room]);
          }
          global.roomTimeouts[room] = setTimeout(() => {
            if (rooms[room] && rooms[room].length === 1) {
              console.log(`⏰ Phòng ${room} chỉ còn 1 người chơi sau disconnect, tự động xóa sau 5 phút.`);
              delete rooms[room];
              delete scrambles[room];
              if (socket.server.solveCount) delete socket.server.solveCount[room];
              delete global.roomTimeouts[room];
              delete roomHosts[room];
              delete roomTurns[room];
              io.to(room).emit("room-users", { users: [], hostId: null });
              io.to(room).emit("room-turn", { turnUserId: null });
            }
          }, 5 * 60 * 1000);
          // console.log(`⏳ Đặt timeout tự hủy phòng ${room} sau 5 phút vì chỉ còn 1 người chơi.`);
        }
      } else {
        if (global.roomTimeouts && global.roomTimeouts[room]) {
          clearTimeout(global.roomTimeouts[room]);
          delete global.roomTimeouts[room];
        }
      }
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
    const { roomId, userId, userName } = data;
    console.log('=== JOIN WAITING ROOM DEBUG ===');
    console.log('Full data received:', JSON.stringify(data, null, 2));
    console.log('Extracted values:', { roomId, userId, userName });
    console.log('userName type:', typeof userName, 'value:', userName);
    console.log('userName length:', userName ? userName.length : 'null/undefined');
    console.log('userName truthy:', !!userName);
    
    if (!waitingRooms[roomId]) {
      waitingRooms[roomId] = {
        roomId,
        players: [],
        roomCreator: userId, // Người đầu tiên join sẽ là chủ phòng
        gameStarted: false,
        createdAt: Date.now() // Thêm timestamp để track thời gian tạo
      };
      console.log('Created new waiting room:', roomId);
      
      // Set timeout xóa phòng sau 5 phút không bắt đầu
      setTimeout(() => {
        if (waitingRooms[roomId] && !waitingRooms[roomId].gameStarted) {
          console.log(`⏰ Waiting room ${roomId} deleted after 5 minutes of inactivity`);
          delete waitingRooms[roomId];
          io.emit("update-active-rooms");
        }
      }, 5 * 60 * 1000); // 5 phút
    }
    
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
      
      console.log('=== CREATING NEW PLAYER ===');
      console.log('Input userName:', userName);
      console.log('Input userName type:', typeof userName);
      console.log('Input userName length:', userName ? userName.length : 'null/undefined');
      console.log('newPlayer.name:', newPlayer.name);
      console.log('newPlayer.userName:', newPlayer.userName);
      console.log('Full newPlayer object:', JSON.stringify(newPlayer, null, 2));
      
      // Thêm player mới vào danh sách
      waitingRooms[roomId].players.push(newPlayer);
      console.log('Added new player:', newPlayer);
      
      // Sử dụng thuật toán sắp xếp thông minh
      reorganizeSeating(waitingRooms[roomId]);
    }
    
    console.log('=== WAITING ROOM STATE ===');
    console.log('Waiting room state:', JSON.stringify(waitingRooms[roomId], null, 2));
    console.log('Players in room:', waitingRooms[roomId].players.map(p => ({ id: p.id, name: p.name, team: p.team, position: p.position })));
    console.log('Players count:', waitingRooms[roomId].players.length);
    console.log('Team 1 players:', waitingRooms[roomId].players.filter(p => p.team === 'team1'));
    console.log('Team 2 players:', waitingRooms[roomId].players.filter(p => p.team === 'team2'));
    
    // Log chi tiết từng player
    console.log('=== DETAILED PLAYERS INFO ===');
    console.log('Total players in waiting room:', waitingRooms[roomId].players.length);
    waitingRooms[roomId].players.forEach((player, index) => {
      console.log(`Player ${index + 1}:`, {
        id: player.id,
        name: player.name,
        userName: player.userName,
        team: player.team,
        position: player.position,
        isReady: player.isReady,
        isObserver: player.isObserver
      });
    });
    
    // Log tất cả userName trong phòng
    console.log('=== ALL USERNAMES IN WAITING ROOM ===');
    const allUserNames = waitingRooms[roomId].players.map(p => p.name || p.userName || 'Unknown');
    console.log('UserNames list:', allUserNames);
    console.log('UserNames count:', allUserNames.length);
    
    // Log theo team
    const team1Names = waitingRooms[roomId].players
      .filter(p => p.team === 'team1')
      .map(p => p.name || p.userName || 'Unknown');
    const team2Names = waitingRooms[roomId].players
      .filter(p => p.team === 'team2')
      .map(p => p.name || p.userName || 'Unknown');
    
    console.log('Team 1 UserNames:', team1Names);
    console.log('Team 2 UserNames:', team2Names);
    console.log('Observer UserNames:', waitingRooms[roomId].players
      .filter(p => p.isObserver)
      .map(p => p.name || p.userName || 'Unknown'));
    
    socket.join(`waiting-${roomId}`);
    console.log('=== EMITTING WAITING ROOM UPDATE ===');
    console.log('Socket ID:', socket.id);
    console.log('Room ID:', `waiting-${roomId}`);
    console.log('Data being emitted:', JSON.stringify(waitingRooms[roomId], null, 2));
    
    // Log chi tiết data được emit
    console.log('=== EMIT DATA SUMMARY ===');
    console.log('Room ID:', waitingRooms[roomId].roomId);
    console.log('Players count:', waitingRooms[roomId].players.length);
    console.log('Players data:', waitingRooms[roomId].players.map(p => ({
      id: p.id,
      name: p.name,
      userName: p.userName,
      team: p.team,
      position: p.position
    })));
    
    console.log('Emitting waiting-room-updated to socket:', socket.id);
    socket.emit('waiting-room-updated', waitingRooms[roomId]);
    
    console.log('Emitting waiting-room-updated to room:', `waiting-${roomId}`);
    socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
    
    // Emit update active rooms để RoomTab hiển thị phòng chờ
    io.emit("update-active-rooms");
    
    console.log(`User ${userId} joined waiting room ${roomId}`);
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
      
      console.log(`User ${userId} (${player.role}) toggled ready status in waiting room ${roomId}`);
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
      // Chủ phòng không thể chuyển thành observer
      if (player.role === 'creator') {
        socket.emit('error', { message: 'Chủ phòng không thể chuyển thành người xem' });
        return;
      }
      
      // Toggle observer status
      player.isObserver = !player.isObserver;
      player.isReady = false;
      
      // Sử dụng thuật toán sắp xếp thông minh
      reorganizeSeating(waitingRooms[roomId]);
      
      console.log(`User ${userId} toggled observer status, room reorganized`);
      
      socket.emit('waiting-room-updated', waitingRooms[roomId]);
      socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
      
      console.log(`User ${userId} toggled observer status in waiting room ${roomId}`);
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
    
    // Chuyển hướng tất cả players sang room game
    socket.emit('game-started', { roomId, gameMode: '2vs2' });
    socket.to(`waiting-${roomId}`).emit('game-started', { roomId, gameMode: '2vs2' });
    
    console.log(`Game started in waiting room ${roomId}`);
    
    // Xóa waiting room sau khi bắt đầu game (delay 2 giây để đảm bảo clients đã redirect)
    setTimeout(() => {
      if (waitingRooms[roomId]) {
        console.log(`🗑️ Waiting room ${roomId} deleted after game started`);
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
      console.log(`Waiting room ${roomId} deleted (empty)`);
      io.emit("update-active-rooms");
      return;
    }
    
    // Nếu chủ phòng rời, chọn chủ phòng mới
    if (wasCreator) {
      const newCreator = waitingRooms[roomId].players[0]; // Chọn người đầu tiên làm chủ phòng mới
      if (newCreator) {
        newCreator.role = 'creator';
        waitingRooms[roomId].roomCreator = newCreator.id;
        console.log(`New creator assigned: ${newCreator.name} (${newCreator.id})`);
      }
    }
    
    // Sắp xếp lại chỗ ngồi thông minh
    reorganizeSeating(waitingRooms[roomId]);
    
    socket.leave(`waiting-${roomId}`);
    socket.emit('waiting-room-updated', waitingRooms[roomId]);
    socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
    
    console.log(`User ${userId} left waiting room ${roomId}`);
  });
  
  // Disconnect handling for waiting rooms
  socket.on('disconnect', () => {
    // Xử lý disconnect cho waiting rooms
    Object.keys(waitingRooms).forEach(roomId => {
      const playerIndex = waitingRooms[roomId].players.findIndex(p => p.id === socket.userId);
      if (playerIndex !== -1) {
        const leavingPlayer = waitingRooms[roomId].players[playerIndex];
        const wasCreator = leavingPlayer?.role === 'creator';
        
        waitingRooms[roomId].players.splice(playerIndex, 1);
        
        // Nếu phòng trống, xóa phòng
        if (waitingRooms[roomId].players.length === 0) {
          delete waitingRooms[roomId];
          console.log(`Waiting room ${roomId} deleted on disconnect`);
          io.emit("update-active-rooms");
          return;
        }
        
        // Nếu chủ phòng disconnect, chọn chủ phòng mới
        if (wasCreator) {
          const newCreator = waitingRooms[roomId].players[0];
          if (newCreator) {
            newCreator.role = 'creator';
            waitingRooms[roomId].roomCreator = newCreator.id;
            console.log(`New creator assigned on disconnect: ${newCreator.name} (${newCreator.id})`);
          }
        }
        
        // Sắp xếp lại chỗ ngồi thông minh
        reorganizeSeating(waitingRooms[roomId]);
        
        // Broadcast update
        socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
      }
    });
  });
});