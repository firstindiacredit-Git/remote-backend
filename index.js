// backend/index.js

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

const User = require("./controller/userController")

// Store client and host connection mapping
const clientToHostMap = {};

// Add a new map to store session codes for hosts
const hostSessionCodes = {};

const app = express();

dotenv.config();

// MongoDB setup
const url = process.env.MONGODB_URI;
mongoose.connect(url);

const connection = mongoose.connection;
connection.on('error', console.error.bind(console, 'MongoDB connection error:'));
connection.once('open', () => {
  console.log('MongoDB database connected');
});

const server = http.createServer(app);
const io = new Server(server, {
  path: '/socket.io',
  serveClient: false,
  pingTimeout: 60000,
  pingInterval: 15000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 5e8, // 500MB - to handle large payloads for screen sharing
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
    try {
      console.log(`Host ready received from ${socket.id} with data:`, data);
      // Generate a random 6-digit code for the host
      const sessionCode = Math.floor(100000 + Math.random() * 900000).toString();
      
      console.log(`Generated session code ${sessionCode} for host ${socket.id}`);
      
      // Store this code mapped to the host's socket ID
      hostSessionCodes[socket.id] = {
        code: sessionCode,
        computerName: data && data.computerName ? data.computerName : "Unknown Host",
        pendingConnections: {},
      };
      
      // Send the code to the host
      console.log(`Sending session code ${sessionCode} to host ${socket.id}`);
      socket.emit("session-code", sessionCode);
      
      // Additional check to ensure the code was stored
      console.log("Current host session codes:", Object.keys(hostSessionCodes));
    } catch (error) {
      console.error("Error processing host-ready:", error);
    }
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

  // Add new handlers for the session code connection flow
  socket.on("connect-with-code", (data) => {
    const { code } = data;
    let hostId = null;
    
    // Find the host with this code
    for (const [id, info] of Object.entries(hostSessionCodes)) {
      if (info.code === code) {
        hostId = id;
        break;
      }
    }
    
    if (hostId) {
      // Add this client to pending connections for this host
      hostSessionCodes[hostId].pendingConnections[socket.id] = {
        timestamp: Date.now(),
        status: 'pending'
      };
      
      // Notify the host that someone wants to connect
      socket.to(hostId).emit("connection-request", {
        clientId: socket.id,
        timestamp: Date.now()
      });
      
      // Notify the client that the code was valid
      socket.emit("code-accepted", {
        hostId,
        hostName: hostSessionCodes[hostId].computerName
      });
    } else {
      // Tell the client the code was invalid
      socket.emit("code-rejected", { message: "Invalid session code" });
    }
  });

  // Add a handler for the host to accept/reject connections
  socket.on("connection-response", (data) => {
    const { clientId, accepted } = data;
    
    if (accepted) {
      // Update the connection status
      if (hostSessionCodes[socket.id] && 
          hostSessionCodes[socket.id].pendingConnections[clientId]) {
        hostSessionCodes[socket.id].pendingConnections[clientId].status = 'accepted';
      }
      
      // Notify the client
      socket.to(clientId).emit("connection-accepted", {
        hostId: socket.id,
        hostName: hostSessionCodes[socket.id]?.computerName || "Unknown Host"
      });
    } else {
      // Notify client of rejection
      socket.to(clientId).emit("connection-rejected");
      
      // Remove from pending connections
      if (hostSessionCodes[socket.id] && 
          hostSessionCodes[socket.id].pendingConnections[clientId]) {
        delete hostSessionCodes[socket.id].pendingConnections[clientId];
      }
    }
  });

  // Log detailed disconnect reasons with better error handling
  socket.on('disconnect', (reason) => {
    console.log(`Socket ${socket.id} disconnected due to: ${reason}`);
    
    // Clean up session codes
    if (hostSessionCodes[socket.id]) {
      delete hostSessionCodes[socket.id];
    }
    
    // Also check if any host has this client in pending connections
    for (const hostId in hostSessionCodes) {
      if (hostSessionCodes[hostId].pendingConnections &&
          hostSessionCodes[hostId].pendingConnections[socket.id]) {
        delete hostSessionCodes[hostId].pendingConnections[socket.id];
      }
    }
    
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

  socket.on("start-screen-recording", (data) => {
    console.log(`Screen recording started by ${data.from} for host ${data.to}`);
    socket.to(data.to).emit("start-screen-recording", {
      from: data.from,
      recordingOptions: data.recordingOptions || {}
    });
  });

  socket.on("stop-screen-recording", (data) => {
    console.log(`Screen recording stopped by ${data.from} for host ${data.to}`);
    socket.to(data.to).emit("stop-screen-recording", {
      from: data.from
    });
  });

  socket.on("recording-status", (data) => {
    console.log(`Recording status update from ${socket.id} to ${data.to}: ${data.status}`);
    socket.to(data.to).emit("recording-status", {
      from: socket.id,
      status: data.status,
      progress: data.progress,
      error: data.error
    });
  });

  socket.on("recording-chunk", (data) => {
    console.log(`Recording chunk from ${socket.id} to ${data.to}, size: ${data.chunk.length} bytes`);
    socket.to(data.to).emit("recording-chunk", {
      from: socket.id,
      chunk: data.chunk,
      chunkIndex: data.chunkIndex,
      totalChunks: data.totalChunks
    });
  });

  socket.on("recording-complete", (data) => {
    console.log(`Recording complete from ${socket.id} to ${data.to}`);
    socket.to(data.to).emit("recording-complete", {
      from: socket.id,
      recordingId: data.recordingId,
      duration: data.duration,
      fileSize: data.fileSize
    });
  });
});

app.use("/api", User )

app.use(express.static(path.join(__dirname, 'dist')));

app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

// Error handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Log but don't crash the process
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Log but don't crash the process
});

// Prevent memory leaks to ensure stability
setInterval(() => {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`Memory usage: ${Math.round(used * 100) / 100} MB`);
  
  // Clean up client-host mapping (if it exists)
  if (clientToHostMap) {
    const now = Date.now();
    for (const [clientId, data] of Object.entries(clientToHostMap)) {
      if (data && data.timestamp && now - data.timestamp > 3600000) { // Remove mappings older than 1 hour
        delete clientToHostMap[clientId];
        console.log(`Cleaned stale mapping for ${clientId}`);
      }
    }
  }
}, 300000); // Check every 5 minutes

