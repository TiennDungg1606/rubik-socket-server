
const { Server } = require("socket.io");
const http = require("http");
const url = require("url");

const rooms = {}; // Quản lý người chơi trong từng room
const scrambles = {}; // Quản lý scramble cho từng room
function generateScramble() {
  const moves = ["U", "D", "L", "R", "F", "B"];
  const suffix = ["", "'", "2"];
  let scramble = [];
  let prev = "";
  let prev2 = "";
  for (let i = 0; i < 20; i++) {
    let m;
    do {
      m = moves[Math.floor(Math.random() * moves.length)];
    } while (m === prev || (prev2 && m[0] === prev2[0]));
    prev2 = prev;
    prev = m;
    scramble.push(m + suffix[Math.floor(Math.random() * 3)]);
  }
  return scramble.join(" ");
}

// Tạo HTTP server để phục vụ REST API và Socket.io
const server = http.createServer((req, res) => {
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
  if (parsed.pathname === "/active-rooms") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Object.keys(rooms)));
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

server.listen(3001, () => {
  console.log("🚀 Socket.io + REST server running on port 3001");
});

io.on("connection", (socket) => {
  console.log("🔌 Client connected");


  socket.on("join-room", ({ roomId, userName }) => {
    const room = roomId.toUpperCase();
    console.log(`👥 ${userName} joined room ${room} (socket.id: ${socket.id})`);
    socket.join(room);
    socket.data = socket.data || {};
    socket.data.room = room;
    socket.data.userName = userName;

    if (!rooms[room]) rooms[room] = [];
    if (!rooms[room].includes(userName)) {
      rooms[room].push(userName);
    }

    io.to(room).emit("room-users", rooms[room]);
    console.log("Current users in room", room, rooms[room]);
    // In ra toàn bộ rooms object để debug
    console.log("All rooms:", JSON.stringify(rooms));

    // Nếu phòng chưa có scramble thì tạo trước 5 scramble
    if (!scrambles[room]) {
      scrambles[room] = [];
      for (let i = 0; i < 5; i++) {
        scrambles[room].push(generateScramble());
      }
    }
    // Khi có người join, gửi scramble đầu tiên cho cả phòng nếu chưa gửi
    if (scrambles[room] && scrambles[room].length > 0) {
      io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
    }
  });

  socket.on("solve", ({ roomId, userName, time }) => {
    const room = roomId.toUpperCase();
    console.log(`🧩 ${userName} solved in ${time}ms`);
    // Gửi kết quả cho đối thủ
    socket.to(room).emit("opponent-solve", { userName, time });

    // Quản lý lượt giải để gửi scramble tiếp theo
    // Tạo biến lưu số lượt giải của từng phòng
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
  });


  // Relay all WebRTC signaling messages (simple-peer expects 'signal')
  socket.on("signal", ({ roomId, userName, signal }) => {
    const room = roomId.toUpperCase();
    // Gửi cho tất cả client khác trong phòng
    socket.to(room).emit("signal", { userName, signal });
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected");
    const room = socket.data?.room;
    const userName = socket.data?.userName;
    if (room && rooms[room]) {
      // Loại bỏ userName và mọi giá trị null/undefined/"" khỏi mảng
      rooms[room] = rooms[room].filter(u => u && u !== userName && u !== "");
      io.to(room).emit("room-users", rooms[room]);
      console.log("Current users in room", room, rooms[room]);
      // Lọc triệt để trước khi kiểm tra xóa phòng
      const filteredUsers = rooms[room].filter(u => u);
      if (filteredUsers.length === 0) {
        delete rooms[room];
        delete scrambles[room];
        if (socket.server.solveCount) delete socket.server.solveCount[room];
        console.log(`Room ${room} deleted from rooms object (empty).`);
      }
    }
    // Kiểm tra và xóa phòng rỗng ("") nếu chỉ chứa null/""
    if (rooms[""]) {
      const filteredEmptyRoom = rooms[""].filter(u => u);
      if (filteredEmptyRoom.length === 0) {
        delete rooms[""];
        delete scrambles[""];
        if (socket.server.solveCount) delete socket.server.solveCount[""];
        console.log('Room "" deleted from rooms object (empty).');
      }
    }
  });
});