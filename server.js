const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('joinCustomRoom', (data) => {
        if (!data || !data.room || !data.pass) return socket.emit('errorMsg', 'Ошибка данных');
        const { room, pass } = data;

        if (!rooms.has(room)) {
            rooms.set(room, { password: pass, players: [socket.id] });
            socket.join(room);
            socket.roomName = room;
            socket.emit('waiting', 'Комната создана. Ждем противника...');
        } else {
            const currentRoom = rooms.get(room);
            if (currentRoom.password !== pass) return socket.emit('errorMsg', 'Неверный пароль!');
            if (currentRoom.players.length >= 2) return socket.emit('errorMsg', 'Комната полна!');

            currentRoom.players.push(socket.id);
            socket.join(room);
            socket.roomName = room;
            io.to(room).emit('waiting', 'Противник вошел! Расставляйте флот.');
        }
    });

    socket.on('playerReady', () => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) return;

        socket.isReady = true;
        const currentRoom = rooms.get(roomName);
        const players = currentRoom.players.map(id => io.sockets.sockets.get(id)).filter(s => s);

        if (players.length === 2 && players.every(p => p.isReady)) {
            const first = Math.random() < 0.5 ? 0 : 1;
            players[first].emit('gameStart', { canMove: true });
            players[1 - first].emit('gameStart', { canMove: false });
        } else {
            socket.emit('waiting', 'Ждем готовности врага...');
        }
    });

    socket.on('makeMove', (data) => {
        if (socket.roomName) socket.to(socket.roomName).emit('enemyMove', data);
    });

    socket.on('shotResult', (data) => {
        if (socket.roomName) socket.to(socket.roomName).emit('updateResult', data);
    });

    socket.on('disconnect', () => {
        const roomName = socket.roomName;
        if (roomName && rooms.has(roomName)) {
            const currentRoom = rooms.get(roomName);
            currentRoom.players = currentRoom.players.filter(id => id !== socket.id);
            if (currentRoom.players.length === 0) {
                rooms.delete(roomName);
            } else {
                io.to(roomName).emit('enemyDisconnected');
            }
        }
    });
});

http.listen(3000, () => console.log('SERVER 2026 ONLINE: http://localhost:3000'));
