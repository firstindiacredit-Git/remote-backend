// backend/index.js

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const path = require("path");

// स्टोर क्लाइंट और होस्ट कनेक्शन मैपिंग
const clientToHostMap = {};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: '/socket.io',
  serveClient: false,
  pingTimeout: 60000,
  pingInterval: 15000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 5e8, // 500MB - स्क्रीनशेयरिंग के लिए बड़े पेलोड को हैंडल करने के लिए
  transports: ['polling', 'websocket'], 
  allowUpgrades: true,
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Set engine options
io.engine.opts.pingTimeout = 60000;     // Match the pingTimeout above
io.engine.opts.pingInterval = 25000;    // Match the pingInterval above

app.use(cors());
app.use(express.json());

// Socket handlers
const registerSocketHandlers = require("./socketHandlers/index");
// server.js
io.on("connection", (socket) => {
  console.log(`New connection with ID: ${socket.id}`);
  
  // Log transport type
  console.log(`Transport used: ${socket.conn.transport.name}`);
  
  // Handle transport change
  socket.conn.on('upgrade', (transport) => {
    console.log(`Socket ${socket.id} upgraded transport to: ${transport.name}`);
  });

  // Handle keep-alive pings
  socket.on("keep-alive", () => {
    // Just acknowledge the ping, no need to do anything
  });

  socket.on("host-ready", (data) => {
    // Host computer announces it's ready to accept connections
    // Include computer name if provided, otherwise use a default name
    const hostInfo = {
      id: socket.id,
      name: data && data.computerName ? data.computerName : "Unknown Host"
    };
    
    socket.broadcast.emit("host-available", hostInfo);
  });

  socket.on("offer", (data) => {
    socket.to(data.to).emit("offer", {
      offer: data.offer,
      from: socket.id
    });
  });

  socket.on("answer", (data) => {
    socket.to(data.to).emit("answer", {
      answer: data.answer,
      from: socket.id
    });
  });

  socket.on("ice-candidate", (data) => {
    socket.to(data.to).emit("ice-candidate", {
      candidate: data.candidate,
      from: socket.id
    });
  });

  socket.on("remote-mouse-move", (data) => {
    socket.to(data.to).emit("remote-mouse-move", data);
  });

  socket.on("remote-mouse-click", (data) => {
    socket.to(data.to).emit("remote-mouse-click", data);
  });

  socket.on("remote-key-press", (data) => {
    socket.to(data.to).emit("remote-key-press", data);
  });

  socket.on("remote-key-event", (data) => {
    socket.to(data.to).emit("remote-key-event", data);
  });

  socket.on("remote-mouse-scroll", (data) => {
    socket.to(data.to).emit("remote-mouse-scroll", data);
  });

  socket.on("connect-to-host", (hostId) => {
    console.log(`Client ${socket.id} wants to connect to host ${hostId}`);
    socket.to(hostId).emit("controller-connected", socket.id);
  });

  socket.on("request-screen", (data) => {
    console.log(`Screen requested from ${data.from} to ${data.to}`);
    socket.to(data.to).emit("request-screen", data);
  });

  socket.on("screen-data", (data) => {
    // Forward screen data to the controller
    socket.to(data.to).emit("screen-data", data);
  });

  // Connect client to host
  socket.on("connect-client-to-host", (data) => {
    const { targetHostId } = data;
    console.log(`Client ${socket.id} wants to connect to host ${targetHostId}`);
    
    // Store the mapping with timestamp
    clientToHostMap[socket.id] = {
      hostId: targetHostId,
      timestamp: Date.now()
    };
    
    // Emit event to host
    io.to(targetHostId).emit("client-connected", { clientId: socket.id });
  });

  // Log detailed disconnect reasons with better error handling
  socket.on('disconnect', (reason) => {
    console.log(`Socket ${socket.id} disconnected due to: ${reason}`);
    
    // Check if clientToHostMap exists and clean up any associated connections
    if (clientToHostMap) {
      for (const [clientId, hostId] of Object.entries(clientToHostMap)) {
        // Check if the value is an object with timestamp or just a string
        if (typeof hostId === 'object' && hostId.hostId) {
          if (clientId === socket.id || hostId.hostId === socket.id) {
            delete clientToHostMap[clientId];
            console.log(`Cleaned up connection mapping for ${socket.id}`);
          }
        } else if (clientId === socket.id || hostId === socket.id) {
          delete clientToHostMap[clientId];
          console.log(`Cleaned up connection mapping for ${socket.id}`);
        }
      }
    }
  });
});

app.use(express.static(path.join(__dirname, 'dist')));

app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});


const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

// इरर हैंडलिंग
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // लॉग करें लेकिन प्रोसेस को क्रैश न करें
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // लॉग करें लेकिन प्रोसेस को क्रैश न करें
});

// स्थिरता सुनिश्चित करने के लिए मेमोरी लीक को रोकें
setInterval(() => {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`Memory usage: ${Math.round(used * 100) / 100} MB`);
  
  // क्लाइंट-होस्ट मैपिंग को साफ करें (अगर मौजूद है)
  if (clientToHostMap) {
    const now = Date.now();
    for (const [clientId, data] of Object.entries(clientToHostMap)) {
      if (data && data.timestamp && now - data.timestamp > 3600000) { // 1 घंटे से पुरानी मैपिंग हटाएं
        delete clientToHostMap[clientId];
        console.log(`Cleaned stale mapping for ${clientId}`);
      }
    }
  }
}, 300000); // हर 5 मिनट में चेक करें

