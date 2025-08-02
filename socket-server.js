
const { Server } = require("socket.io");
const http = require("http");
const url = require("url");
const https = require("https");

const rooms = {}; // Quản lý người chơi trong từng room
const scrambles = {}; // Quản lý scramble cho từng room

// Function để lấy scramble từ scramble.cubing.net
async function fetchScrambleFromCubingNet() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'scramble.cubing.net',
      port: 443,
      path: '/api/v0/scramble/333',
      method: 'GET'
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result.scramble);
        } catch (error) {
          console.error('Error parsing scramble response:', error);
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      console.error('Error fetching scramble:', error);
      reject(error);
    });

    req.end();
  });
}

// Function để lấy 5 scramble từ scramble.cubing.net
async function fetchScramblesFromCubingNet() {
  const scramblePromises = [];
  for (let i = 0; i < 5; i++) {
    scramblePromises.push(fetchScrambleFromCubingNet());
  }
  
  try {
    const scrambles = await Promise.all(scramblePromises);
    console.log('✅ Fetched 5 scrambles from scramble.cubing.net:', scrambles);
    return scrambles;
  } catch (error) {
    console.error('❌ Error fetching scrambles from cubing.net, falling back to local generation:', error);
    // Fallback to local generation if API fails
    return generateLocalScrambles();
  }
}

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

// Function để tạo scramble local (fallback)
function generateLocalScrambles() {
  const localScrambles = [];
  for (let i = 0; i < 5; i++) {
    localScrambles.push(generateScramble());
  }
  return localScrambles;
}

// Tạo HTTP server để phục vụ REST API và Socket.io
const allowedOrigin = "https://rubik-app-buhb.vercel.app";
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
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


  // Map lưu timeout tự hủy phòng nếu chỉ có 1 người (chủ phòng) sau 5 phút
  if (!global.roomTimeouts) global.roomTimeouts = {};
  const roomTimeouts = global.roomTimeouts;

  socket.on("join-room", ({ roomId, userId, userName }) => {
    const room = roomId.toUpperCase();
    // Không cho phép userName hoặc userId rỗng hoặc không hợp lệ
    if (!userName || typeof userName !== "string" || !userName.trim() || !userId || typeof userId !== "string" || !userId.trim()) {
      console.log(`❌ Không cho phép join-room với userName/userId rỗng hoặc không hợp lệ: '${userName}' '${userId}'`);
      return;
    }
    console.log(`👥 ${userName} (${userId}) joined room ${room} (socket.id: ${socket.id})`);
    socket.join(room);
    socket.data = socket.data || {};
    socket.data.room = room;
    socket.data.userName = userName;
    socket.data.userId = userId;

    if (!rooms[room]) rooms[room] = [];
    // Kiểm tra trùng userId
    if (!rooms[room].some(u => u.userId === userId)) {
      rooms[room].push({ userId, userName });
    }

    io.to(room).emit("room-users", rooms[room]);
    console.log("Current users in room", room, rooms[room]);
    // In ra toàn bộ rooms object để debug
    console.log("All rooms:", JSON.stringify(rooms));

    // Nếu phòng chưa có scramble thì lấy từ scramble.cubing.net
    if (!scrambles[room]) {
      scrambles[room] = [];
      // Lấy 5 scramble từ scramble.cubing.net
      fetchScramblesFromCubingNet().then(scrambleList => {
        scrambles[room] = scrambleList;
        // Gửi scramble đầu tiên cho cả phòng
        if (scrambles[room] && scrambles[room].length > 0) {
          io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
        }
      }).catch(error => {
        console.error('Error fetching scrambles for room', room, error);
        // Fallback to local generation
        for (let i = 0; i < 5; i++) {
          scrambles[room].push(generateScramble());
        }
        // Gửi scramble đầu tiên cho cả phòng
        if (scrambles[room] && scrambles[room].length > 0) {
          io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
        }
      });
    }
    // Gửi scramble đầu tiên nếu đã có sẵn
    if (scrambles[room] && scrambles[room].length > 0) {
      io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
    }

    // --- Logic tự hủy phòng nếu chỉ có 1 người là chủ phòng sau 5 phút ---
    // Nếu phòng chỉ có 1 người, đặt timeout 5 phút
    if (rooms[room].length === 1) {
      // Nếu đã có timeout cũ thì clear
      if (roomTimeouts[room]) {
        clearTimeout(roomTimeouts[room]);
      }
      // Đặt timeout mới
      roomTimeouts[room] = setTimeout(() => {
        // Kiểm tra lại lần cuối: nếu phòng vẫn chỉ có 1 người
        if (rooms[room] && rooms[room].length === 1) {
          console.log(`⏰ Phòng ${room} chỉ có 1 người sau 5 phút, tự động xóa.`);
          delete rooms[room];
          delete scrambles[room];
          if (socket.server.solveCount) delete socket.server.solveCount[room];
          delete roomTimeouts[room];
          io.to(room).emit("room-users", []);
        }
      }, 5 * 60 * 1000); // 5 phút
      console.log(`⏳ Đặt timeout tự hủy phòng ${room} sau 5 phút nếu không có ai vào thêm.`);
    } else {
      // Nếu có thêm người vào, hủy timeout tự hủy phòng
      if (roomTimeouts[room]) {
        clearTimeout(roomTimeouts[room]);
        delete roomTimeouts[room];
        console.log(`❌ Hủy timeout tự hủy phòng ${room} vì đã có thêm người.`);
      }
    }
    // --- END ---
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
    console.log(`🧩 ${userName} (${userId}) solved in ${time}ms`);
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
  });



  // Relay camera toggle event to other users in the room
  socket.on("user-cam-toggle", (data) => {
    if (!data || !data.roomId) return;
    const room = data.roomId.toUpperCase();
    // Gửi cho tất cả client khác trong phòng
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
      // Loại bỏ userId và mọi giá trị null/undefined/"" khỏi mảng
      rooms[room] = rooms[room].filter(u => u && u.userId !== userId && u.userId !== "");
      io.to(room).emit("room-users", rooms[room]);
      console.log("Current users in room", room, rooms[room]);
      // Lọc triệt để trước khi kiểm tra xóa phòng
      const filteredUsers = rooms[room].filter(u => u);
      if (filteredUsers.length === 0) {
        delete rooms[room];
        delete scrambles[room];
        if (socket.server.solveCount) delete socket.server.solveCount[room];
        if (global.roomTimeouts && global.roomTimeouts[room]) {
          clearTimeout(global.roomTimeouts[room]);
          delete global.roomTimeouts[room];
        }
        console.log(`Room ${room} deleted from rooms object (empty).`);
      } else if (filteredUsers.length === 1) {
        // Nếu chỉ còn 1 người sau khi disconnect, đặt lại timeout tự hủy phòng
        if (global.roomTimeouts) {
          if (global.roomTimeouts[room]) {
            clearTimeout(global.roomTimeouts[room]);
          }
          global.roomTimeouts[room] = setTimeout(() => {
            if (rooms[room] && rooms[room].length === 1) {
              console.log(`⏰ Phòng ${room} chỉ còn 1 người sau disconnect, tự động xóa sau 5 phút.`);
              delete rooms[room];
              delete scrambles[room];
              if (socket.server.solveCount) delete socket.server.solveCount[room];
              delete global.roomTimeouts[room];
              io.to(room).emit("room-users", []);
            }
          }, 5 * 60 * 1000);
          console.log(`⏳ Đặt timeout tự hủy phòng ${room} sau 5 phút vì chỉ còn 1 người.`);
        }
      } else {
        // Nếu còn nhiều hơn 1 người, hủy timeout tự hủy phòng nếu có
        if (global.roomTimeouts && global.roomTimeouts[room]) {
          clearTimeout(global.roomTimeouts[room]);
          delete global.roomTimeouts[room];
        }
      }
    }
    // Kiểm tra và xóa phòng rỗng ("") nếu chỉ chứa null/""
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
        console.log('Room "" deleted from rooms object (empty).');
      }
    }
  });
});