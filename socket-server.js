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
    const room = roomId.toUpperCase();
    console.log(`👥 ${userName} joined room ${room}`);
    socket.join(room);

    if (!rooms[room]) rooms[room] = [];
    if (!rooms[room].includes(userName)) {
      rooms[room].push(userName);
    }

    // Gửi danh sách user trong phòng cho tất cả client trong room
    io.to(room).emit("room-users", rooms[room]);
  });

  socket.on("solve", ({ roomId, userName, time }) => {
    const room = roomId.toUpperCase();
    console.log(`🧩 ${userName} solved in ${time}ms`);
    // Gửi kết quả cho đối thủ
    socket.to(room).emit("opponent-solve", { userName, time });
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected");
    // Không xóa user khỏi room ở đây để đơn giản, có thể thêm nếu cần
  });
});