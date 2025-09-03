
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
  // REST endpoint: /active-rooms
  // REST endpoint: /active-rooms
  if (parsed.pathname === "/active-rooms") {
    res.writeHead(200, { "Content-Type": "application/json" });
    // Trả về danh sách phòng kèm meta và số lượng user
    const result = Object.keys(rooms).map(roomId => ({
      roomId,
      meta: roomsMeta[roomId] || {},
      usersCount: Array.isArray(rooms[roomId]) ? rooms[roomId].length : 0
    }));
    res.end(JSON.stringify(result));
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
});