const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const authenticate = require('../middleware/authenticate');
const { upload, handleUploadError } = require('../middleware/upload');
const mistralService = require('../services/mistralService');
const googleContactsService = require('../services/googleContactsService');
const path = require('path');

// @route   POST /api/cards/scan
// @desc    Upload and scan business card
// @access  Private
router.post('/scan', authenticate, upload.single('card'), handleUploadError, async (req, res) => {
  try {
    console.log('📸 Scan card request received');
    console.log('User ID:', req.user.id);
    console.log('File uploaded:', req.file ? 'Yes' : 'No');
    
    if (!req.file) {
      console.error('❌ No file in request');
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    console.log('✅ File details:', {
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
      path: req.file.path
    });

    const imagePath = req.file.path;
    const imageUrl = `/uploads/${req.file.filename}`;

    // Extract info using Mistral AI
    console.log('🤖 Processing image with Mistral AI...');
    const extractionResult = await mistralService.extractCardInfo(imagePath);

    // Check for rate limit
    if (extractionResult.rateLimited) {
      console.error('❌ Rate limit exceeded');
      return res.status(429).json({
        success: false,
        message: 'Mistral AI rate limit exceeded. Please wait a few minutes and try again.',
        error: 'Rate limit exceeded',
        rateLimited: true,
        help: 'Free tier: 5 requests/minute. Wait 60 seconds or upgrade at console.mistral.ai'
      });
    }

    if (!extractionResult.success) {
      console.error('❌ Mistral extraction failed:', extractionResult.error);
      
      // Check if it's an API key issue
      if (extractionResult.error && extractionResult.error.includes('API key')) {
        return res.status(500).json({
          success: false,
          message: 'Mistral AI API key is not configured. Please set MISTRAL_API_KEY in backend/.env',
          error: 'API key missing or invalid',
          help: 'Get your API key from https://console.mistral.ai'
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Failed to extract card information',
        error: extractionResult.error
      });
    }

    // Check if fallback was used
    if (extractionResult.fallback) {
      console.log('⚠️  Using fallback - manual entry required');
    }

    console.log('✅ Mistral extraction successful:', extractionResult.data);

    // Save to database
    console.log('💾 Saving to database...');
    const [result] = await pool.query(
      `INSERT INTO business_cards 
       (user_id, name, email, phone, company, job_title, address, website, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        extractionResult.data.name,
        extractionResult.data.email,
        extractionResult.data.phone,
        extractionResult.data.company,
        extractionResult.data.job_title,
        extractionResult.data.address,
        extractionResult.data.website,
        imageUrl
      ]
    );

    const cardId = result.insertId;
    console.log('✅ Card saved with ID:', cardId);

    // Get the created card
    const [cards] = await pool.query(
      'SELECT * FROM business_cards WHERE id = ?',
      [cardId]
    );

    const card = cards[0];

    // ✅ FIX: convert relative path to full URL
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    card.image_url = card.image_url
      ? `${baseUrl}${card.image_url}`
      : null;

    console.log('🎉 Scan complete! Returning card data');

    res.json({
      success: true,
      message: 'Card scanned successfully',
      card
    });

  } catch (error) {
    console.error('❌ Scan card error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to scan card',
      error: error.message 
    });
  }
});

// @route   GET /api/cards
// @desc    Get all cards for user
// @access  Private
router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM business_cards WHERE user_id = ?';
    const params = [req.user.id];

    if (search) {
      query += ' AND (name LIKE ? OR email LIKE ? OR company LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [cards] = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM business_cards WHERE user_id = ?';
    const countParams = [req.user.id];

    if (search) {
      countQuery += ' AND (name LIKE ? OR email LIKE ? OR company LIKE ?)';
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm, searchTerm);
    }

    const [countResult] = await pool.query(countQuery, countParams);
    const total = countResult[0].total;

    res.json({
      success: true,
      cards,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get cards error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch cards' });
  }
});

// @route   GET /api/cards/:id
// @desc    Get single card
// @access  Private
router.get('/:id', authenticate, async (req, res) => {
  try {
    const [cards] = await pool.query(
      'SELECT * FROM business_cards WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (cards.length === 0) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    res.json({ success: true, card: cards[0] });

  } catch (error) {
    console.error('Get card error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch card' });
  }
});

// @route   PUT /api/cards/:id
// @desc    Update card
// @access  Private
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { name, email, phone, company, job_title, address, website, notes } = req.body;

    const [cards] = await pool.query(
      'SELECT * FROM business_cards WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (cards.length === 0) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    await pool.query(
      `UPDATE business_cards SET
        name = ?, email = ?, phone = ?, company = ?,
        job_title = ?, address = ?, website = ?, notes = ?
      WHERE id = ? AND user_id = ?`,
      [name, email, phone, company, job_title, address, website, notes, req.params.id, req.user.id]
    );

    const [updatedCards] = await pool.query(
      'SELECT * FROM business_cards WHERE id = ?',
      [req.params.id]
    );

    res.json({
      success: true,
      message: 'Card updated successfully',
      card: updatedCards[0]
    });

  } catch (error) {
    console.error('Update card error:', error);
    res.status(500).json({ success: false, message: 'Failed to update card' });
  }
});

// @route   DELETE /api/cards/:id
// @desc    Delete card
// @access  Private
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM business_cards WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    res.json({ success: true, message: 'Card deleted successfully' });

  } catch (error) {
    console.error('Delete card error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete card' });
  }
});

// @route   POST /api/cards/:id/sync
// @desc    Sync card to Google Contacts
// @access  Private
router.post('/:id/sync', authenticate, async (req, res) => {
  try {
    const [cards] = await pool.query(
      'SELECT * FROM business_cards WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (cards.length === 0) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    const card = cards[0];

    // Sync to Google Contacts
    const syncResult = await googleContactsService.syncContact(req.user.id, card);

    if (!syncResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to sync to Google Contacts',
        error: syncResult.error
      });
    }

    // Update card with sync info
    await pool.query(
      'UPDATE business_cards SET synced_to_google = TRUE, google_contact_id = ? WHERE id = ?',
      [syncResult.contactId, req.params.id]
    );

    res.json({
      success: true,
      message: 'Card synced to Google Contacts successfully',
      contactId: syncResult.contactId
    });

  } catch (error) {
    console.error('Sync card error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to sync card',
      error: error.message 
    });
  }
});

// @route   POST /api/cards/batch-sync
// @desc    Batch sync multiple cards
// @access  Private
router.post('/batch-sync', authenticate, async (req, res) => {
  try {
    const { cardIds } = req.body;

    if (!cardIds || !Array.isArray(cardIds) || cardIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Card IDs are required' });
    }

    // Get cards
    const placeholders = cardIds.map(() => '?').join(',');
    const [cards] = await pool.query(
      `SELECT * FROM business_cards WHERE id IN (${placeholders}) AND user_id = ?`,
      [...cardIds, req.user.id]
    );

    if (cards.length === 0) {
      return res.status(404).json({ success: false, message: 'No cards found' });
    }

    // Batch sync
    const results = await googleContactsService.batchSyncContacts(req.user.id, cards);

    // Update synced cards
    for (const result of results) {
      if (result.success) {
        await pool.query(
          'UPDATE business_cards SET synced_to_google = TRUE, google_contact_id = ? WHERE id = ?',
          [result.googleContactId, result.contactId]
        );
      }
    }

    const successCount = results.filter(r => r.success).length;

    res.json({
      success: true,
      message: `${successCount} out of ${results.length} cards synced successfully`,
      results
    });

  } catch (error) {
    console.error('Batch sync error:', error);
    res.status(500).json({ success: false, message: 'Batch sync failed' });
  }
});

// @route   GET /api/cards/stats
// @desc    Get cards statistics
// @access  Private
router.get('/dashboard/stats', authenticate, async (req, res) => {
  try {
    const [stats] = await pool.query(
      `SELECT 
        COUNT(*) as total_cards,
        SUM(CASE WHEN synced_to_google = TRUE THEN 1 ELSE 0 END) as synced_cards,
        COUNT(DISTINCT DATE(created_at)) as active_days
      FROM business_cards WHERE user_id = ?`,
      [req.user.id]
    );

    res.json({
      success: true,
      stats: stats[0]
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

module.exports = router;
