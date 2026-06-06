const express = require('express');
const router = express.Router();
const { HTTP_STATUS, RESPONSE_CODES, ERROR_MESSAGES } = require('../constants');
const { pool } = require('../config/config');
const { authenticateToken } = require('../middleware/auth');

// 获取评论通知
router.get('/comments', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const query = `
      SELECT n.*, 
             u.id as from_user_auto_id,
             u.nickname as from_nickname, 
             u.avatar as from_avatar, 
             u.user_id as from_user_id,
             u.verified as from_verified,
             p.title as post_title,
             p.type as post_type,
             p.user_id as post_author_id,
             CASE 
               WHEN p.type = 2 THEN (SELECT pv.cover_url FROM post_videos pv WHERE pv.post_id = p.id ORDER BY pv.id LIMIT 1)
               ELSE (SELECT pi.image_url FROM post_images pi WHERE pi.post_id = p.id ORDER BY pi.id LIMIT 1)
             END as post_image,
             c.content as comment_content,
             c.created_at as comment_created_at,
             c.like_count as comment_like_count,
             CASE 
               WHEN n.comment_id IS NOT NULL THEN 
                 CASE WHEN EXISTS(SELECT 1 FROM likes WHERE user_id = $1 AND target_type = 2 AND target_id = n.comment_id) 
                      THEN 1 ELSE 0 END
               ELSE 0
             END as comment_is_liked,
             CASE 
               WHEN n.type = 5 AND c.parent_id IS NOT NULL THEN 
                 (SELECT content FROM comments WHERE id = c.parent_id)
               ELSE NULL 
             END as parent_comment_content
      FROM notifications n
      LEFT JOIN users u ON n.sender_id = u.id
      LEFT JOIN posts p ON n.target_id = p.id
      LEFT JOIN comments c ON n.comment_id = c.id
      WHERE n.user_id = $2 AND n.type IN (4, 5, 7, 8)
      ORDER BY n.created_at DESC LIMIT $3 OFFSET $4
    `;

    const { rows } = await pool.query(query, [userId, userId, limit, offset]);

    // 获取总数
    const { rows: countResult } = await pool.query(
      'SELECT COUNT(*) as total FROM notifications WHERE user_id = $1 AND type IN (4, 5, 7, 8)',
      [userId]
    );
    const total = Number(countResult[0].total);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        notifications: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('获取评论通知失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取点赞通知
router.get('/likes', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const query = `
      SELECT n.*, 
             u.id as from_user_auto_id,
             u.nickname as from_nickname, 
             u.avatar as from_avatar, 
             u.user_id as from_user_id,
             u.verified as from_verified,
             p.title as post_title,
             p.type as post_type,
             p.user_id as post_author_id,
             CASE 
               WHEN p.type = 2 THEN (SELECT pv.cover_url FROM post_videos pv WHERE pv.post_id = p.id ORDER BY pv.id LIMIT 1)
               ELSE (SELECT pi.image_url FROM post_images pi WHERE pi.post_id = p.id ORDER BY pi.id LIMIT 1)
             END as post_image,
             CASE 
               WHEN n.type = 1 THEN 1
               WHEN n.type = 2 THEN 2
               ELSE 1
             END as target_type,
             CASE 
               WHEN n.type = 2 THEN n.comment_id
               ELSE NULL
             END as comment_id
      FROM notifications n
      LEFT JOIN users u ON n.sender_id = u.id
      LEFT JOIN posts p ON n.target_id = p.id
      WHERE n.user_id = $1 AND n.type IN (1, 2)
      ORDER BY n.created_at DESC LIMIT $2 OFFSET $3
    `;

    const { rows } = await pool.query(query, [userId, limit, offset]);

    // 获取总数
    const { rows: countResult } = await pool.query(
      'SELECT COUNT(*) as total FROM notifications WHERE user_id = $1 AND type IN (1, 2)',
      [userId]
    );
    const total = Number(countResult[0].total);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        notifications: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('获取点赞通知失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取关注通知
router.get('/follows', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const query = `
      SELECT n.*, 
             u.id as from_user_auto_id,
             u.nickname as from_nickname, 
             u.avatar as from_avatar, 
             u.user_id as from_user_id,
             u.verified as from_verified
      FROM notifications n
      LEFT JOIN users u ON n.sender_id = u.id
      WHERE n.user_id = $1 AND n.type = 6
      ORDER BY n.created_at DESC LIMIT $2 OFFSET $3
    `;

    const { rows } = await pool.query(query, [userId, limit, offset]);

    // 获取总数
    const { rows: countResult } = await pool.query(
      'SELECT COUNT(*) as total FROM notifications WHERE user_id = $1 AND type = $2',
      [userId, 6]
    );
    const total = Number(countResult[0].total);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        notifications: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('获取关注通知失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取收藏通知
router.get('/collections', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const query = `
      SELECT n.*, 
             u.id as from_user_auto_id,
             u.nickname as from_nickname, 
             u.avatar as from_avatar, 
             u.user_id as from_user_id,
             u.verified as from_verified,
             p.title as post_title,
             p.type as post_type,
             CASE 
               WHEN p.type = 2 THEN (SELECT pv.cover_url FROM post_videos pv WHERE pv.post_id = p.id ORDER BY pv.id LIMIT 1)
               ELSE (SELECT pi.image_url FROM post_images pi WHERE pi.post_id = p.id ORDER BY pi.id LIMIT 1)
             END as post_image
      FROM notifications n
      LEFT JOIN users u ON n.sender_id = u.id
      LEFT JOIN posts p ON n.target_id = p.id
      WHERE n.user_id = $1 AND n.type = 3
      ORDER BY n.created_at DESC LIMIT $2 OFFSET $3
    `;

    const { rows } = await pool.query(query, [userId, limit, offset]);

    // 获取总数
    const { rows: countResult } = await pool.query(
      'SELECT COUNT(*) as total FROM notifications WHERE user_id = $1 AND type = $2',
      [userId, 3]
    );
    const total = Number(countResult[0].total);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        notifications: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('获取收藏通知失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取通知列表（通用接口）
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const type = req.query.type; // comment, like, follow
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let paramIndex = 0;
    const $p = () => `$${++paramIndex}`;

    let query = `
      SELECT n.*, 
             u.id as from_user_auto_id,
             u.nickname as from_nickname, 
             u.avatar as from_avatar, 
             u.user_id as from_user_id,
             u.verified
      FROM notifications n
      LEFT JOIN users u ON n.sender_id = u.id
      WHERE n.user_id = ${$p()}
    `;
    let queryParams = [userId];

    if (type) {
      query += ` AND n.type = ${$p()}`;
      queryParams.push(type);
    }

    query += ` ORDER BY n.created_at DESC LIMIT ${$p()} OFFSET ${$p()}`;
    queryParams.push(limit, offset);

    const { rows } = await pool.query(query, queryParams);

    // 获取总数
    let countParamIndex = 0;
    const $c = () => `$${++countParamIndex}`;
    let countQuery = `SELECT COUNT(*) as total FROM notifications WHERE user_id = ${$c()}`;
    let countParams = [userId];
    if (type) {
      countQuery += ` AND type = ${$c()}`;
      countParams.push(type);
    }

    const { rows: countResult } = await pool.query(countQuery, countParams);
    const total = Number(countResult[0].total);

    // 获取未读数量
    const { rows: unreadResult } = await pool.query(
      'SELECT COUNT(*) as unread FROM notifications WHERE user_id = $1 AND is_read = 0',
      [userId]
    );
    const unread = Number(unreadResult[0].unread);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        notifications: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        },
        unread
      }
    });
  } catch (error) {
    console.error('获取通知列表失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 标记通知为已读
router.put('/:id/read', authenticateToken, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user.id;

    // 验证通知是否属于当前用户
    const notificationResult = await pool.query(
      'SELECT id FROM notifications WHERE id = $1 AND user_id = $2',
      [notificationId, userId]
    );

    if (notificationResult.rows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '通知不存在' });
    }

    // 标记为已读
    await pool.query(
      'UPDATE notifications SET is_read = 1 WHERE id = $1',
      [notificationId]
    );

    res.json({ code: RESPONSE_CODES.SUCCESS, message: '标记成功' });
  } catch (error) {
    console.error('标记通知已读失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 标记所有通知为已读
router.put('/read-all', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    await pool.query(
      'UPDATE notifications SET is_read = 1 WHERE user_id = $1 AND is_read = 0',
      [userId]
    );

    res.json({ code: RESPONSE_CODES.SUCCESS, message: '全部标记成功' });
  } catch (error) {
    console.error('标记所有通知已读失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 删除通知
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user.id;

    const result = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
      [notificationId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '通知不存在' });
    }

    res.json({ code: RESPONSE_CODES.SUCCESS, message: '删除成功' });
  } catch (error) {
    console.error('删除通知失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取按类型分组的未读通知数量
router.get('/unread-count-by-type', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows } = await pool.query(
      `SELECT 
        SUM(CASE WHEN type IN (4, 5, 7, 8) THEN 1 ELSE 0 END) as comments,
        SUM(CASE WHEN type IN (1, 2) THEN 1 ELSE 0 END) as likes,
        SUM(CASE WHEN type = 3 THEN 1 ELSE 0 END) as collections,
        SUM(CASE WHEN type = 6 THEN 1 ELSE 0 END) as follows,
        COUNT(*) as total
      FROM notifications 
      WHERE user_id = $1 AND is_read = 0`,
      [userId]
    );

    const counts = rows[0];
    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        comments: parseInt(counts.comments || 0),
        likes: parseInt(counts.likes || 0),
        collections: parseInt(counts.collections || 0),
        follows: parseInt(counts.follows || 0),
        total: parseInt(counts.total || 0)
      }
    });
  } catch (error) {
    console.error('获取按类型分组的未读通知数量失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取未读通知数量
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows } = await pool.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = 0',
      [userId]
    );

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: { count: Number(rows[0].count) }
    });
  } catch (error) {
    console.error('获取未读通知数量失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

module.exports = router;
