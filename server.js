const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*", // Разрешаем все origins для Render
    methods: ["GET", "POST"]
  }
});

// Раздаем статические файлы
app.use(express.static(__dirname));
app.use(express.json());

// Хранилище комнат
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`🔥 Новый игрок подключился: ${socket.id}`);
  
  // Присоединение к комнате
  socket.on('joinCustomRoom', (data) => {
    console.log(`🎮 ${socket.id} пытается зайти в комнату:`, data?.room);
    
    if (!data || !data.room || !data.pass) {
      socket.emit('errorMsg', 'Введите ID комнаты и пароль');
      return;
    }
    
    const { room, pass } = data;
    const roomKey = room.trim().toLowerCase();

    if (!rooms.has(roomKey)) {
      // Создаем новую комнату
      rooms.set(roomKey, {
        password: pass,
        players: [socket.id],
        ready: [],
        airstrikes: new Map([[socket.id, true]]),
        gameState: {
          started: false,
          turn: null,
          player1: socket.id,
          player2: null
        }
      });
      
      socket.join(roomKey);
      socket.roomName = roomKey;
      socket.playerId = socket.id;
      
      console.log(`✅ Комната "${roomKey}" создана`);
      socket.emit('waiting', 'Комната создана! Ждем второго игрока...');
      
    } else {
      // Присоединяемся к существующей комнате
      const currentRoom = rooms.get(roomKey);
      
      if (currentRoom.password !== pass) {
        socket.emit('errorMsg', '❌ Неверный пароль!');
        return;
      }
      
      if (currentRoom.players.length >= 2) {
        socket.emit('errorMsg', '❌ Комната уже заполнена!');
        return;
      }

      // Добавляем второго игрока
      currentRoom.players.push(socket.id);
      currentRoom.airstrikes.set(socket.id, true);
      currentRoom.gameState.player2 = socket.id;
      
      socket.join(roomKey);
      socket.roomName = roomKey;
      socket.playerId = socket.id;
      
      console.log(`✅ Игрок ${socket.id} присоединился к комнате "${roomKey}"`);
      
      // Уведомляем обоих игроков
      io.to(roomKey).emit('waiting', '✅ Оба игрока в комнате! Расставляйте корабли.');
      io.to(roomKey).emit('playersCount', { count: 2 });
    }
  });

  // Игрок готов
  socket.on('playerReady', () => {
    const roomName = socket.roomName;
    if (!roomName || !rooms.has(roomName)) {
      socket.emit('errorMsg', 'Комната не найдена');
      return;
    }

    const currentRoom = rooms.get(roomName);
    
    // Добавляем игрока в список готовых
    if (!currentRoom.ready.includes(socket.id)) {
      currentRoom.ready.push(socket.id);
    }

    console.log(`🎯 Игрок ${socket.id} готов в комнате "${roomName}"`);

    // Если оба игрока готовы, начинаем игру
    if (currentRoom.players.length === 2 && 
        currentRoom.ready.length === 2 &&
        !currentRoom.gameState.started) {
      
      // Выбираем случайного игрока для первого хода
      const firstPlayerIndex = Math.random() < 0.5 ? 0 : 1;
      const firstPlayerId = currentRoom.players[firstPlayerIndex];
      const secondPlayerId = currentRoom.players[1 - firstPlayerIndex];
      
      currentRoom.gameState.turn = firstPlayerId;
      currentRoom.gameState.started = true;
      
      console.log(`🚀 Игра началась в комнате "${roomName}"`);
      console.log(`➡️ Первый ход у: ${firstPlayerId}`);
      
      // Отправляем игрокам информацию о начале игры
      io.to(firstPlayerId).emit('gameStart', { 
        canMove: true,
        airstrikeAvailable: true,
        message: '🎯 ВАШ ХОД! Авиаудар доступен (кнопка A)'
      });
      
      io.to(secondPlayerId).emit('gameStart', { 
        canMove: false,
        airstrikeAvailable: true,
        message: '⏳ ХОД ПРОТИВНИКА...'
      });
      
      // Уведомляем о начале игры
      io.to(roomName).emit('gameStatus', '⚔️ БИТВА НАЧАЛАСЬ!');
    } else {
      // Уведомляем о готовности
      const waitingCount = currentRoom.players.length - currentRoom.ready.length;
      io.to(roomName).emit('waiting', 
        `Ожидание готовности... (${currentRoom.ready.length}/2 игроков готово)`);
    }
  });

  // Обычный ход
  socket.on('makeMove', (data) => {
    const roomName = socket.roomName;
    if (!roomName || !rooms.has(roomName)) return;
    
    const currentRoom = rooms.get(roomName);
    
    // Проверяем, ход ли игрока
    if (currentRoom.gameState.turn !== socket.id) {
      socket.emit('errorMsg', 'Сейчас не ваш ход!');
      return;
    }
    
    // Проверяем индекс
    const index = parseInt(data.index);
    if (isNaN(index) || index < 0 || index > 99) {
      socket.emit('errorMsg', 'Некорректная клетка!');
      return;
    }
    
    console.log(`🎯 Игрок ${socket.id} стреляет в клетку ${index}`);
    
    // Передаем ход противнику
    const opponentId = currentRoom.players.find(id => id !== socket.id);
    socket.to(roomName).emit('enemyMove', {
      index: index,
      playerId: socket.id
    });
  });

  // Результат выстрела
  socket.on('shotResult', (data) => {
    const roomName = socket.roomName;
    if (!roomName || !rooms.has(roomName)) return;
    
    const currentRoom = rooms.get(roomName);
    const opponentId = currentRoom.players.find(id => id !== socket.id);
    
    // Если попали, но не убили - ход остается у стрелявшего
    if (data.hit && !data.killed) {
      currentRoom.gameState.turn = opponentId;
      
      io.to(opponentId).emit('updateResult', {
        index: data.index,
        hit: true,
        killed: false,
        canMove: true,
        message: '🎯 ПОПАДАНИЕ! Ваш ход продолжается'
      });
      
      socket.emit('updateResult', {
        index: data.index,
        hit: true,
        killed: false,
        canMove: false,
        message: '💥 Ваш корабль поврежден!'
      });
      
    } else if (data.hit && data.killed) {
      // Убил корабль - ход тоже остается
      currentRoom.gameState.turn = opponentId;
      
      io.to(opponentId).emit('updateResult', {
        index: data.index,
        hit: true,
        killed: true,
        coords: data.coords,
        canMove: true,
        message: '💀 КОРАБЛЬ УБИТ! Продолжайте ход'
      });
      
      socket.emit('updateResult', {
        index: data.index,
        hit: true,
        killed: true,
        coords: data.coords,
        canMove: false,
        message: '💔 Ваш корабль уничтожен!'
      });
      
    } else {
      // Промах - ход переходит
      currentRoom.gameState.turn = socket.id;
      
      io.to(opponentId).emit('updateResult', {
        index: data.index,
        hit: false,
        killed: false,
        canMove: false,
        message: '🌀 ПРОМАХ! Ход противника'
      });
      
      socket.emit('updateResult', {
        index: data.index,
        hit: false,
        killed: false,
        canMove: true,
        message: '🎯 ПРОМАХ! Ваш ход'
      });
    }
    
    // Обновляем статус для всех
    io.to(roomName).emit('gameStatus', 
      `Ход: ${currentRoom.gameState.turn === socket.id ? 'Вы' : 'Противник'}`);
  });

  // Авиаудар
  socket.on('airstrike', (data) => {
    const roomName = socket.roomName;
    if (!roomName || !rooms.has(roomName)) return;
    
    const currentRoom = rooms.get(roomName);
    
    // Проверяем, ход ли игрока
    if (currentRoom.gameState.turn !== socket.id) {
      socket.emit('errorMsg', 'Сейчас не ваш ход!');
      return;
    }
    
    // Проверяем доступность авиаудара
    if (!currentRoom.airstrikes.get(socket.id)) {
      socket.emit('errorMsg', '❌ Авиаудар уже использован!');
      return;
    }
    
    // Проверяем цели
    if (!data.targets || !Array.isArray(data.targets)) {
      socket.emit('errorMsg', 'Некорректные цели для авиаудара');
      return;
    }
    
    // Используем авиаудар
    currentRoom.airstrikes.set(socket.id, false);
    
    const opponentId = currentRoom.players.find(id => id !== socket.id);
    console.log(`✈️ Авиаудар от ${socket.id} по центру ${data.center}, целей: ${data.targets.length}`);
    
    // Отправляем цели противнику
    socket.to(roomName).emit('enemyAirstrike', {
      center: data.center,
      targets: data.targets,
      playerId: socket.id
    });
    
    // Подтверждаем использование
    socket.emit('airstrikeConfirmed');
    socket.emit('gameStatus', '✈️ Авиаудар запущен! Ожидаем результат...');
  });

  // Результат авиаудара
  socket.on('airstrikeResult', (data) => {
    const roomName = socket.roomName;
    if (!roomName || !rooms.has(roomName)) return;
    
    const currentRoom = rooms.get(roomName);
    const opponentId = currentRoom.players.find(id => id !== socket.id);
    
    // Проверяем, были ли попадания
    const hits = data.results.filter(r => r.hit);
    
    console.log(`📊 Результат авиаудара: ${hits.length} попаданий из ${data.results.length}`);
    
    // Если есть попадания - ход остается у наносившего удар
    if (hits.length > 0) {
      currentRoom.gameState.turn = opponentId;
      
      io.to(opponentId).emit('airstrikeResults', {
        results: data.results,
        canContinue: true,
        message: `✈️ Авиаудар нанес урон! (${hits.length} попаданий)`
      });
      
      socket.emit('gameStatus', `✈️ Авиаудар успешен! ${hits.length} попаданий`);
    } else {
      // Нет попаданий - ход переходит
      currentRoom.gameState.turn = socket.id;
      
      io.to(opponentId).emit('airstrikeResults', {
        results: data.results,
        canContinue: false,
        message: '🌀 Авиаудар промахнулся!'
      });
      
      socket.emit('gameStatus', '🌀 Авиаудар промахнулся! Ваш ход');
    }
  });

  // Игрок победил
  socket.on('gameWon', () => {
    const roomName = socket.roomName;
    if (!roomName || !rooms.has(roomName)) return;
    
    const currentRoom = rooms.get(roomName);
    const opponentId = currentRoom.players.find(id => id !== socket.id);
    
    console.log(`🏆 Игрок ${socket.id} победил в комнате "${roomName}"`);
    
    // Уведомляем о победе/поражении
    io.to(socket.id).emit('gameOver', { 
      won: true,
      message: '🎉 ПОБЕДА! Все корабли противника уничтожены!' 
    });
    
    io.to(opponentId).emit('gameOver', { 
      won: false,
      message: '💀 ПОРАЖЕНИЕ! Все ваши корабли потоплены.' 
    });
    
    // Удаляем комнату через 30 секунд
    setTimeout(() => {
      if (rooms.has(roomName)) {
        rooms.delete(roomName);
        console.log(`🗑️ Комната "${roomName}" удалена после игры`);
      }
    }, 30000);
  });

  // Отключение игрока
  socket.on('disconnect', (reason) => {
    console.log(`👋 Игрок отключился: ${socket.id}, причина: ${reason}`);
    
    const roomName = socket.roomName;
    if (roomName && rooms.has(roomName)) {
      const currentRoom = rooms.get(roomName);
      
      // Удаляем игрока из комнаты
      currentRoom.players = currentRoom.players.filter(id => id !== socket.id);
      currentRoom.ready = currentRoom.ready.filter(id => id !== socket.id);
      
      if (currentRoom.players.length === 0) {
        // Комната пуста - удаляем
        rooms.delete(roomName);
        console.log(`🗑️ Комната "${roomName}" удалена (пуста)`);
      } else {
        // Уведомляем оставшегося игрока
        const remainingPlayer = currentRoom.players[0];
        io.to(remainingPlayer).emit('enemyDisconnected');
        io.to(remainingPlayer).emit('gameOver', { 
          won: true,
          message: '🏆 ПРОТИВНИК СДАЛСЯ! Вы победили!' 
        });
        
        console.log(`ℹ️ Игрок ${socket.id} покинул комнату "${roomName}"`);
        
        // Удаляем комнату через 30 секунд
        setTimeout(() => {
          if (rooms.has(roomName)) {
            rooms.delete(roomName);
          }
        }, 30000);
      }
    }
  });
});

// Маршруты для Render
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.get('/status', (req, res) => {
  const activeRooms = Array.from(rooms.entries()).map(([name, room]) => ({
    name,
    players: room.players.length,
    started: room.gameState.started
  }));
  
  res.json({
    status: 'online',
    server: 'Sea Battle Neon',
    version: '2.0.0',
    uptime: process.uptime(),
    players: io.engine.clientsCount,
    rooms: rooms.size,
    activeRooms: activeRooms
  });
});

app.get('/rooms', (req, res) => {
  const roomsList = {};
  for (const [name, room] of rooms.entries()) {
    roomsList[name] = {
      players: room.players,
      ready: room.ready,
      started: room.gameState.started,
      hasPassword: !!room.password
    };
  }
  res.json(roomsList);
});

// Для Render важно слушать правильный порт
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║      МОРСКОЙ БОЙ С АВИАУДАРОМ        ║
  ║           v2.0.0 - NEON              ║
  ╚═══════════════════════════════════════╝
  
  🚀 Сервер запущен на порту: ${PORT}
  🌐 WebSocket сервер готов
  📡 Ожидаем подключений...
  
  ✅ Статус: http://localhost:${PORT}/status
  🎮 Игра: http://localhost:${PORT}/
  `);
});
