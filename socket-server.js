
const { Server } = require("socket.io");
const http = require("http");
const url = require("url");

const rooms = {}; // Quản lý người chơi trong từng room

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
  });

  socket.on("solve", ({ roomId, userName, time }) => {
    const room = roomId.toUpperCase();
    console.log(`🧩 ${userName} solved in ${time}ms`);
    // Gửi kết quả cho đối thủ
    socket.to(room).emit("opponent-solve", { userName, time });
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
    if (room && userName && rooms[room]) {
      // Loại bỏ userName và mọi giá trị null/undefined khỏi mảng
      rooms[room] = rooms[room].filter(u => u && u !== userName);
      io.to(room).emit("room-users", rooms[room]);
      console.log("Current users in room", room, rooms[room]);
      // Xóa key nếu mảng rỗng (không còn user thực)
      if (rooms[room].length === 0) {
        delete rooms[room];
        console.log(`Room ${room} deleted from rooms object (empty).`);
      }
    }
  });
});