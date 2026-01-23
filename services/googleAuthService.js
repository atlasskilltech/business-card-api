const { google } = require('googleapis');
const { pool } = require('../config/database');

class GoogleAuthService {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    this.scopes = [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/contacts',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send'
    ];
  }

  getAuthUrl() {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: this.scopes,
      prompt: 'consent'
    });
  }

  async getTokensFromCode(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    return tokens;
  }

  async getUserInfo(accessToken) {
    this.oauth2Client.setCredentials({ access_token: accessToken });
    
    const oauth2 = google.oauth2({
      auth: this.oauth2Client,
      version: 'v2'
    });

    const { data } = await oauth2.userinfo.get();
    return data;
  }

  async refreshAccessToken(refreshToken) {
    this.oauth2Client.setCredentials({ refresh_token: refreshToken });
    
    const { credentials } = await this.oauth2Client.refreshAccessToken();
    return credentials;
  }

  getAuthClient(tokens) {
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    
    client.setCredentials(tokens);
    return client;
  }

  async ensureValidToken(userId) {
    const [users] = await pool.query(
      'SELECT access_token, refresh_token, token_expiry FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      throw new Error('User not found');
    }

    const user = users[0];
    const now = Date.now();

    // Check if token is expired or about to expire (5 min buffer)
    if (user.token_expiry && user.token_expiry < now + 300000) {
      try {
        const newTokens = await this.refreshAccessToken(user.refresh_token);
        
        // Update tokens in database
        await pool.query(
          `UPDATE users SET 
            access_token = ?, 
            token_expiry = ?
          WHERE id = ?`,
          [newTokens.access_token, newTokens.expiry_date, userId]
        );

        return {
          access_token: newTokens.access_token,
          refresh_token: user.refresh_token
        };
      } catch (error) {
        console.error('Token refresh error:', error);
        throw new Error('Failed to refresh access token');
      }
    }

    return {
      access_token: user.access_token,
      refresh_token: user.refresh_token
    };
  }
}

module.exports = new GoogleAuthService();