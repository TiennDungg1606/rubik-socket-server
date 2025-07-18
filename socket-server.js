// socket-server.js

const { Server } = require("socket.io");

// Tạo server Socket.io ở cổng 3001
const io = new Server(3001, {
  cors: {
    origin: "*", // Cho phép mọi domain kết nối (dễ test)
  },
});

const rooms = {}; // Quản lý người chơi trong từng room

io.on("connection", (socket) => {
  console.log("🔌 Client connected");

  socket.on("join-room", ({ roomId, userName }) => {
    console.log(`👥 ${userName} joined room ${roomId}`);
    socket.join(roomId);

    if (!rooms[roomId]) rooms[roomId] = [];
    if (!rooms[roomId].includes(userName)) {
      rooms[roomId].push(userName);
    }

    // Gửi danh sách user trong phòng cho tất cả client trong room
    io.to(roomId).emit("room-users", rooms[roomId]);
  });

  socket.on("solve", ({ roomId, userName, time }) => {
    console.log(`🧩 ${userName} solved in ${time}ms`);
    // Gửi kết quả cho đối thủ
    socket.to(roomId).emit("opponent-solve", { userName, time });
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected");
    // Không xóa user khỏi room ở đây để đơn giản, có thể thêm nếu cần
  });
});