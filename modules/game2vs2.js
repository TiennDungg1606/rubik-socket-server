// Module xử lý logic 2vs2
const { generateWcaScramble, generate2x2Scramble, generate3x3Scramble, generate4x4Scramble, generatePyraminxScramble } = require("../scramble.js");

// Global objects cho 2vs2
const gameRooms2vs2 = {}; // Quản lý người chơi trong từng room 2vs2
const scrambles2vs2 = {}; // Quản lý scramble cho từng room 2vs2
const roomsMeta2vs2 = {}; // Quản lý meta phòng 2vs2: event, displayName, password
const roomHosts2vs2 = {}; // Lưu userId chủ phòng cho từng room 2vs2
const roomTurns2vs2 = {}; // Lưu userId người được quyền giải (turn) cho từng room 2vs2

// Quản lý phòng chờ 2vs2
const waitingRooms = {}; // { roomId: { players: [], roomCreator: '', gameStarted: false } }

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

// Hàm xử lý join room cho 2vs2
function handleJoin2vs2GameRoom(io, socket, room, userId, userName, event, displayName, password) {
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
    if (global.roomTimeouts && global.roomTimeouts[room]) {
      clearTimeout(global.roomTimeouts[room]);
    }
    global.roomTimeouts[room] = setTimeout(() => {
      if (gameRooms2vs2[room] && gameRooms2vs2[room].length === 1) {
        console.log(`⏰ Phòng 2vs2 ${room} chỉ có 1 người chơi sau 5 phút, tự động xóa.`);
        delete gameRooms2vs2[room];
        delete scrambles2vs2[room];
        if (global.solveCount) delete global.solveCount[room];
        delete global.roomTimeouts[room];
        delete roomHosts2vs2[room];
        delete roomsMeta2vs2[room]; // Xóa meta khi phòng trống
        io.to(room).emit("room-users", { users: [], hostId: null });
      }
    }, 5 * 60 * 1000);
  } else {
    if (global.roomTimeouts && global.roomTimeouts[room]) {
      clearTimeout(global.roomTimeouts[room]);
      delete global.roomTimeouts[room];
      console.log(`❌ Hủy timeout tự hủy phòng 2vs2 ${room} vì đã có thêm người chơi.`);
    }
    if (gameRooms2vs2[room].length >= 2) {
      if (global.solveCount) global.solveCount[room] = 0;
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

// Hàm xử lý solve cho 2vs2
function handleSolve2vs2(io, room, userId, userName, time) {
  // Quản lý lượt giải để gửi scramble tiếp theo cho 2vs2
  if (!global.solveCount) global.solveCount = {};
  if (!global.solveCount[room]) global.solveCount[room] = 0;
  global.solveCount[room]++;
  
  // Logic 2vs2: có thể có nhiều người chơi hơn, cần logic khác
  const totalSolves = global.solveCount[room];
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

// Hàm xử lý disconnect cho 2vs2
function handleDisconnect2vs2(io, room, userId) {
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
      if (global.solveCount) delete global.solveCount[room];
      if (global.roomTimeouts && global.roomTimeouts[room]) {
        clearTimeout(global.roomTimeouts[room]);
        delete global.roomTimeouts[room];
      }
      delete roomHosts2vs2[room];
      delete roomTurns2vs2[room];
      delete roomsMeta2vs2[room]; // Xóa meta khi phòng trống
      console.log(`Room 2vs2 ${room} deleted from gameRooms2vs2 object (empty).`);
    } else if (filteredUsers.length === 1) {
      if (global.solveCount) global.solveCount[room] = 0;
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
            if (global.solveCount) delete global.solveCount[room];
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

// Hàm xử lý leave room cho 2vs2
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
    
    const filteredUsers = gameRooms2vs2[room].filter(u => u);
    if (filteredUsers.length === 0) {
      delete gameRooms2vs2[room];
      delete scrambles2vs2[room];
      if (global.solveCount) delete global.solveCount[room];
      if (global.roomTimeouts && global.roomTimeouts[room]) {
        clearTimeout(global.roomTimeouts[room]);
        delete global.roomTimeouts[room];
      }
      delete roomHosts2vs2[room];
      delete roomTurns2vs2[room];
      delete roomsMeta2vs2[room]; // Xóa meta khi phòng trống
      console.log(`Room 2vs2 ${room} deleted from gameRooms2vs2 object (empty).`);
    } else if (filteredUsers.length === 1) {
      if (global.solveCount) global.solveCount[room] = 0;
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
            if (global.solveCount) delete global.solveCount[room];
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

// Hàm xử lý rematch cho 2vs2
function handleRematch2vs2(io, room) {
  // Sinh lại 5 scramble mới cho phòng 2vs2
  const eventType = roomsMeta2vs2[room]?.event || "3x3";
  scrambles2vs2[room] = generateLocalScrambles(eventType);
  // Reset solveCount về 0
  if (global.solveCount) global.solveCount[room] = 0;
  io.to(room).emit("rematch-accepted");
  if (scrambles2vs2[room] && scrambles2vs2[room].length > 0) {
    io.to(room).emit("scramble", { scramble: scrambles2vs2[room][0], index: 0 });
  }
}

// ===== WAITING ROOM 2VS2 LOGIC =====

// Join waiting room
function handleJoinWaitingRoom(io, socket, data) {
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
}

// Leave waiting room
function handleLeaveWaitingRoom(io, socket, data) {
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
}

// Toggle ready status
function handleToggleReady(io, socket, data) {
  const { roomId, userId } = data;
  
  if (waitingRooms[roomId]) {
    const player = waitingRooms[roomId].players.find(p => p.userId === userId);
    if (player) {
      player.isReady = !player.isReady;
      
      // Emit update cho tất cả user trong waiting room
      io.to(`waiting-${roomId}`).emit('waiting-room-updated', waitingRooms[roomId]);
    }
  }
}

// Toggle observer status
function handleToggleObserver(io, socket, data) {
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
}

// Start game
function handleStartGame(io, socket, data) {
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
}

// Chat trong waiting room
function handleWaitingRoomChat(io, socket, data) {
  const { roomId, userId, userName, message } = data;
  
  if (waitingRooms[roomId]) {
    // Gửi tin nhắn cho tất cả user khác trong waiting room (không gửi cho chính người gửi)
    socket.to(`waiting-${roomId}`).emit('chat', { userId, userName, message });
  }
}

// Swap seat request
function handleSwapSeatRequest(io, socket, data) {
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
}

// Swap seat response
function handleSwapSeatResponse(io, socket, data) {
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
}

// API endpoints cho 2vs2
function getActiveRooms2vs2() {
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
  return [...result2vs2, ...waitingRoomResults];
}

function getRoomUsers2vs2(roomId) {
  return gameRooms2vs2[roomId] || [];
}

function getRoomMeta2vs2(roomId) {
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
  return meta2vs2.event ? meta2vs2 : waitingMeta;
}

// Create waiting room
function createWaitingRoom(roomId, gameMode, event, displayName, password) {
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
  }
}

module.exports = {
  // Game room functions
  handleJoin2vs2GameRoom,
  handleSolve2vs2,
  handleDisconnect2vs2,
  handleLeaveRoom2vs2,
  handleRematch2vs2,
  
  // Waiting room functions
  handleJoinWaitingRoom,
  handleLeaveWaitingRoom,
  handleToggleReady,
  handleToggleObserver,
  handleStartGame,
  handleWaitingRoomChat,
  handleSwapSeatRequest,
  handleSwapSeatResponse,
  createWaitingRoom,
  
  // API functions
  getActiveRooms2vs2,
  getRoomUsers2vs2,
  getRoomMeta2vs2
};
