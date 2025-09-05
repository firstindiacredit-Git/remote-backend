const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Users = require('../model/userModel');

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';


// Registration route
router.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Check if user already exists
        const existingUser = await Users.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ 
                success: false, 
                message: 'User with this email already exists' 
            });
        }

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create new user
        const newUser = new Users({
            username,
            email,
            password: hashedPassword
        });

        // Save user to database
        await newUser.save();
        
        res.status(201).json({
            success: true,
            message: 'User registered successfully'
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error during registration' 
        });
    }
});

// Login route
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Check if user exists
        const user = await Users.findOne({ email });
        if (!user) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid email or password' 
            });
        }

        // Validate password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid email or password' 
            });
        }

        // Create JWT token
        const token = jwt.sign(
            { id: user._id, email: user.email },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Return success with token and user info (excluding password)
        const userObject = user.toObject();
        delete userObject.password;

        res.status(200).json({
            success: true,
            token,
            user: userObject
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error during login' 
        });
    }
});

// Get current user (protected route)
router.get('/me', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ 
                success: false, 
                message: 'No token provided' 
            });
        }
        
        // Verify token
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Get user from database
        const user = await Users.findById(decoded.id).select('-password');
        
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                message: 'User not found' 
            });
        }
        
        res.status(200).json({
            success: true,
            user
        });
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(401).json({ 
            success: false, 
            message: 'Invalid token' 
        });
    }
});

module.exports = router;
