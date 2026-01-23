const { google } = require('googleapis');
const googleAuthService = require('./googleAuthService');

class GmailService {
  async getDrafts(userId) {
    try {
      const tokens = await googleAuthService.ensureValidToken(userId);
      const authClient = googleAuthService.getAuthClient(tokens);

      const gmail = google.gmail({ version: 'v1', auth: authClient });

      const response = await gmail.users.drafts.list({
        userId: 'me'
      });

      if (!response.data.drafts) {
        return { success: true, drafts: [] };
      }

      // Get full draft details
      const drafts = await Promise.all(
        response.data.drafts.map(async (draft) => {
          const details = await gmail.users.drafts.get({
            userId: 'me',
            id: draft.id,
            format: 'full'
          });

          const message = details.data.message;
          const headers = message.payload.headers;
          
          const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
          const snippet = message.snippet || '';

          return {
            id: draft.id,
            subject: subject,
            snippet: snippet,
            messageId: message.id
          };
        })
      );

      return { success: true, drafts };

    } catch (error) {
      console.error('Get drafts error:', error);
      return { success: false, error: error.message, drafts: [] };
    }
  }

  async getDraftContent(userId, draftId) {
    try {
      const tokens = await googleAuthService.ensureValidToken(userId);
      const authClient = googleAuthService.getAuthClient(tokens);

      const gmail = google.gmail({ version: 'v1', auth: authClient });

      const response = await gmail.users.drafts.get({
        userId: 'me',
        id: draftId,
        format: 'full'
      });

      const message = response.data.message;
      const headers = message.payload.headers;
      
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      
      // Get body content
      let body = '';
      if (message.payload.body.data) {
        body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
      } else if (message.payload.parts) {
        const textPart = message.payload.parts.find(part => part.mimeType === 'text/html' || part.mimeType === 'text/plain');
        if (textPart && textPart.body.data) {
          body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        }
      }

      return {
        success: true,
        subject,
        body
      };

    } catch (error) {
      console.error('Get draft content error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async sendEmail(userId, to, subject, body, customNote = '') {
    try {
      const tokens = await googleAuthService.ensureValidToken(userId);
      const authClient = googleAuthService.getAuthClient(tokens);

      const gmail = google.gmail({ version: 'v1', auth: authClient });

      // The body is already personalized from the routes
      // Convert newlines to <br> tags for HTML email
      let finalBody = body;
      
      // If body doesn't contain HTML tags, convert newlines to <br>
      if (!body.includes('<html') && !body.includes('<div')) {
        finalBody = body
          .split('\n')
          .map(line => line.trim())
          .join('<br>\n');
      }

      // Create email with proper MIME format
      const email = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=utf-8',
        '',
        finalBody
      ].join('\n');

      const encodedEmail = Buffer.from(email)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedEmail
        }
      });

      return {
        success: true,
        messageId: response.data.id
      };

    } catch (error) {
      console.error('Send email error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async sendBulkEmails(userId, recipients, subject, body) {
    const results = [];

    for (const recipient of recipients) {
      const result = await this.sendEmail(
        userId,
        recipient.email,
        subject,
        body,
        recipient.customNote || ''
      );

      results.push({
        recipientId: recipient.id,
        email: recipient.email,
        success: result.success,
        messageId: result.messageId || null,
        error: result.error || null
      });

      // Add delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }
}

module.exports = new GmailService();