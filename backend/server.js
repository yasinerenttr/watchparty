const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// Oda yönetimi
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("Birisi bağlandı:", socket.id);

  socket.on("join-room", ({ roomId, username }) => {
    socket.join(roomId);
    
    // Oda bilgisini sakla
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        users: [],
        screenSharing: null,
      });
    }

    const room = rooms.get(roomId);
    room.users.push({ id: socket.id, username, camera: false, microphone: false });

    // Diğer kullanıcılara yeni kullanıcı bildir
    socket.to(roomId).emit("user-joined", { userId: socket.id, username });
    
    // Yeni kullanıcıya odadaki diğer kullanıcıları gönder
    socket.emit("room-users", room.users);
    
    // Eğer odada ekran paylaşan biri varsa, yeni kullanıcıya bildir
    if (room.screenSharing) {
      socket.emit("screen-share-started", { userId: room.screenSharing });
    }
    
    console.log(`${username} joined room ${roomId}`);
  });

  socket.on("offer", ({ roomId, offer, to }) => {
    socket.to(to).emit("offer", { offer, from: socket.id });
  });

  socket.on("answer", ({ roomId, answer, to }) => {
    socket.to(to).emit("answer", { answer, from: socket.id });
  });

  socket.on("ice-candidate", ({ roomId, candidate, to }) => {
    socket.to(to).emit("ice-candidate", { candidate, from: socket.id });
  });

  socket.on("screen-share-start", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      room.screenSharing = socket.id;
      socket.to(roomId).emit("screen-share-started", { userId: socket.id });
    }
  });

  socket.on("screen-share-stop", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.screenSharing === socket.id) {
      room.screenSharing = null;
      socket.to(roomId).emit("screen-share-stopped", { userId: socket.id });
    }
  });

  socket.on("update-media", ({ roomId, username, camera, microphone }) => {
    const room = rooms.get(roomId);
    if (room) {
      const user = room.users.find(u => u.id === socket.id);
      if (user) {
        user.camera = camera;
        user.microphone = microphone;
      }
    }
    socket.to(roomId).emit("media-updated", { userId: socket.id, camera, microphone });
  });

  socket.on("chat-message", ({ roomId, username, message }) => {
    if (!roomId || !message) return;
    io.to(roomId).emit("chat-message", {
      id: `${socket.id}-${Date.now()}`,
      username: username || "Misafir",
      message: String(message).slice(0, 350),
      createdAt: new Date().toISOString(),
    });
  });

  socket.on("reaction", ({ roomId, type }) => {
    if (!roomId || !type) return;
    // Gönderen kişi hariç odadaki diğer kişilere ilet
    socket.to(roomId).emit("reaction", { type, id: `${socket.id}-${Date.now()}-${Math.random()}` });
  });

  socket.on("disconnect", () => {
    // Tüm odalarda bu kullanıcıyı sil
    rooms.forEach((room, roomId) => {
      room.users = room.users.filter(u => u.id !== socket.id);
      if (room.screenSharing === socket.id) {
        room.screenSharing = null;
        io.to(roomId).emit("screen-share-stopped", { userId: socket.id });
      }
      io.to(roomId).emit("user-left", { userId: socket.id });
    });
    console.log("Birisi ayrıldı:", socket.id);
  });
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`🎬 Watch Party Server ${PORT} portunda çalışıyor...`);
});
