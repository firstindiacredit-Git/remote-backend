const express = require('express');
const router = express.Router();
const PermanentAccess = require('../model/permanentAccessModel');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Middleware to verify token
const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Access denied. No token provided.'
        });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        res.status(400).json({
            success: false,
            message: 'Invalid token.'
        });
    }
};

// Create new permanent access
router.post('/create', verifyToken, async (req, res) => {
    try {
        const { hostMachineId, accessPassword, label } = req.body;
        const userId = req.user.id;

        // Hash the access password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(accessPassword, salt);

        // Check if entry already exists
        const existingAccess = await PermanentAccess.findOne({ hostMachineId, userId });
        
        if (existingAccess) {
            // Update existing access
            existingAccess.accessPassword = hashedPassword;
            if (label) existingAccess.label = label;
            await existingAccess.save();
            
            return res.status(200).json({
                success: true,
                message: 'Permanent access updated successfully'
            });
        }

        // Create new access
        const newAccess = new PermanentAccess({
            hostMachineId,
            userId,
            accessPassword: hashedPassword,
            label: label || 'My Computer'
        });

        await newAccess.save();
        
        res.status(201).json({
            success: true,
            message: 'Permanent access created successfully'
        });
    } catch (error) {
        console.error('Error creating permanent access:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get all permanent access entries for user
router.get('/list', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const accessEntries = await PermanentAccess.find({ userId })
            .select('-accessPassword'); // Don't send the hashed password
        
        res.status(200).json({
            success: true,
            data: accessEntries
        });
    } catch (error) {
        console.error('Error fetching permanent access list:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Delete permanent access
router.delete('/delete/:id', verifyToken, async (req, res) => {
    try {
        const accessId = req.params.id;
        const userId = req.user.id;
        
        const result = await PermanentAccess.findOneAndDelete({
            _id: accessId,
            userId
        });
        
        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Access entry not found or unauthorized'
            });
        }
        
        res.status(200).json({
            success: true,
            message: 'Permanent access deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting permanent access:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Verify if a permanent access exists and is valid
router.post('/verify', verifyToken, async (req, res) => {
    try {
        const { hostMachineId, accessPassword } = req.body;
        const userId = req.user.id;
        
        const accessEntry = await PermanentAccess.findOne({ hostMachineId, userId });
        
        if (!accessEntry) {
            return res.status(404).json({
                success: false,
                message: 'No permanent access found for this machine'
            });
        }
        
        // Verify password
        const isValid = await bcrypt.compare(accessPassword, accessEntry.accessPassword);
        
        if (!isValid) {
            return res.status(400).json({
                success: false,
                message: 'Invalid access password'
            });
        }
        
        // Update last accessed
        accessEntry.lastAccessedAt = Date.now();
        await accessEntry.save();
        
        res.status(200).json({
            success: true,
            message: 'Access verified successfully'
        });
    } catch (error) {
        console.error('Error verifying permanent access:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

module.exports = router;
