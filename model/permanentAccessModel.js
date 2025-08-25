const mongoose = require('mongoose');

const PermanentAccessSchema = new mongoose.Schema({
    machineId: {
        type: String,
        required: true,
        unique: true
    },
    computerName: {
        type: String,
        required: true
    },
    accessCredentials: [{
        label: {
            type: String,
            required: true
        },
        password: {
            type: String,
            required: true
        },
        clientId: {
            type: String,
            required: true
        },
        createdAt: {
            type: Date,
            default: Date.now
        },
        lastUsed: {
            type: Date,
            default: Date.now
        }
    }],
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Update the updatedAt field before saving
PermanentAccessSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

const PermanentAccess = mongoose.model('PermanentAccess', PermanentAccessSchema);

module.exports = PermanentAccess;
