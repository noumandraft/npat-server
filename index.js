require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Strict CORS for deployment
const allowedOrigin = process.env.FRONTEND_URL || "http://localhost:5173";
const io = new Server(server, {
  cors: { origin: allowedOrigin, methods: ["GET", "POST"] }
});

const rooms = {};
// Maps socket.id to { roomId, playerId }
const socketMap = {};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function generateLetter() {
    return LETTERS.charAt(Math.floor(Math.random() * LETTERS.length));
}

io.on('connection', (socket) => {
  console.log(`User Connected: ${socket.id}`);

  socket.on('join_room', ({ roomId, playerName, playerId }) => {
    socket.join(roomId);
    socketMap[socket.id] = { roomId, playerId };

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        status: 'lobby',
        currentLetter: generateLetter(),
        host: playerId,
        currentRound: 1,
        totalRounds: 3,
        timerLimit: 60,
        pendingAnswers: {}, 
        vetosSubmitted: [] 
      };
    }

    const existingPlayer = rooms[roomId].players.find(p => p.playerId === playerId);
    if (!existingPlayer) {
        rooms[roomId].players.push({ 
            playerId, 
            name: playerName, 
            score: 0, 
            answers: {}, 
            hasSubmitted: false,
            online: true
        });
    } else {
        existingPlayer.name = playerName;
        existingPlayer.online = true;
    }

    io.to(roomId).emit('room_update', rooms[roomId]);
  });

  socket.on('exit_room', (roomId) => {
      const info = socketMap[socket.id];
      if (info && rooms[roomId]) {
          rooms[roomId].players = rooms[roomId].players.filter(p => p.playerId !== info.playerId);
          socket.leave(roomId);
          delete socketMap[socket.id];
          
          if (rooms[roomId].players.length === 0) {
              delete rooms[roomId];
          } else {
              if (rooms[roomId].host === info.playerId) {
                 rooms[roomId].host = rooms[roomId].players[0].playerId;
              }
              io.to(roomId).emit('room_update', rooms[roomId]);
          }
      }
  });

  socket.on('update_settings', ({ roomId, settings }) => {
      const info = socketMap[socket.id];
      if (rooms[roomId] && info && rooms[roomId].host === info.playerId) {
          if (settings.timerLimit) rooms[roomId].timerLimit = settings.timerLimit;
          if (settings.totalRounds) rooms[roomId].totalRounds = settings.totalRounds;
          io.to(roomId).emit('room_update', rooms[roomId]);
      }
  });

  socket.on('start_game', (roomId) => {
      const info = socketMap[socket.id];
      if (rooms[roomId] && info && rooms[roomId].host === info.playerId) {
          rooms[roomId].currentRound = 1;
          rooms[roomId].players.forEach(p => { p.score = 0; p.answers = {}; p.hasSubmitted = false; });
          startRound(roomId);
      }
  });

  socket.on('next_round', (roomId) => {
      const info = socketMap[socket.id];
      if (rooms[roomId] && info && rooms[roomId].host === info.playerId) {
          if (rooms[roomId].currentRound < rooms[roomId].totalRounds) {
              rooms[roomId].currentRound++;
              startRound(roomId);
          } else {
              rooms[roomId].status = 'podium';
              io.to(roomId).emit('room_update', rooms[roomId]);
          }
      }
  });

  function startRound(roomId) {
      rooms[roomId].status = 'playing';
      rooms[roomId].currentLetter = generateLetter();
      rooms[roomId].vetosSubmitted = [];
      rooms[roomId].players.forEach(p => { p.answers = {}; p.hasSubmitted = false; });
      io.to(roomId).emit('game_started', rooms[roomId]);
  }

  socket.on('submit_answers', ({ roomId, answers }) => {
      const info = socketMap[socket.id];
      if (rooms[roomId] && info) {
          const player = rooms[roomId].players.find(p => p.playerId === info.playerId);
          if (player && !player.hasSubmitted) {
              player.answers = answers;
              player.hasSubmitted = true;
              io.to(roomId).emit('player_submitted', info.playerId);
          }

          const allSubmitted = rooms[roomId].players.every(p => p.hasSubmitted || !p.online);
          if (allSubmitted && rooms[roomId].status === 'playing') {
              rooms[roomId].pendingAnswers = groupAnswers(roomId);
              rooms[roomId].status = 'voting';
              rooms[roomId].vetosSubmitted = [];
              io.to(roomId).emit('voting_started', rooms[roomId]);
          }
      }
  });

  socket.on('submit_vetos', ({ roomId, vetos }) => {
      const info = socketMap[socket.id];
      if (rooms[roomId] && info) {
          if (!rooms[roomId].vetoCounts) {
              rooms[roomId].vetoCounts = { name: {}, place: {}, animal: {}, thing: {} };
          }
          
          vetos.forEach(v => {
              if (rooms[roomId].vetoCounts[v.category]) {
                  rooms[roomId].vetoCounts[v.category][v.answer] = (rooms[roomId].vetoCounts[v.category][v.answer] || 0) + 1;
              }
          });

          if (!rooms[roomId].vetosSubmitted.includes(info.playerId)) {
              rooms[roomId].vetosSubmitted.push(info.playerId);
          }

          const onlinePlayersCount = rooms[roomId].players.filter(p => p.online).length;
          if (rooms[roomId].vetosSubmitted.length >= onlinePlayersCount && rooms[roomId].status === 'voting') {
              calculateScores(roomId);
              rooms[roomId].status = 'results';
              rooms[roomId].vetoCounts = null; 
              io.to(roomId).emit('round_results', rooms[roomId]);
          }
      }
  });

  socket.on('send_emote', ({ roomId, emote }) => {
      const now = Date.now();
      const lastEmote = socketMap[socket.id]?.lastEmote || 0;
      if (now - lastEmote > 500) {
          if (socketMap[socket.id]) socketMap[socket.id].lastEmote = now;
          io.to(roomId).emit('receive_emote', { id: socket.id, emote });
      }
  });

  socket.on('disconnect', () => {
    console.log(`User Disconnected: ${socket.id}`);
    const info = socketMap[socket.id];
    if (info && rooms[info.roomId]) {
        const player = rooms[info.roomId].players.find(p => p.playerId === info.playerId);
        if (player) {
            player.online = false;
        }
        io.to(info.roomId).emit('room_update', rooms[info.roomId]);
        checkEmptyRoom(info.roomId);
    }
    delete socketMap[socket.id];
  });

  function checkEmptyRoom(roomId) {
      setTimeout(() => {
          if (rooms[roomId]) {
              const anyOnline = rooms[roomId].players.some(p => p.online);
              if (!anyOnline) {
                  delete rooms[roomId]; // Clean up completely abandoned rooms after a delay
              }
          }
      }, 5000);
  }
});

function groupAnswers(roomId) {
    const room = rooms[roomId];
    if (!room) return {};
    
    const categories = ['name', 'place', 'animal', 'thing'];
    const pending = { name: {}, place: {}, animal: {}, thing: {} };

    categories.forEach(category => {
        room.players.forEach(p => {
            if (!p.online && !p.hasSubmitted) return; // Skip players who dropped before submitting
            
            let ans = (p.answers[category] || "").trim().toLowerCase();
            if (ans) ans = ans.charAt(0).toUpperCase() + ans.slice(1);
            
            if (ans && ans.charAt(0).toLowerCase() === room.currentLetter.toLowerCase()) {
                if (!pending[category][ans]) pending[category][ans] = [];
                pending[category][ans].push(p.playerId);
            }
        });
    });
    return pending;
}

function calculateScores(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const categories = ['name', 'place', 'animal', 'thing'];
    const onlinePlayers = room.players.filter(p => p.online || p.hasSubmitted);
    const majorityThreshold = Math.ceil(onlinePlayers.length / 2);

    categories.forEach(category => {
        const answersMap = room.pendingAnswers[category];
        
        Object.keys(answersMap).forEach(ans => {
            const vetoCount = room.vetoCounts?.[category]?.[ans] || 0;
            const isVetoed = onlinePlayers.length > 1 && vetoCount >= majorityThreshold; 
            
            if (!isVetoed) {
                const pIds = answersMap[ans];
                const points = pIds.length === 1 ? 10 : 5; 
                
                pIds.forEach(id => {
                    const player = room.players.find(p => p.playerId === id);
                    if (player) {
                        player.score += points;
                    }
                });
            }
        });
    });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
