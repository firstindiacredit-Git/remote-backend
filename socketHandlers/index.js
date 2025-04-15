// backend/socketHandlers/index.js

module.exports = (io, socket) => {
    // Forward mouse movement to controlled client
    socket.on("mouse_move", (data) => {
      socket.broadcast.emit("mouse_move", data);
    });
  
    // Forward key press
    socket.on("key_press", (data) => {
      socket.broadcast.emit("key_press", data);
    });
  
    // Add more events like mouse_click, clipboard, etc.
  };
  