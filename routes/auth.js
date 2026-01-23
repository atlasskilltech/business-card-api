const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const googleAuthService = require('../services/googleAuthService');
const authenticate = require('../middleware/authenticate');

// @route   GET /api/auth/google
// @desc    Get Google OAuth URL
// @access  Public
router.get('/google', (req, res) => {
  try {
    const authUrl = googleAuthService.getAuthUrl();
    res.json({ success: true, authUrl });
  } catch (error) {
    console.error('Auth URL error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate auth URL' });
  }
});

// @route   POST /api/auth/google/callback
// @desc    Handle Google OAuth callback
// @access  Public
router.post('/google/callback', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, message: 'Authorization code is required' });
    }

    // Exchange code for tokens
    const tokens = await googleAuthService.getTokensFromCode(code);

    // Get user info
    const userInfo = await googleAuthService.getUserInfo(tokens.access_token);

    // Check if user exists
    const [existingUsers] = await pool.query(
      'SELECT * FROM users WHERE google_id = ?',
      [userInfo.id]
    );

    let userId;

    if (existingUsers.length > 0) {
      // Update existing user
      userId = existingUsers[0].id;
      await pool.query(
        `UPDATE users SET 
          email = ?,
          name = ?,
          picture = ?,
          access_token = ?,
          refresh_token = ?,
          token_expiry = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [
          userInfo.email,
          userInfo.name,
          userInfo.picture,
          tokens.access_token,
          tokens.refresh_token || existingUsers[0].refresh_token,
          tokens.expiry_date,
          userId
        ]
      );
    } else {
      // Create new user
      const [result] = await pool.query(
        `INSERT INTO users (google_id, email, name, picture, access_token, refresh_token, token_expiry)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          userInfo.id,
          userInfo.email,
          userInfo.name,
          userInfo.picture,
          tokens.access_token,
          tokens.refresh_token,
          tokens.expiry_date
        ]
      );
      userId = result.insertId;
    }

    // Generate JWT
    const jwtToken = jwt.sign(
      { userId, email: userInfo.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Get updated user info
    const [users] = await pool.query(
      'SELECT id, google_id, email, name, picture FROM users WHERE id = ?',
      [userId]
    );

    res.json({
      success: true,
      token: jwtToken,
      user: users[0]
    });

  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Authentication failed',
      error: error.message 
    });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', authenticate, async (req, res) => {
  try {
    res.json({
      success: true,
      user: req.user
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Failed to get user info' });
  }
});

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post('/logout', authenticate, async (req, res) => {
  try {
    // Optionally clear tokens from database
    // await pool.query('UPDATE users SET access_token = NULL WHERE id = ?', [req.user.id]);
    
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ success: false, message: 'Logout failed' });
  }
});

module.exports = router;