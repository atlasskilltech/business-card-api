const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const authenticate = require('../middleware/authenticate');
const gmailService = require('../services/gmailService');

// @route   GET /api/email/drafts
// @desc    Get Gmail drafts
// @access  Private
router.get('/drafts', authenticate, async (req, res) => {
  try {
    const result = await gmailService.getDrafts(req.user.id);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch drafts',
        error: result.error
      });
    }

    res.json({
      success: true,
      drafts: result.drafts
    });

  } catch (error) {
    console.error('Get drafts error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch drafts' });
  }
});

// @route   GET /api/email/drafts/:draftId
// @desc    Get draft content
// @access  Private
router.get('/drafts/:draftId', authenticate, async (req, res) => {
  try {
    const result = await gmailService.getDraftContent(req.user.id, req.params.draftId);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch draft content',
        error: result.error
      });
    }

    res.json({
      success: true,
      subject: result.subject,
      body: result.body
    });

  } catch (error) {
    console.error('Get draft content error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch draft content' });
  }
});

// @route   POST /api/email/campaigns
// @desc    Create and send email campaign
// @access  Private
router.post('/campaigns', authenticate, async (req, res) => {
  try {
    const { campaignName, senderName, draftId, subject, body, cardIds, customNotes } = req.body;

    if (!campaignName || !senderName || !subject || !body || !cardIds || !Array.isArray(cardIds) || cardIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Campaign name, sender name, subject, body, and card IDs are required'
      });
    }

    // Get cards
    const placeholders = cardIds.map(() => '?').join(',');
    const [cards] = await pool.query(
      `SELECT * FROM business_cards WHERE id IN (${placeholders}) AND user_id = ?`,
      [...cardIds, req.user.id]
    );

    if (cards.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No cards found'
      });
    }

    // Create campaign
    const [campaignResult] = await pool.query(
      `INSERT INTO email_campaigns 
       (user_id, campaign_name, draft_id, subject, total_recipients, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'in_progress', NOW())`,
      [req.user.id, campaignName, draftId || null, subject, cards.length]
    );

    const campaignId = campaignResult.insertId;

    // Helper function to replace parameters
    const replaceParameters = (text, card, customNote = '', senderName = '') => {
      if (!text) return '';
      
      const firstName = card.name ? card.name.split(' ')[0] : '';
      const lastName = card.name ? card.name.split(' ').slice(1).join(' ') : '';
      
      console.log('Replacing parameters for:', card.name);
      console.log('Original text:', text.substring(0, 100) + '...');
      
      let result = text
        .replace(/\{\{name\}\}/g, card.name || '')
        .replace(/\{\{first_name\}\}/g, firstName)
        .replace(/\{\{last_name\}\}/g, lastName)
        .replace(/\{\{email\}\}/g, card.email || '')
        .replace(/\{\{company\}\}/g, card.company || '')
        .replace(/\{\{job_title\}\}/g, card.job_title || '')
        .replace(/\{\{phone\}\}/g, card.phone || '')
        .replace(/\{\{website\}\}/g, card.website || '')
        .replace(/\{\{custom_note\}\}/g, customNote)
        .replace(/\{\{sender_name\}\}/g, senderName);
      
      console.log('After replacement:', result.substring(0, 100) + '...');
      return result;
    };

    // Prepare recipients with personalized content
    const recipients = cards.map(card => ({
      id: card.id,
      email: card.email,
      name: card.name,
      personalizedSubject: replaceParameters(subject, card, customNotes?.[card.id] || '', senderName),
      personalizedBody: replaceParameters(body, card, customNotes?.[card.id] || '', senderName),
      customNote: customNotes?.[card.id] || ''
    }));

    // Send emails with personalized content
    const sendResults = [];
    let sentCount = 0;
    let failedCount = 0;

    for (const recipient of recipients) {
      try {
        const emailResult = await gmailService.sendEmail(
          req.user.id,
          recipient.email,
          recipient.personalizedSubject,
          recipient.personalizedBody,
          '' // customNote already in body
        );

        const status = emailResult.success ? 'sent' : 'failed';
        if (emailResult.success) sentCount++;
        else failedCount++;

        await pool.query(
          `INSERT INTO sent_emails 
           (user_id, campaign_id, card_id, recipient_email, recipient_name, subject, status, custom_note, error_message, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            req.user.id,
            campaignId,
            recipient.id,
            recipient.email,
            recipient.name || '',
            recipient.personalizedSubject,
            status,
            recipient.customNote,
            emailResult.error || null
          ]
        );

        sendResults.push({
          recipientId: recipient.id,
          email: recipient.email,
          success: emailResult.success,
          messageId: emailResult.messageId || null,
          error: emailResult.error || null
        });

        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Error sending to ${recipient.email}:`, error);
        failedCount++;
        
        await pool.query(
          `INSERT INTO sent_emails 
           (user_id, campaign_id, card_id, recipient_email, recipient_name, subject, status, custom_note, error_message, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, NOW())`,
          [
            req.user.id,
            campaignId,
            recipient.id,
            recipient.email,
            recipient.name || '',
            recipient.personalizedSubject,
            recipient.customNote,
            error.message
          ]
        );
      }
    }

    // Update campaign
    await pool.query(
      `UPDATE email_campaigns SET
        sent_count = ?,
        failed_count = ?,
        status = 'completed',
        completed_at = NOW()
      WHERE id = ?`,
      [sentCount, failedCount, campaignId]
    );

    res.json({
      success: true,
      message: `Campaign "${campaignName}" completed. ${sentCount} sent, ${failedCount} failed.`,
      campaign: {
        id: campaignId,
        name: campaignName,
        senderName,
        sentCount,
        failedCount,
        totalRecipients: cards.length
      },
      results: sendResults
    });

  } catch (error) {
    console.error('Create campaign error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create campaign',
      error: error.message
    });
  }
});

// @route   GET /api/email/campaigns
// @desc    Get all campaigns
// @access  Private
router.get('/campaigns', authenticate, async (req, res) => {
  try {
    const [campaigns] = await pool.query(
      `SELECT * FROM email_campaigns 
       WHERE user_id = ? 
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({
      success: true,
      campaigns
    });

  } catch (error) {
    console.error('Get campaigns error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch campaigns' });
  }
});

// @route   GET /api/email/campaigns/:id
// @desc    Get campaign details
// @access  Private
router.get('/campaigns/:id', authenticate, async (req, res) => {
  try {
    const [campaigns] = await pool.query(
      'SELECT * FROM email_campaigns WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (campaigns.length === 0) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    // Get sent emails
    const [sentEmails] = await pool.query(
      `SELECT se.*, bc.name as card_name, bc.company
       FROM sent_emails se
       LEFT JOIN business_cards bc ON se.card_id = bc.id
       WHERE se.campaign_id = ?
       ORDER BY se.sent_at DESC`,
      [req.params.id]
    );

    res.json({
      success: true,
      campaign: campaigns[0],
      sentEmails
    });

  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch campaign' });
  }
});

// @route   GET /api/email/sent
// @desc    Get all sent emails
// @access  Private
router.get('/sent', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const [sentEmails] = await pool.query(
      `SELECT se.*, bc.name as card_name, bc.company, ec.campaign_name
       FROM sent_emails se
       LEFT JOIN business_cards bc ON se.card_id = bc.id
       LEFT JOIN email_campaigns ec ON se.campaign_id = ec.id
       WHERE se.user_id = ?
       ORDER BY se.sent_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, parseInt(limit), parseInt(offset)]
    );

    const [countResult] = await pool.query(
      'SELECT COUNT(*) as total FROM sent_emails WHERE user_id = ?',
      [req.user.id]
    );

    res.json({
      success: true,
      sentEmails,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult[0].total,
        pages: Math.ceil(countResult[0].total / limit)
      }
    });

  } catch (error) {
    console.error('Get sent emails error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch sent emails' });
  }
});

// @route   GET /api/email/stats
// @desc    Get email statistics
// @access  Private
router.get('/stats', authenticate, async (req, res) => {
  try {
    const [stats] = await pool.query(
      `SELECT 
        COUNT(*) as total_sent,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM sent_emails WHERE user_id = ?`,
      [req.user.id]
    );

    const [campaignStats] = await pool.query(
      `SELECT 
        COUNT(*) as total_campaigns,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_campaigns
      FROM email_campaigns WHERE user_id = ?`,
      [req.user.id]
    );

    res.json({
      success: true,
      stats: {
        ...stats[0],
        ...campaignStats[0]
      }
    });

  } catch (error) {
    console.error('Get email stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

module.exports = router;