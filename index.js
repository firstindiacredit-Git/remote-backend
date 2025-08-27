// backend/index.js

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

// DISCONNECT DETECTION SYSTEM:
// This system detects when a host disconnects and automatically notifies connected clients.
// When a host disconnects (closes app, loses connection, etc.), all connected clients receive
// a "host-disconnected" event with host information and are redirected to the main page.
// This ensures clients are immediately aware when the host is no longer available.
//
// TESTING THE SYSTEM:
// 1. Start the backend server
// 2. Start the Electron app (host)
// 3. Connect from the web client using permanent access
// 4. Close the Electron app or disconnect the host
// 5. The web client should immediately show an alert and return to main page
// 6. Check the backend console logs for disconnect detection messages

const User = require("./controller/userController")
const PermanentAccess = require("./model/permanentAccessModel");

// स्टोर क्लाइंट और होस्ट कनेक्शन मैपिंग
const clientToHostMap = {};

// Add a new map to store session codes for hosts
const hostSessionCodes = {};

// Store trusted clients with their passwords
const trustedClients = {};

// Store pending permanent access notifications
const pendingPermanentAccessNotifications = {};

// Path to store persistent passwords
const PASSWORDS_FILE = path.join(__dirname, 'trusted_clients.json');

// Load saved passwords on startup
try {
  if (fs.existsSync(PASSWORDS_FILE)) {
    const data = fs.readFileSync(PASSWORDS_FILE, 'utf8');
    Object.assign(trustedClients, JSON.parse(data));
    console.log(`Loaded ${Object.keys(trustedClients).length} saved trusted connections`);
  }
} catch (err) {
  console.error('Error loading trusted clients:', err);
}

// Function to save trusted clients to file
function saveTrustedClients() {
  try {
    fs.writeFileSync(PASSWORDS_FILE, JSON.stringify(trustedClients, null, 2));
  } catch (err) {
    console.error('Error saving trusted clients:', err);
  }
}

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

// server.js
io.on("connection", (socket) => {
  console.log(`New connection with ID: ${socket.id}`);
  
  // Log transport type
  console.log(`Transport used: ${socket.conn.transport.name}`);
  
  // Handle transport change
  socket.conn.on('upgrade', (transport) => {
    console.log(`Socket ${socket.id} upgraded transport to: ${transport.name}`);
  });

  // Check for pending permanent access notifications
  if (pendingPermanentAccessNotifications[socket.id]) {
    console.log(`Sending pending permanent access notification to ${socket.id}`);
    const notification = pendingPermanentAccessNotifications[socket.id];
    socket.emit("permanent-access-set-notification", notification);
    delete pendingPermanentAccessNotifications[socket.id];
  }

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
        machineId: data.machineId || null
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

  // New handler for setting permanent access credentials
  socket.on("set-permanent-access", async (data) => {
    try {
      console.log("Received set-permanent-access request:", data);
      const { label, password, clientId } = data;
      
      if (!label || !password || !clientId) {
        console.log("Missing required fields:", { label: !!label, password: !!password, clientId: !!clientId });
        socket.emit("permanent-access-response", { 
          success: false, 
          message: "Missing label, password or client ID"
        });
        return;
      }

      // Hash the password
      const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
      
      // Get machine ID and computer name from the host session
      const machineId = hostSessionCodes[socket.id]?.machineId;
      const computerName = hostSessionCodes[socket.id]?.computerName || "Unknown Computer";
      
      console.log("Host session data:", { machineId, computerName, socketId: socket.id });
      
      if (!machineId) {
        console.log("Missing machine ID for host");
        socket.emit("permanent-access-response", { 
          success: false, 
          message: "Missing machine ID for host"
        });
        return;
      }
      
      // Check if permanent access record exists for this machine
      let permanentAccess = await PermanentAccess.findOne({ machineId });
      
      if (!permanentAccess) {
        console.log("Creating new permanent access record for machine:", machineId);
        // Create new permanent access record
        permanentAccess = new PermanentAccess({
          machineId,
          computerName,
          accessCredentials: []
        });
      } else {
        console.log("Found existing permanent access record for machine:", machineId);
      }
      
      // Add new credential
      permanentAccess.accessCredentials.push({
        label,
        password: hashedPassword,
        clientId,
        createdAt: Date.now(),
        lastUsed: Date.now()
      });
      
      console.log("Saving permanent access record...");
      // Save to database
      await permanentAccess.save();
      console.log("Permanent access record saved successfully");
      
      socket.emit("permanent-access-response", {
        success: true,
        message: "Permanent access set successfully"
      });
      
      console.log("Sending notification to client:", clientId);
      // Notify the client
      socket.to(clientId).emit("permanent-access-set-notification", {
        hostId: socket.id,
        machineId: machineId,
        computerName: computerName,
        label: label
      });
      
      // Also try to emit directly to the client socket as backup
      const clientSocket = io.sockets.sockets.get(clientId);
      if (clientSocket) {
        console.log("Sending direct notification to client socket");
        clientSocket.emit("permanent-access-set-notification", {
          hostId: socket.id,
          machineId: machineId,
          computerName: computerName,
          label: label
        });
      } else {
        console.log("Client not connected, storing notification for later");
        // Store the notification to send when client reconnects
        pendingPermanentAccessNotifications[clientId] = {
          hostId: socket.id,
          machineId: machineId,
          computerName: computerName,
          label: label
        };
      }
      
      console.log("Notification sent. Checking if client is still connected...");
      // Check if the client is still connected
      if (clientSocket) {
        console.log("Client socket found and connected");
      } else {
        console.log("Client socket not found or disconnected");
      }
      
      console.log("About to start automatic connection acceptance...");
      
      // Automatically accept the connection for permanent access
      console.log("Auto-accepting connection for permanent access");
      console.log("Sending connection-accepted to client:", clientId);
      console.log("Sending client-auto-connected to host:", socket.id);
      
      // Send connection acceptance events immediately
      console.log("Sending connection acceptance events immediately");
      socket.to(clientId).emit("connection-accepted", {
        hostId: socket.id,
        hostName: computerName,
        automatic: true,
        permanentAccess: true
      });
      
      // Notify the host about the auto-connected client
      socket.emit("client-auto-connected", {
        clientId: clientId,
        timestamp: Date.now(),
        permanentAccess: true
      });
      
      console.log("Connection acceptance events sent successfully");
      
      console.log("set-permanent-access handler completed successfully");
      
    } catch (error) {
      console.error("Error setting permanent access:", error);
      socket.emit("permanent-access-response", {
        success: false,
        message: "Error setting permanent access: " + error.message
      });
    }
  });

  // New handler for fetching permanent access data for a client
  socket.on("fetch-permanent-access", async (data) => {
    try {
      console.log("Received fetch-permanent-access request:", data);
      const { clientId } = data;
      
      if (!clientId) {
        console.log("Missing client ID in fetch request");
        socket.emit("permanent-access-data", { 
          success: false, 
          message: "Missing client ID"
        });
        return;
      }
      
      console.log("Searching for permanent access records for client:", clientId);
      // Find all permanent access records that have credentials for this client
      const permanentAccessRecords = await PermanentAccess.find({
        'accessCredentials.clientId': clientId
      });
      
      console.log("Found permanent access records:", permanentAccessRecords.length);
      
      // Format the data for the client
      const formattedData = permanentAccessRecords.map(record => ({
        machineId: record.machineId,
        computerName: record.computerName,
        credentials: record.accessCredentials.filter(cred => cred.clientId === clientId)
      }));
      
      console.log("Sending formatted data to client:", formattedData);
      socket.emit("permanent-access-data", {
        success: true,
        data: formattedData
      });
      
    } catch (error) {
      console.error("Error fetching permanent access data:", error);
      socket.emit("permanent-access-data", {
        success: false,
        message: "Error fetching permanent access data: " + error.message
      });
    }
  });

  // Handler for connecting with permanent access credentials
  socket.on("connect-with-permanent-access", async (data) => {
    try {
      const { machineId, label, password } = data;
      
      if (!machineId || !label || !password) {
        socket.emit("permanent-access-auth-response", {
          success: false,
          message: "Missing machine ID, label or password"
        });
        return;
      }
      
      // Hash the provided password
      const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
      
      // Find the permanent access record
      const permanentAccess = await PermanentAccess.findOne({ machineId });
      
      if (!permanentAccess) {
        socket.emit("permanent-access-auth-response", {
          success: false,
          message: "No permanent access found for this machine"
        });
        return;
      }
      
      // Find the matching credential
      const credential = permanentAccess.accessCredentials.find(
        cred => cred.label === label && cred.password === hashedPassword
      );
      
      if (!credential) {
        socket.emit("permanent-access-auth-response", {
          success: false,
          message: "Invalid label or password"
        });
        return;
      }
      
      // Find the host with this machine ID
      let hostId = null;
      for (const [id, info] of Object.entries(hostSessionCodes)) {
        if (info.machineId === machineId) {
          hostId = id;
          break;
        }
      }
      
      if (!hostId) {
        socket.emit("permanent-access-auth-response", {
          success: false,
          message: "Host not found or not online"
        });
        return;
      }
      
      // Update last used timestamp
      credential.lastUsed = Date.now();
      await permanentAccess.save();
      
      // Auto-accept the connection without host approval
      console.log(`Auto-accepting client ${socket.id} to host ${hostId} (permanent access auth)`);
      
      // Notify the client
      socket.emit("connection-accepted", {
        hostId: hostId,
        hostName: hostSessionCodes[hostId]?.computerName || "Unknown Host",
        automatic: true,
        permanentAccess: true
      });
      
      // Also notify the host
      socket.to(hostId).emit("client-auto-connected", {
        clientId: socket.id,
        timestamp: Date.now(),
        permanentAccess: true
      });
      
    } catch (error) {
      console.error("Error with permanent access authentication:", error);
      socket.emit("permanent-access-auth-response", {
        success: false,
        message: "Authentication error: " + error.message
      });
    }
  });

  // Legacy handler for setting a permanent password (keeping for backward compatibility)
  socket.on("set-access-password", (data) => {
    try {
      const { password, clientId } = data;
      
      if (!password || !clientId) {
        socket.emit("password-response", { 
          success: false, 
          message: "Missing password or client ID"
        });
        return;
      }

      // Hash the password
      const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
      
      // Get machine ID from the host session
      const machineId = hostSessionCodes[socket.id]?.machineId;
      
      if (!machineId) {
        socket.emit("password-response", { 
          success: false, 
          message: "Missing machine ID for host"
        });
        return;
      }
      
      // Store the trusted client with the password and the client ID it was set for
      if (!trustedClients[machineId]) {
        trustedClients[machineId] = {};
      }
      
      trustedClients[machineId][clientId] = {
        passwordHash: hashedPassword,
        createdAt: Date.now(),
        lastUsed: Date.now()
      };
      
      // Save to persistent storage
      saveTrustedClients();
      
      socket.emit("password-response", {
        success: true,
        message: "Password set successfully"
      });
      
      // Notify the client
      socket.to(clientId).emit("password-set-notification", {
        hostId: socket.id,
        machineId: machineId
      });
      
    } catch (error) {
      console.error("Error setting password:", error);
      socket.emit("password-response", {
        success: false,
        message: "Error setting password: " + error.message
      });
    }
  });

  // New handler for connecting with password
  socket.on("connect-with-password", (data) => {
    const { machineId, password } = data;
    
    if (!machineId || !password) {
      socket.emit("password-auth-response", {
        success: false,
        message: "Missing machine ID or password"
      });
      return;
    }
    
    // Hash the provided password
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
    
    // Find the host with this machine ID
    let hostId = null;
    for (const [id, info] of Object.entries(hostSessionCodes)) {
      if (info.machineId === machineId) {
        hostId = id;
        break;
      }
    }
    
    if (!hostId) {
      socket.emit("password-auth-response", {
        success: false,
        message: "Host not found or not online"
      });
      return;
    }
    
    // Check if there are trusted clients for this machine ID
    if (!trustedClients[machineId]) {
      socket.emit("password-auth-response", {
        success: false,
        message: "No trusted clients for this host"
      });
      return;
    }
    
    // Check if this client is trusted (by checking any entry that has the matching password)
    let isAuthenticated = false;
    for (const clientData of Object.values(trustedClients[machineId])) {
      if (clientData.passwordHash === hashedPassword) {
        isAuthenticated = true;
        
        // Update last used timestamp
        clientData.lastUsed = Date.now();
        saveTrustedClients();
        break;
      }
    }
    
    if (isAuthenticated) {
      // Auto-accept the connection without host approval
      console.log(`Auto-accepting client ${socket.id} to host ${hostId} (password auth)`);
      
      // Notify the client
      socket.emit("connection-accepted", {
        hostId: hostId,
        hostName: hostSessionCodes[hostId]?.computerName || "Unknown Host",
        automatic: true
      });
      
      // Also notify the host
      socket.to(hostId).emit("client-auto-connected", {
        clientId: socket.id,
        timestamp: Date.now()
      });
    } else {
      socket.emit("password-auth-response", {
        success: false,
        message: "Invalid password"
      });
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
    console.log("Forwarding controller-connected event to host");
    
    // Store the connection mapping
    clientToHostMap[socket.id] = {
      hostId: hostId,
      timestamp: Date.now()
    };
    
    console.log(`Connection mapping stored: Client ${socket.id} -> Host ${hostId}`);
    console.log(`Updated clientToHostMap:`, clientToHostMap);
    
    socket.to(hostId).emit("controller-connected", socket.id);
  });

  socket.on("request-screen", (data) => {
    console.log(`Screen requested from ${data.from} to ${data.to}`);
    console.log("Forwarding request-screen event to host");
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
    const { clientId, accepted, setPassword } = data;
    
    if (accepted) {
      // Update the connection status
      if (hostSessionCodes[socket.id] && 
          hostSessionCodes[socket.id].pendingConnections[clientId]) {
        hostSessionCodes[socket.id].pendingConnections[clientId].status = 'accepted';
      }
      
      // Notify the client
      socket.to(clientId).emit("connection-accepted", {
        hostId: socket.id,
        hostName: hostSessionCodes[socket.id]?.computerName || "Unknown Host",
        setPassword: setPassword || false
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

  // Handle manual client disconnection by host
  socket.on("disconnect-client", (clientId) => {
    console.log(`Host ${socket.id} is disconnecting client ${clientId}`);
    
    // Get host info
    const hostInfo = hostSessionCodes[socket.id] ? {
      hostId: socket.id,
      computerName: hostSessionCodes[socket.id].computerName,
      machineId: hostSessionCodes[socket.id].machineId
    } : null;
    
    // Notify the client that they have been disconnected
    const clientSocket = io.sockets.sockets.get(clientId);
    if (clientSocket) {
      clientSocket.emit("host-disconnected", {
        hostId: socket.id,
        computerName: hostInfo?.computerName || "Unknown Host",
        machineId: hostInfo?.machineId,
        reason: "Host manually disconnected you"
      });
    }
    
    // Clean up the connection mapping
    if (clientToHostMap[clientId]) {
      delete clientToHostMap[clientId];
      console.log(`Cleaned up connection mapping for client ${clientId}`);
    }
  });

  // Log detailed disconnect reasons with better error handling
  socket.on('disconnect', (reason) => {
    console.log(`Socket ${socket.id} disconnected due to: ${reason}`);
    
    // Check if this is a host disconnecting
    const isHost = hostSessionCodes[socket.id];
    const hostInfo = isHost ? {
      hostId: socket.id,
      computerName: hostSessionCodes[socket.id].computerName,
      machineId: hostSessionCodes[socket.id].machineId
    } : null;
    
    console.log(`Is host disconnecting: ${isHost ? 'YES' : 'NO'}`);
    if (isHost) {
      console.log(`Host info:`, hostInfo);
    }
    
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
    
    // Clean up pending permanent access notifications for this socket
    if (pendingPermanentAccessNotifications[socket.id]) {
      delete pendingPermanentAccessNotifications[socket.id];
    }
    
    // Check if clientToHostMap exists and clean up any associated connections
    if (clientToHostMap) {
      console.log(`Current clientToHostMap:`, clientToHostMap);
      
      for (const [clientId, hostData] of Object.entries(clientToHostMap)) {
        // Check if the value is an object with timestamp or just a string
        if (typeof hostData === 'object' && hostData.hostId) {
          if (clientId === socket.id || hostData.hostId === socket.id) {
            // If this is a host disconnecting, notify the connected client
            if (hostData.hostId === socket.id && hostInfo) {
              console.log(`Notifying client ${clientId} that host ${socket.id} disconnected`);
              const clientSocket = io.sockets.sockets.get(clientId);
              if (clientSocket) {
                clientSocket.emit("host-disconnected", {
                  hostId: socket.id,
                  computerName: hostInfo.computerName,
                  machineId: hostInfo.machineId,
                  reason: reason
                });
                console.log(`Host disconnection notification sent to client ${clientId}`);
              } else {
                console.log(`Client ${clientId} not found in socket list`);
              }
            }
            delete clientToHostMap[clientId];
            console.log(`Cleaned up connection mapping for ${socket.id}`);
          }
        } else if (clientId === socket.id || hostData === socket.id) {
          // If this is a host disconnecting, notify the connected client
          if (hostData === socket.id && hostInfo) {
            console.log(`Notifying client ${clientId} that host ${socket.id} disconnected`);
            const clientSocket = io.sockets.sockets.get(clientId);
            if (clientSocket) {
              clientSocket.emit("host-disconnected", {
                hostId: socket.id,
                computerName: hostInfo.computerName,
                machineId: hostInfo.machineId,
                reason: reason
              });
              console.log(`Host disconnection notification sent to client ${clientId}`);
            } else {
              console.log(`Client ${clientId} not found in socket list`);
            }
          }
          delete clientToHostMap[clientId];
          console.log(`Cleaned up connection mapping for ${socket.id}`);
        }
      }
    }
    
    // If this was a host, also check for any clients that might be connected to this host
    // and notify them about the disconnection
    if (isHost) {
      console.log(`Host ${socket.id} disconnected, notifying all connected clients`);
      
      // Find all clients connected to this host
      for (const [clientId, hostData] of Object.entries(clientToHostMap)) {
        const connectedHostId = typeof hostData === 'object' ? hostData.hostId : hostData;
        
        if (connectedHostId === socket.id) {
          console.log(`Notifying client ${clientId} about host ${socket.id} disconnection`);
          const clientSocket = io.sockets.sockets.get(clientId);
          if (clientSocket) {
            clientSocket.emit("host-disconnected", {
              hostId: socket.id,
              computerName: hostInfo.computerName,
              machineId: hostInfo.machineId,
              reason: reason
            });
            console.log(`Host disconnection notification sent to client ${clientId}`);
          } else {
            console.log(`Client ${clientId} not found in socket list`);
          }
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

// Test endpoint to check permanent access data
app.get('/api/test-permanent-access', async (req, res) => {
  try {
    console.log("Testing permanent access endpoint...");
    
    // Check if we can connect to the database
    if (mongoose.connection.readyState !== 1) {
      return res.status(500).json({ 
        success: false, 
        message: "Database not connected",
        readyState: mongoose.connection.readyState
      });
    }
    
    // Try to find all permanent access records
    const allRecords = await PermanentAccess.find({});
    console.log("Found permanent access records:", allRecords.length);
    
    res.json({
      success: true,
      message: "Database connection working",
      recordCount: allRecords.length,
      records: allRecords
    });
  } catch (error) {
    console.error("Error testing permanent access:", error);
    res.status(500).json({
      success: false,
      message: "Error testing permanent access: " + error.message
    });
  }
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

