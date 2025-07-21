
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

  // --- WebRTC Signaling Events ---
  // Notify others in the room that this client is ready for peer connection
  socket.on("ready-for-peer", ({ roomId, userName }) => {
    const room = roomId.toUpperCase();
    // Broadcast to everyone else in the room
    socket.to(room).emit("ready-for-peer", { userName });
  });

  // Relay peer-initiate event (offer/initiate connection)
  socket.on("peer-initiate", ({ roomId, signal, from }) => {
    const room = roomId.toUpperCase();
    // Send to everyone else in the room
    socket.to(room).emit("peer-initiate", { signal, from });
  });

  // Relay peer-signal event (ICE candidates, answers, etc.)
  socket.on("peer-signal", ({ roomId, signal, from }) => {
    const room = roomId.toUpperCase();
    // Send to everyone else in the room
    socket.to(room).emit("peer-signal", { signal, from });
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected");
    const room = socket.data?.room;
    const userName = socket.data?.userName;
    if (room && userName && rooms[room]) {
      rooms[room] = rooms[room].filter(u => u !== userName);
      io.to(room).emit("room-users", rooms[room]);
      console.log("Current users in room", room, rooms[room]);
    }
  });
});