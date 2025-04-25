const mongoose = require('mongoose');

const PermanentAccessSchema = new mongoose.Schema({
    hostMachineId: {
        type: String,
        required: true,
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    accessPassword: {
        type: String,
        required: true
    },
    label: {
        type: String,
        default: 'My Computer'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastAccessedAt: {
        type: Date,
        default: Date.now
    }
});

// Compound index to ensure one user can have only one entry per machine
PermanentAccessSchema.index({ hostMachineId: 1, userId: 1 }, { unique: true });

const PermanentAccess = mongoose.model('PermanentAccess', PermanentAccessSchema);

module.exports = PermanentAccess;
