const express = require('express');
const router = express.Router();
const { HTTP_STATUS, RESPONSE_CODES, ERROR_MESSAGES } = require('../constants');
const { pool } = require('../config/config');
const { optionalAuth, authenticateToken } = require('../middleware/auth');
const { execute: dbExec } = require('../utils/dbHelper');

// 统一解析 userId：纯数字直接用，否则通过 user_id 查找
async function resolveUserId(userIdParam) {
  if (/^\d+$/.test(userIdParam)) return parseInt(userIdParam)
  const { rows } = await dbExec('SELECT id FROM users WHERE user_id = ?', [userIdParam])
  if (rows.length === 0) throw new Error('USER_NOT_FOUND')
  return rows[0].id
}
const NotificationHelper = require('../utils/notificationHelper');
const { sanitizeContent } = require('../utils/contentSecurity');

// 搜索用户（必须放在 /:id 之前）
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const keyword = req.query.keyword;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const currentUserId = req.user ? req.user.id : null;

    if (!keyword) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '请输入搜索关键词' });
    }

    // 搜索用户：支持昵称和小蓝本号搜索
    const { rows } = await dbExec(
      `SELECT u.id, u.user_id, u.nickname, u.avatar, u.bio, u.location, u.follow_count, u.fans_count, u.like_count, u.created_at, u.verified,
              (SELECT COUNT(*) FROM posts WHERE user_id = u.id AND status = 0) as post_count
       FROM users u
       WHERE u.nickname LIKE ? OR u.user_id LIKE ?
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
      [`%${keyword}%`, `%${keyword}%`, limit.toString(), offset.toString()]
    );

    // 检查关注状态（仅在用户已登录时）
    if (currentUserId && rows.length > 0) {
      const userIds = rows.map(u => u.id.toString());

      // 批量获取关注状态
      const followingPlaceholders = userIds.map(() => '?').join(',');
      const { rows: follows } = await dbExec(
        `SELECT following_id FROM follows WHERE follower_id = ? AND following_id IN (${followingPlaceholders})`,
        [currentUserId.toString(), ...userIds]
      );
      const followingSet = new Set(follows.map(f => f.following_id.toString()));

      // 批量获取互相关注状态
      const { rows: mutuals } = await dbExec(
        `SELECT follower_id FROM follows WHERE following_id = ? AND follower_id IN (${followingPlaceholders})`,
        [currentUserId.toString(), ...userIds]
      );
      const mutualSet = new Set(mutuals.map(f => f.follower_id.toString()));

      for (let user of rows) {
        const userIdStr = user.id.toString();
        user.isFollowing = followingSet.has(userIdStr);
        const isFollowedBy = mutualSet.has(userIdStr);
        user.isMutual = user.isFollowing && isFollowedBy;

        // 设置按钮类型
        if (user.id.toString() === currentUserId.toString()) {
          user.buttonType = 'self';
        } else if (user.isMutual) {
          user.buttonType = 'mutual';
        } else if (user.isFollowing) {
          user.buttonType = 'unfollow';
        } else if (isFollowedBy) {
          user.buttonType = 'back';
        } else {
          user.buttonType = 'follow';
        }
      }
    } else {
      // 未登录用户，所有用户都显示为未关注状态
      for (let user of rows) {
        user.isFollowing = false;
        user.isMutual = false;
        user.buttonType = 'follow';
      }
    }

    // 获取总数
    const { rows: countResult } = await dbExec(
      `SELECT COUNT(*) as total FROM users
       WHERE nickname LIKE ? OR user_id LIKE ?`,
      [`%${keyword}%`, `%${keyword}%`]
    );
    const total = countResult[0].total;

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        users: rows,
        keyword,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('搜索用户失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取用户信息
// 获取用户个性标签
router.get('/:id/personality-tags', async (req, res) => {
  try {
    const userIdParam = req.params.id;
    // 始终通过小蓝本号查找用户信息
    const query = 'SELECT gender, zodiac_sign, mbti, education, major, interests FROM users WHERE user_id = ?';
    const params = [userIdParam];

    const { rows } = await dbExec(query, params);

    if (rows.length === 0) {
      console.log('❌ 用户不存在:', userIdParam);
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        code: RESPONSE_CODES.NOT_FOUND,
        message: '用户不存在',
        data: null
      });
    }

    const personalityTags = rows[0];

    // 处理interests字段（如果是JSON字符串则解析）
    if (personalityTags.interests) {
      try {
        personalityTags.interests = typeof personalityTags.interests === 'string'
          ? JSON.parse(personalityTags.interests)
          : personalityTags.interests;
      } catch (e) {
        personalityTags.interests = null;
      }
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: personalityTags
    });
  } catch (error) {
    console.error('获取用户个性标签失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const userIdParam = req.params.id;
    // 只通过小蓝本号(user_id)进行查找
    const { rows } = await dbExec(
      `SELECT u.id, u.user_id, u.nickname, u.avatar, u.bio, u.location, u.email, u.gender, u.zodiac_sign, u.mbti, u.education, u.major, u.interests, u.follow_count, u.fans_count, u.like_count, u.created_at, u.verified, uv.title as verified_title
       FROM users u
       LEFT JOIN user_verification uv ON u.id = uv.user_id AND uv.status = 1
       WHERE u.user_id = ?`,
      [userIdParam]
    );

    if (rows.length === 0) {
      console.log('❌ 用户不存在:', userIdParam);
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        code: RESPONSE_CODES.NOT_FOUND,
        message: '用户不存在',
        data: null
      });
    }

    const user = rows[0];

    // 处理interests字段（如果是JSON字符串则解析）
    if (user.interests) {
      try {
        user.interests = typeof user.interests === 'string'
          ? JSON.parse(user.interests)
          : user.interests;
      } catch (e) {
        user.interests = null;
      }
    }

    // 查询用户的封禁状态
    const { rows: banResult } = await dbExec(
      'SELECT id, reason, end_time, status, created_at FROM user_ban WHERE user_id = ? AND status IN (0, 3) ORDER BY created_at DESC LIMIT 1',
      [user.id.toString()]
    );

    // 添加封禁状态信息
    if (banResult.length > 0) {
      const ban = banResult[0];
      user.ban = {
        end_time: ban.end_time,
        reason: ban.reason,
        created_at: ban.created_at
      };
    } else {
      user.ban = null;
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: user
    });
  } catch (error) {
    console.error('获取用户信息失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取用户列表
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const { rows } = await dbExec(
      `SELECT id, user_id, nickname, avatar, bio, location, follow_count, fans_count, like_count, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit.toString(), offset.toString()]
    );

    const { rows: countResult } = await dbExec('SELECT COUNT(*) as total FROM users');
    const total = countResult[0].total;

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        users: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('获取用户列表失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取用户发布的笔记列表
router.get('/:id/posts', optionalAuth, async (req, res) => {
  try {
    const userIdParam = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const currentUserId = req.user ? req.user.id : null;
    const category = req.query.category;
    const keyword = req.query.keyword;
    const sort = req.query.sort || 'created_at';
    const statusFilter = req.query.status;

    // 根据参数类型查找用户：纯数字=自增ID，否则=显示ID
    let userId
    if (/^\d+$/.test(userIdParam)) {
      userId = parseInt(userIdParam)
    } else {
      const { rows: userRows } = await dbExec('SELECT id FROM users WHERE user_id = ?', [userIdParam]);
      if (userRows.length === 0) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存在' });
      }
      userId = userRows[0].id;
    }

    // 构建查询条件
    let whereConditions = ['p.user_id = ?'];
    let queryParams = [userId.toString()];

    // 根据status参数决定查询哪些状态
    // status=all: 查询已发布(0)、待审核(2)和未过审(3) - 用于笔记管理
    // status=published: 只查询已发布(0) - 用于个人主页
    // 默认: 只查询已发布(0)
    if (statusFilter === 'all') {
      whereConditions.push('p.status IN (0, 2, 3)');
    } else {
      // 默认只查询已发布的笔记
      whereConditions.push('p.status = 0');
    }

    if (category) {
      whereConditions.push('p.category_id = ?');
      queryParams.push(category);
    }

    if (keyword) {
      whereConditions.push('(p.title LIKE ? OR p.content LIKE ?)');
      queryParams.push(`%${keyword}%`, `%${keyword}%`);
    }

    // 构建排序条件
    const allowedSortFields = ['created_at', 'view_count', 'like_count', 'collect_count', 'comment_count'];
    const sortField = allowedSortFields.includes(sort) ? sort : 'created_at';
    const orderBy = `ORDER BY p.${sortField} DESC`;

    // 查询用户发布的笔记
    const query = `
      SELECT p.*, u.nickname, u.avatar as user_avatar, u.user_id as author_account, u.location, c.name as category
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE ${whereConditions.join(' AND ')}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;
    queryParams.push(limit.toString(), offset.toString());

    const { rows } = await dbExec(query, queryParams);
    // 获取每个笔记的图片、标签和用户点赞收藏状态
    if (rows.length > 0) {
      const postIds = rows.map(p => p.id);

      // 批量获取视频信息
      const videoPlaceholders = postIds.map(() => '?').join(',');
      const { rows: videos } = await dbExec(
        `SELECT post_id, video_url, cover_url FROM post_videos WHERE post_id IN (${videoPlaceholders})`,
        postIds
      );
      const videoMap = {};
      videos.forEach(v => { videoMap[v.post_id] = v; });

      // 批量获取图片信息
      const { rows: images } = await dbExec(
        `SELECT post_id, image_url FROM post_images WHERE post_id IN (${videoPlaceholders})`,
        postIds
      );
      const imageMap = {};
      images.forEach(img => {
        if (!imageMap[img.post_id]) imageMap[img.post_id] = [];
        imageMap[img.post_id].push(img.image_url);
      });

      // 批量获取标签信息
      const { rows: tags } = await dbExec(
        `SELECT pt.post_id, t.id, t.name FROM tags t JOIN post_tags pt ON t.id = pt.tag_id WHERE pt.post_id IN (${videoPlaceholders})`,
        postIds
      );
      const tagMap = {};
      tags.forEach(t => {
        if (!tagMap[t.post_id]) tagMap[t.post_id] = [];
        tagMap[t.post_id].push({ id: t.id, name: t.name });
      });

      // 批量获取点赞状态
      let likedPostIds = new Set();
      if (currentUserId) {
        const { rows: likes } = await dbExec(
          `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 1 AND target_id IN (${videoPlaceholders})`,
          [currentUserId.toString(), ...postIds]
        );
        likedPostIds = new Set(likes.map(l => l.target_id.toString()));
      }

      // 批量获取收藏状态
      let collectedPostIds = new Set();
      if (currentUserId) {
        const { rows: collections } = await dbExec(
          `SELECT post_id FROM collections WHERE user_id = ? AND post_id IN (${videoPlaceholders})`,
          [currentUserId.toString(), ...postIds]
        );
        collectedPostIds = new Set(collections.map(c => c.post_id.toString()));
      }

      // 组装
      for (let post of rows) {
        // 添加视频信息
        if (videoMap[post.id]) {
          post.video = videoMap[post.id];
        }
        // 添加图片数组
        post.images = imageMap[post.id] || [];
        // 添加标签数组
        post.tags = tagMap[post.id] || [];
        // 添加点赞状态
        post.isLiked = likedPostIds.has(post.id.toString());
        // 添加收藏状态
        post.isCollected = collectedPostIds.has(post.id.toString());
      }
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        posts: rows,
        pagination: {
          page,
          limit,
          total: rows.length // 需要额外查询总数
        }
      }
    });
  } catch (error) {
    console.error('获取用户笔记列表失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取用户粉丝列表
router.get('/:id/fans', optionalAuth, async (req, res) => {
  try {
    const userIdParam = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const currentUserId = req.user ? req.user.id : null;

    const targetUserId = await resolveUserId(userIdParam).catch(() => null);
    if (targetUserId === null) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存在' });
    }

    // 查询粉丝列表
    const { rows } = await dbExec(
      `SELECT u.id, u.user_id, u.nickname, u.avatar, u.bio, u.follow_count, u.fans_count
       FROM follows f
       JOIN users u ON f.follower_id = u.id
       WHERE f.following_id = ?
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`,
      [targetUserId.toString(), limit.toString(), offset.toString()]
    );

    // 检查关注状态
    if (currentUserId && rows.length > 0) {
      const userIds = rows.map(u => u.id.toString());
      const userPlaceholders = userIds.map(() => '?').join(',');

      const { rows: follows } = await dbExec(
        `SELECT following_id FROM follows WHERE follower_id = ? AND following_id IN (${userPlaceholders})`,
        [currentUserId.toString(), ...userIds]
      );
      const followingSet = new Set(follows.map(f => f.following_id.toString()));

      const { rows: mutuals } = await dbExec(
        `SELECT follower_id FROM follows WHERE following_id = ? AND follower_id IN (${userPlaceholders})`,
        [currentUserId.toString(), ...userIds]
      );
      const mutualSet = new Set(mutuals.map(f => f.follower_id.toString()));

      for (let user of rows) {
        const userIdStr = user.id.toString();
        user.isFollowing = followingSet.has(userIdStr);
        const isFollowedBy = mutualSet.has(userIdStr);
        user.isMutual = user.isFollowing && isFollowedBy;

        if (user.id.toString() === currentUserId.toString()) {
          user.buttonType = 'self';
        } else if (user.isMutual) {
          user.buttonType = 'mutual';
        } else if (user.isFollowing) {
          user.buttonType = 'unfollow';
        } else if (isFollowedBy) {
          user.buttonType = 'back';
        } else {
          user.buttonType = 'follow';
        }
      }
    } else {
      for (let user of rows) {
        user.isFollowing = false;
        user.isMutual = false;
        user.buttonType = 'follow';
      }
    }

    // 获取总数
    const { rows: countResult } = await dbExec(
      'SELECT COUNT(*) as total FROM follows WHERE following_id = ?',
      [targetUserId.toString()]
    );
    const total = countResult[0].total;

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        fans: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('获取粉丝列表失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取用户关注列表
router.get('/:id/following', optionalAuth, async (req, res) => {
  try {
    const userIdParam = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const currentUserId = req.user ? req.user.id : null;

    const targetUserId = await resolveUserId(userIdParam).catch(() => null);
    if (targetUserId === null) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存在' });
    }

    // 查询关注列表
    const { rows } = await dbExec(
      `SELECT u.id, u.user_id, u.nickname, u.avatar, u.bio, u.follow_count, u.fans_count
       FROM follows f
       JOIN users u ON f.following_id = u.id
       WHERE f.follower_id = ?
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`,
      [targetUserId.toString(), limit.toString(), offset.toString()]
    );

    // 检查关注状态
    if (currentUserId && rows.length > 0) {
      const userIds = rows.map(u => u.id.toString());
      const userPlaceholders = userIds.map(() => '?').join(',');

      const { rows: follows } = await dbExec(
        `SELECT following_id FROM follows WHERE follower_id = ? AND following_id IN (${userPlaceholders})`,
        [currentUserId.toString(), ...userIds]
      );
      const followingSet = new Set(follows.map(f => f.following_id.toString()));

      const { rows: mutuals } = await dbExec(
        `SELECT follower_id FROM follows WHERE following_id = ? AND follower_id IN (${userPlaceholders})`,
        [currentUserId.toString(), ...userIds]
      );
      const mutualSet = new Set(mutuals.map(f => f.follower_id.toString()));

      for (let user of rows) {
        const userIdStr = user.id.toString();
        user.isFollowing = followingSet.has(userIdStr);
        const isFollowedBy = mutualSet.has(userIdStr);
        user.isMutual = user.isFollowing && isFollowedBy;

        if (user.id.toString() === currentUserId.toString()) {
          user.buttonType = 'self';
        } else if (user.isMutual) {
          user.buttonType = 'mutual';
        } else if (user.isFollowing) {
          user.buttonType = 'unfollow';
        } else if (isFollowedBy) {
          user.buttonType = 'back';
        } else {
          user.buttonType = 'follow';
        }
      }
    } else {
      for (let user of rows) {
        user.isFollowing = false;
        user.isMutual = false;
        user.buttonType = 'follow';
      }
    }

    // 获取总数
    const { rows: countResult } = await dbExec(
      'SELECT COUNT(*) as total FROM follows WHERE follower_id = ?',
      [targetUserId.toString()]
    );
    const total = countResult[0].total;

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        following: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('获取关注列表失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 关注/取消关注用户
router.post('/:id/follow', authenticateToken, async (req, res) => {
  try {
    const userIdParam = req.params.id;
    const currentUserId = req.user.id;

    const targetUserId = await resolveUserId(userIdParam).catch(() => null);
    if (targetUserId === null) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存在' });
    }

    // 不能关注自己
    if (currentUserId === targetUserId) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '不能关注自己' });
    }

    // 检查是否已关注
    const { rows: existingFollow } = await dbExec(
      'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?',
      [currentUserId.toString(), targetUserId.toString()]
    );

    if (existingFollow.length > 0) {
      // 已关注，则取消关注
      await dbExec(
        'DELETE FROM follows WHERE follower_id = ? AND following_id = ?',
        [currentUserId.toString(), targetUserId.toString()]
      );

      // 更新关注数和粉丝数
      await dbExec(
        'UPDATE users SET follow_count = GREATEST(follow_count - 1, 0) WHERE id = ?',
        [currentUserId.toString()]
      );
      await dbExec(
        'UPDATE users SET fans_count = GREATEST(fans_count - 1, 0) WHERE id = ?',
        [targetUserId.toString()]
      );

      console.log(`用户取消关注 - 粉丝: ${currentUserId}, 关注: ${targetUserId}`);

      res.json({
        code: RESPONSE_CODES.SUCCESS,
        message: '取消关注成功',
        data: { isFollowing: false }
      });
    } else {
      // 未关注，则添加关注
      await dbExec(
        'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, NOW())',
        [currentUserId.toString(), targetUserId.toString()]
      );

      // 更新关注数和粉丝数
      await dbExec(
        'UPDATE users SET follow_count = follow_count + 1 WHERE id = ?',
        [currentUserId.toString()]
      );
      await dbExec(
        'UPDATE users SET fans_count = fans_count + 1 WHERE id = ?',
        [targetUserId.toString()]
      );

      // 发送关注通知
      try {
        const { rows: notifUser } = await dbExec('SELECT nickname FROM users WHERE id = ?', [currentUserId.toString()]);
        await NotificationHelper.sendNotification(targetUserId, {
          type: 2,
          sender_id: currentUserId,
          content: `${notifUser[0].nickname} 关注了你`
        });
      } catch (notifErr) {
        console.error('发送关注通知失败:', notifErr);
      }

      console.log(`用户关注成功 - 粉丝: ${currentUserId}, 关注: ${targetUserId}`);

      res.json({
        code: RESPONSE_CODES.SUCCESS,
        message: '关注成功',
        data: { isFollowing: true }
      });
    }
  } catch (error) {
    console.error('关注/取消关注失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取互关列表
router.get('/:id/mutual-follows', optionalAuth, async (req, res) => {
  try {
    const userIdParam = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const currentUserId = req.user ? req.user.id : null;

    const userId = await resolveUserId(userIdParam).catch(() => null);
    if (userId === null) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存在' });
    }

    // 查询互关列表：同时满足 f1.follower_id = userId AND f1.following_id = u.id 和 f2.follower_id = u.id AND f2.following_id = userId
    const { rows } = await dbExec(
      `SELECT u.id, u.user_id, u.nickname, u.avatar, u.bio, u.follow_count, u.fans_count
       FROM users u
       WHERE u.id IN (
         SELECT f1.following_id
         FROM follows f1
         WHERE f1.follower_id = ?
         AND EXISTS (
           SELECT 1 FROM follows f2
           WHERE f2.follower_id = f1.following_id
           AND f2.following_id = ?
         )
       )
       ORDER BY u.nickname ASC
       LIMIT ? OFFSET ?`,
      [userId.toString(), userId.toString(), limit.toString(), offset.toString()]
    );

    // 检查关注状态
    if (currentUserId && rows.length > 0) {
      const userIds = rows.map(u => u.id.toString());
      const userPlaceholders = userIds.map(() => '?').join(',');

      const { rows: follows } = await dbExec(
        `SELECT following_id FROM follows WHERE follower_id = ? AND following_id IN (${userPlaceholders})`,
        [currentUserId.toString(), ...userIds]
      );
      const followingSet = new Set(follows.map(f => f.following_id.toString()));

      const { rows: mutuals } = await dbExec(
        `SELECT follower_id FROM follows WHERE following_id = ? AND follower_id IN (${userPlaceholders})`,
        [currentUserId.toString(), ...userIds]
      );
      const mutualSet = new Set(mutuals.map(f => f.follower_id.toString()));

      for (let user of rows) {
        const userIdStr = user.id.toString();
        user.isFollowing = followingSet.has(userIdStr);
        const isFollowedBy = mutualSet.has(userIdStr);
        user.isMutual = user.isFollowing && isFollowedBy;

        if (user.id.toString() === currentUserId.toString()) {
          user.buttonType = 'self';
        } else if (user.isMutual) {
          user.buttonType = 'mutual';
        } else if (user.isFollowing) {
          user.buttonType = 'unfollow';
        } else if (isFollowedBy) {
          user.buttonType = 'back';
        } else {
          user.buttonType = 'follow';
        }
      }
    } else {
      for (let user of rows) {
        user.isFollowing = false;
        user.isMutual = false;
        user.buttonType = 'follow';
      }
    }

    // 获取互关总数
    const { rows: countResult } = await dbExec(
      `SELECT COUNT(*) as total FROM users u
       WHERE u.id IN (
         SELECT f1.following_id
         FROM follows f1
         WHERE f1.follower_id = ?
         AND EXISTS (
           SELECT 1 FROM follows f2
           WHERE f2.follower_id = f1.following_id
           AND f2.following_id = ?
         )
       )`,
      [userId, userId]
    );
    const total = countResult[0].total;

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        mutualFollows: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('获取互关列表失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取用户统计信息
router.get('/:id/stats', async (req, res) => {
  try {
    const userIdParam = req.params.id;
    console.log(`获取用户统计信息 - 用户ID: ${userIdParam}`);

    let userId = await resolveUserId(userIdParam).catch(() => {
    return null
  })
  if (userId === null) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存在' })
  }

    // 获取用户基本统计信息
    const { rows: userStats } = await dbExec(
      'SELECT follow_count, fans_count, like_count FROM users WHERE id = ?',
      [userId.toString()]
    );

    if (userStats.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存在' });
    }

    // 获取笔记数量
    const { rows: postCount } = await dbExec(
      'SELECT COUNT(*) as count FROM posts WHERE user_id = ? AND status = 0',
      [userId.toString()]
    );

    // 获取该用户发布的笔记被收藏的总数量
    const { rows: collectCount } = await dbExec(
      'SELECT COUNT(*) as count FROM collections c JOIN posts p ON c.post_id = p.id WHERE p.user_id = ? AND p.status = 0',
      [userId.toString()]
    );

    // 计算获赞与收藏总数
    const likesAndCollects = userStats[0].like_count + collectCount[0].count;

    const stats = {
      follow_count: userStats[0].follow_count,
      fans_count: userStats[0].fans_count,
      post_count: postCount[0].count,
      like_count: userStats[0].like_count,
      collect_count: collectCount[0].count,
      likes_and_collects: likesAndCollects
    };


    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: stats
    });
  } catch (error) {
    console.error('获取用户统计信息失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 更新用户资料（用户自己）
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const userIdParam = req.params.id;
    const currentUserId = req.user.id;
    const { nickname, avatar, bio, location, gender, zodiac_sign, mbti, education, major, interests } = req.body;

    console.log(`用户更新资料 - 目标用户ID: ${userIdParam}, 当前用户ID: ${currentUserId}`);

    let targetUserId = await resolveUserId(userIdParam).catch(() => {
    return null
  })
  if (targetUserId === null) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存在' })
  }

    // 检查是否是用户本人
    if (currentUserId !== targetUserId) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '只能修改自己的资料' });
    }

    // 验证必填字段
    if (!nickname || !nickname.trim()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '昵称不能为空' });
    }

    // 构建更新SQL
    let updateFields = [];
    let updateValues = [];

    updateFields.push('nickname = ?');
    updateValues.push(sanitizeContent(nickname.trim()));

    if (avatar !== undefined) {
      updateFields.push('avatar = ?');
      updateValues.push(avatar || '');
    }

    if (bio !== undefined) {
      updateFields.push('bio = ?');
      updateValues.push(sanitizeContent(bio || ''));
    }

    if (location !== undefined) {
      updateFields.push('location = ?');
      updateValues.push(location || '');
    }

    if (gender !== undefined) {
      updateFields.push('gender = ?');
      updateValues.push(gender || null);
    }

    if (zodiac_sign !== undefined) {
      updateFields.push('zodiac_sign = ?');
      updateValues.push(zodiac_sign || null);
    }

    if (mbti !== undefined) {
      updateFields.push('mbti = ?');
      updateValues.push(mbti || null);
    }

    if (education !== undefined) {
      updateFields.push('education = ?');
      updateValues.push(education || null);
    }

    if (major !== undefined) {
      updateFields.push('major = ?');
      updateValues.push(major || null);
    }

    if (interests !== undefined) {
      // 处理兴趣爱好数组，转换为JSON字符串
      const processedInterests = interests ? (Array.isArray(interests) ? JSON.stringify(interests) : interests) : null;
      updateFields.push('interests = ?');
      updateValues.push(processedInterests);
    }

    updateValues.push(targetUserId);

    // 更新用户资料
    await dbExec(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // 获取更新后的用户信息
    const { rows: updatedUser } = await dbExec(
      'SELECT id, user_id, nickname, avatar, bio, location, email, gender, zodiac_sign, mbti, education, major, interests, follow_count, fans_count, like_count FROM users WHERE id = ?',
      [targetUserId.toString()]
    );

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '资料更新成功',
      success: true,
      data: updatedUser[0]
    });
  } catch (error) {
    console.error('更新用户资料失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 修改密码
router.put('/:id/password', authenticateToken, async (req, res) => {
  try {
    const userIdParam = req.params.id;
    const currentUserId = req.user.id;
    const { currentPassword, newPassword } = req.body;

    console.log(`用户修改密码 - 目标用户ID: ${userIdParam}, 当前用户ID: ${currentUserId}`);

    // 验证必填字段
    if (!currentPassword || !newPassword) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '当前密码和新密码不能为空' });
    }

    if (newPassword.length < 6) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '新密码长度不能少于6位' });
    }

    let targetUserId = await resolveUserId(userIdParam).catch(() => {
    return null
  })
  if (targetUserId === null) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存在' })
  }

    // 检查是否是用户本人
    if (currentUserId !== targetUserId) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '只能修改自己的密码' });
    }

    // 验证当前密码
    const { rows: passwordRows } = await dbExec(
      'SELECT password FROM users WHERE id = ? AND password = encode(digest(?, \'sha256\'), \'hex\')',
      [targetUserId.toString(), currentPassword]
    );

    if (passwordRows.length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '当前密码错误' });
    }

    // 更新密码
    await dbExec(
      'UPDATE users SET password = encode(digest(?, \'sha256\'), \'hex\') WHERE id = ?',
      [newPassword, targetUserId.toString()]
    );

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '密码修改成功',
      success: true
    });
  } catch (error) {
    console.error('修改密码失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 删除账号
router.delete('/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const userIdParam = req.params.id;
    const currentUserId = req.user.id;
    let targetUserId = await resolveUserId(userIdParam).catch(() => {
    return null
  })
  if (targetUserId === null) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存在' })
  }

    // 检查是否是用户本人
    if (currentUserId !== targetUserId) {
      client.release();
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '只能删除自己的账号' });
    }

    // 开始事务
    await client.query('BEGIN');
    await client.query('DELETE FROM comments WHERE user_id = $1', [targetUserId]);
    await client.query('DELETE FROM likes WHERE user_id = $1', [targetUserId]);
    await client.query('DELETE FROM collections WHERE user_id = $1', [targetUserId]);
    await client.query('DELETE FROM follows WHERE follower_id = $1 OR following_id = $1', [targetUserId]);
    await client.query('DELETE FROM notifications WHERE user_id = $1 OR sender_id = $1', [targetUserId]);
    await client.query('DELETE FROM posts WHERE user_id = $1', [targetUserId]);
    await client.query('DELETE FROM users WHERE id = $1', [targetUserId]);
    // 提交事务
    await client.query('COMMIT');

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '账号删除成功',
      success: true
    });
  } catch (error) {
    // 回滚事务
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    console.error('删除账号失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  } finally {
    client.release();
  }
});

// 提交认证申请
router.post('/verification', authenticateToken, async (req, res) => {
  try {
    const { type, real_name, id_card, contact_name, contact_phone, title, description } = req.body;
    const userId = req.user.id;

    // 验证输入
    if (!type || !real_name || !id_card) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        code: RESPONSE_CODES.VALIDATION_ERROR,
        message: '认证类型、真实姓名和身份证号/信用代码是必填项'
      });
    }

    // 验证认证类型
    if (type !== 1 && type !== 2) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        code: RESPONSE_CODES.VALIDATION_ERROR,
        message: '无效的认证类型'
      });
    }

    // 检查是否已有认证记录
    const { rows: existingVerification } = await dbExec(
      'SELECT id, status FROM user_verification WHERE user_id = ?',
      [userId.toString()]
    );

    if (existingVerification.length > 0) {
      const existingStatus = existingVerification[0].status;
      // 如果已有记录且状态为待审核(0)，则不允许重复提交
      if (existingStatus === 0) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          code: RESPONSE_CODES.VALIDATION_ERROR,
          message: '您已有认证申请正在审核中，请耐心等待'
        });
      }
      // 如果已有记录且状态为已通过(1)，则不允许重复提交
      if (existingStatus === 1) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          code: RESPONSE_CODES.VALIDATION_ERROR,
          message: '您已通过认证，无需重复申请'
        });
      }
      // 如果已有记录且状态为已拒绝(2)，则要求先撤回再提交
      if (existingStatus === 2) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          code: RESPONSE_CODES.VALIDATION_ERROR,
          message: '您的认证申请已被拒绝，如需重新申请请先撤回当前认证'
        });
      }
    }

    // 插入认证记录，状态为待审核(0)
    const { rows: insertResult } = await dbExec(
      'INSERT INTO user_verification (user_id, type, status, real_name, id_card, contact_name, contact_phone, title, description, created_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, NOW()) RETURNING id',
      [userId.toString(), type.toString(), real_name, id_card, contact_name || null, contact_phone || null, title || null, description || null]
    );

    // 同时在audit表中添加审核记录
    await dbExec(
      'INSERT INTO audit (type, target_id, status, created_at) VALUES (?, ?, 0, NOW())',
      [type.toString(), userId.toString()]
    );

    res.status(HTTP_STATUS.CREATED).json({
      code: RESPONSE_CODES.SUCCESS,
      message: '认证申请提交成功，请耐心等待审核',
      data: {
        verificationId: insertResult[0].id
      }
    });
  } catch (error) {
    console.error('提交认证申请错误:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      code: RESPONSE_CODES.SERVER_ERROR,
      message: ERROR_MESSAGES.SERVER_ERROR
    });
  }
});

// 获取用户认证状态
router.get('/verification/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 获取用户的认证申请记录，关联audit表获取审核时间和备注
    const { rows: verifications } = await dbExec(
      'SELECT uv.id, uv.type, uv.status, uv.real_name, uv.id_card, uv.contact_name, uv.contact_phone, uv.title, uv.created_at, a.audit_time, a.remark FROM user_verification uv LEFT JOIN audit a ON uv.user_id = a.target_id AND a.type = uv.type WHERE uv.user_id = ? ORDER BY uv.created_at DESC',
      [userId.toString()]
    );

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: verifications
    });
  } catch (error) {
    console.error('获取认证状态错误:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      code: RESPONSE_CODES.SERVER_ERROR,
      message: ERROR_MESSAGES.SERVER_ERROR
    });
  }
});

// 撤回认证申请
router.delete('/verification/revoke', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 查找用户的认证申请（包括待审核、已通过和已拒绝的）
    const { rows: existingVerifications } = await dbExec(
      'SELECT id, status FROM user_verification WHERE user_id = ?',
      [userId.toString()]
    );

    if (existingVerifications.length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        code: RESPONSE_CODES.VALIDATION_ERROR,
        message: '没有找到可撤回的认证申请'
      });
    }

    // 删除认证申请记录
    await dbExec(
      'DELETE FROM user_verification WHERE user_id = ?',
      [userId.toString()]
    );

    // 同时删除audit表中的相关记录
    await dbExec(
      'DELETE FROM audit WHERE target_id = ?',
      [userId.toString()]
    );

    // 将用户的verified字段重置为0
    await dbExec(
      'UPDATE users SET verified = 0 WHERE id = ?',
      [userId.toString()]
    );

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '认证申请已撤回'
    });
  } catch (error) {
    console.error('撤回认证申请错误:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      code: RESPONSE_CODES.SERVER_ERROR,
      message: ERROR_MESSAGES.SERVER_ERROR
    });
  }
});

module.exports = router;
