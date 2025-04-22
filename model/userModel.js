const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        required: true,
        unique: true,
        match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    },
    password: {
        type: String,
        required: true
    },
    profileImage: {
        type: String,
        default: 'Images/superadminimg.jpg'
    }
});

// The second parameter to model() is the schema
const Users = mongoose.model('User', UserSchema);

module.exports = Users;
