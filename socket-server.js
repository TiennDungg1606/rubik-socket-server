
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

// Quản lý phòng game 2vs2 (tách biệt với 1vs1)
const gameRooms2vs2 = {}; // Quản lý người chơi trong từng room 2vs2
const scrambles2vs2 = {}; // Quản lý scramble cho từng room 2vs2
const roomsMeta2vs2 = {}; // Quản lý meta phòng 2vs2: event, displayName, password
const roomHosts2vs2 = {}; // Lưu userId chủ phòng cho từng room 2vs2
const roomTurns2vs2 = {}; // Lưu userId người được quyền giải (turn) cho từng room 2vs2

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

// Hàm xử lý join room cho 1vs1 (logic cũ)
function handleJoin1vs1GameRoom(socket, room, userId, userName, event, displayName, password) {
  socket.join(room);
  socket.data = socket.data || {};
  socket.data.room = room;
  socket.data.userName = userName;
  socket.data.userId = userId;
  socket.data.gameMode = '1vs1';

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
  console.log("All 1vs1 rooms:", JSON.stringify(rooms));

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
    if (global.roomTimeouts[room]) {
      clearTimeout(global.roomTimeouts[room]);
    }
    global.roomTimeouts[room] = setTimeout(() => {
      if (rooms[room] && rooms[room].length === 1) {
        console.log(`⏰ Phòng 1vs1 ${room} chỉ có 1 người chơi sau 5 phút, tự động xóa.`);
        delete rooms[room];
        delete scrambles[room];
        if (socket.server.solveCount) delete socket.server.solveCount[room];
        delete global.roomTimeouts[room];
        delete roomHosts[room];
        delete roomsMeta[room]; // Xóa meta khi phòng trống
        io.to(room).emit("room-users", { users: [], hostId: null });
      }
    }, 5 * 60 * 1000);
  } else {
    if (global.roomTimeouts[room]) {
      clearTimeout(global.roomTimeouts[room]);
      delete global.roomTimeouts[room];
      console.log(`❌ Hủy timeout tự hủy phòng 1vs1 ${room} vì đã có thêm người chơi.`);
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
}

// Hàm xử lý join room cho 2vs2 (logic mới)
function handleJoin2vs2GameRoom(socket, room, userId, userName, event, displayName, password) {
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
}

// Hàm xử lý solve cho 1vs1 (logic cũ)
function handleSolve1vs1(room, userId, userName, time) {
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
}

// Hàm xử lý solve cho 2vs2 (logic mới)
function handleSolve2vs2(room, userId, userName, time) {
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
}

// Hàm xử lý disconnect cho 1vs1 (logic cũ)
function handleDisconnect1vs1(room, userId) {
  if (rooms[room]) {
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
      if (socket.server.solveCount) delete socket.server.solveCount[room];
      if (global.roomTimeouts && global.roomTimeouts[room]) {
        clearTimeout(global.roomTimeouts[room]);
        delete global.roomTimeouts[room];
      }
      delete roomHosts[room];
      delete roomTurns[room];
      delete roomsMeta[room]; // Xóa meta khi phòng trống
      console.log(`Room 1vs1 ${room} deleted from rooms object (empty).`);
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
            console.log(`⏰ Phòng 1vs1 ${room} chỉ còn 1 người chơi sau disconnect, tự động xóa sau 5 phút.`);
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
      }
    } else {
      if (global.roomTimeouts && global.roomTimeouts[room]) {
        clearTimeout(global.roomTimeouts[room]);
        delete global.roomTimeouts[room];
      }
    }
  }
}

// Hàm xử lý disconnect cho 2vs2 (logic mới)
function handleDisconnect2vs2(room, userId) {
  if (gameRooms2vs2[room]) {
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
}

// Hàm xử lý leave room cho 2vs2 (logic mới)
function handleLeaveRoom2vs2(room, userId) {
  if (gameRooms2vs2[room]) {
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
            console.log(`⏰ Phòng 2vs2 ${room} chỉ còn 1 người chơi sau leave-room, tự động xóa sau 5 phút.`);
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
    res.writeHead(200, { "Content-Type": "application/json" });
    
    // Kiểm tra cả 1vs1 và 2vs2 rooms
    if (roomId && rooms[roomId]) {
      res.end(JSON.stringify(rooms[roomId]));
    } else if (roomId && gameRooms2vs2[roomId]) {
      res.end(JSON.stringify(gameRooms2vs2[roomId]));
    } else {
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
    // Trả về danh sách phòng 1vs1 kèm meta và số lượng user
    const result1vs1 = Object.keys(rooms).map(roomId => ({
      roomId,
      meta: roomsMeta[roomId] || {},
      usersCount: Array.isArray(rooms[roomId]) ? rooms[roomId].length : 0
    }));
    
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
    
    // Gộp cả 3 loại phòng: 1vs1, 2vs2, và waiting rooms
    const allRooms = [...result1vs1, ...result2vs2, ...waitingRoomResults];
    res.end(JSON.stringify(allRooms));
    return;
  }

  // REST endpoint: /room-meta/:roomId
  if (parsed.pathname && parsed.pathname.startsWith("/room-meta/")) {
    const roomId = parsed.pathname.split("/room-meta/")[1]?.toUpperCase();
    res.writeHead(200, { "Content-Type": "application/json" });
    
    // Kiểm tra cả 1vs1 và 2vs2 rooms
    const meta1vs1 = roomsMeta[roomId] || {};
    const meta2vs2 = roomsMeta2vs2[roomId] || {};
    const waitingMeta = waitingRooms[roomId] ? {
      gameMode: '2vs2',
      event: '3x3',
      displayName: waitingRooms[roomId].displayName || roomId,
      password: waitingRooms[roomId].password || null,
      isWaitingRoom: true
    } : {};
    
    // Trả về meta từ phòng nào có dữ liệu
    const finalMeta = meta1vs1.event ? meta1vs1 : (meta2vs2.event ? meta2vs2 : waitingMeta);
    res.end(JSON.stringify(finalMeta));
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
    const room = roomId?.toUpperCase();
    const gameMode = socket.data?.gameMode || '1vs1';
    
    if (gameMode === '2vs2') {
      handleLeaveRoom2vs2(room, userId);
    } else {
      removeUserAndCleanup(room, userId);
    }
  });

socket.on("join-room", ({ roomId, userId, userName, isSpectator = false, event, displayName, password, gameMode }) => {
    const room = roomId.toUpperCase();
    if (!userName || typeof userName !== "string" || !userName.trim() || !userId || typeof userId !== "string" || !userId.trim()) {
      console.log(`❌ Không cho phép join-room với userName/userId rỗng hoặc không hợp lệ: '${userName}' '${userId}'`);
      return;
    }

    // Tách biệt logic cho 2vs2 và 1vs1
    if (gameMode === '2vs2') {
      console.log(`🎮 ${userName} (${userId}) joined 2vs2 game room ${room} (socket.id: ${socket.id})`);
      handleJoin2vs2GameRoom(socket, room, userId, userName, event, displayName, password);
    } else {
      console.log(`🎮 ${userName} (${userId}) joined 1vs1 game room ${room} (socket.id: ${socket.id})`);
      handleJoin1vs1GameRoom(socket, room, userId, userName, event, displayName, password);
    }
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
    const gameMode = socket.data?.gameMode || '1vs1';
    
    // console.log(`🧩 ${userName} (${userId}) solved in ${time}ms (${gameMode})`);
    // Gửi kết quả cho đối thủ
    socket.to(room).emit("opponent-solve", { userId, userName, time });

    // Tách biệt logic cho 2vs2 và 1vs1
    if (gameMode === '2vs2') {
      handleSolve2vs2(room, userId, userName, time);
    } else {
      handleSolve1vs1(room, userId, userName, time);
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
  const gameMode = socket.data?.gameMode || '1vs1';
  
  if (gameMode === '2vs2') {
    // Sinh lại 5 scramble mới cho phòng 2vs2
    const eventType = roomsMeta2vs2[room]?.event || "3x3";
    scrambles2vs2[room] = generateLocalScrambles(eventType);
    // Reset solveCount về 0
    if (socket.server.solveCount) socket.server.solveCount[room] = 0;
    io.to(room).emit("rematch-accepted");
    if (scrambles2vs2[room] && scrambles2vs2[room].length > 0) {
      io.to(room).emit("scramble", { scramble: scrambles2vs2[room][0], index: 0 });
    }
  } else {
    // Sinh lại 5 scramble mới cho phòng 1vs1
    const eventType = roomsMeta[room]?.event || "3x3";
    scrambles[room] = generateLocalScrambles(eventType);
    // Reset solveCount về 0
    if (socket.server.solveCount) socket.server.solveCount[room] = 0;
    io.to(room).emit("rematch-accepted");
    if (scrambles[room] && scrambles[room].length > 0) {
      io.to(room).emit("scramble", { scramble: scrambles[room][0], index: 0 });
    }
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
    const gameMode = socket.data?.gameMode || '1vs1';
    
    if (room) {
      if (gameMode === '2vs2') {
        handleDisconnect2vs2(room, userId);
      } else {
        handleDisconnect1vs1(room, userId);
      }
    }
    
    // Cleanup empty room
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
    
    console.log('=== SERVER RECEIVED JOIN-WAITING-ROOM ===');
    console.log('Data received:', data);
    console.log('Room ID:', roomId);
    console.log('User ID:', userId);
    console.log('User Name:', userName);

    
    if (!waitingRooms[roomId]) {
      console.log('Creating new waiting room:', roomId);
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
      console.log('Updating existing waiting room:', roomId);
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
    

    
   
    
    socket.join(`waiting-${roomId}`);
    console.log('Socket joined room:', `waiting-${roomId}`);
    
    console.log('=== EMITTING WAITING-ROOM-UPDATED ===');
    console.log('Room data to emit:', waitingRooms[roomId]);
    console.log('Players count:', waitingRooms[roomId].players.length);
    console.log('Players:', waitingRooms[roomId].players);
    
    socket.emit('waiting-room-updated', waitingRooms[roomId]);
    socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
    
    console.log('Emitted waiting-room-updated to socket and room');
    
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
    
    socket.leave(`waiting-${roomId}`);
    socket.emit('waiting-room-updated', waitingRooms[roomId]);
    socket.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
    

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