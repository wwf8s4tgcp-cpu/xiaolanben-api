const express = require('express');
const router = express.Router();
const { HTTP_STATUS, RESPONSE_CODES, ERROR_MESSAGES } = require('../constants');
const { pool } = require('../config/config');
const { optionalAuth, authenticateToken } = require('../middleware/auth');
const { checkContent } = require('../utils/contentFilter');
const NotificationHelper = require('../utils/notificationHelper');
const { extractMentionedUsers, hasMentions } = require('../utils/mentionParser');
const { batchCleanupFiles } = require('../utils/fileCleanup');
const { sanitizeContent } = require('../utils/contentSecurity');

// 获取笔记列表
router.get('/', optionalAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const category = req.query.category;
    const status = req.query.status !== undefined ? parseInt(req.query.status) : 0;
    const userId = req.query.user_id || null;
    const type = req.query.type ? parseInt(req.query.type) : null;
    const currentUserId = req.user ? req.user.id : null;

    if (status === 1) {
      if (!currentUserId) {
        return res.status(HTTP_STATUS.UNAUTHORIZED).json({ code: RESPONSE_CODES.UNAUTHORIZED, message: '查看草稿需要登录' });
      }
      const forcedUserId = currentUserId;

      let pIdx = 0;
      let query = `
        SELECT p.*, u.nickname, u.avatar as user_avatar, u.user_id as author_account, u.id as author_auto_id, u.location, u.verified, c.name as category
        FROM "posts" p
        LEFT JOIN "users" u ON p.user_id = u.id
        LEFT JOIN "categories" c ON p.category_id = c.id
        WHERE p.status = $${++pIdx} AND p.user_id = $${++pIdx}
      `;
      let queryParams = [status.toString(), forcedUserId.toString()];

      if (category) {
        query += ` AND p.category_id = $${++pIdx}`;
        queryParams.push(category);
      }

      if (type) {
        query += ` AND p.type = $${++pIdx}`;
        queryParams.push(type);
      }

      query += ` ORDER BY p.created_at DESC LIMIT $${++pIdx} OFFSET $${++pIdx}`;
      queryParams.push(limit.toString(), offset.toString());

      const { rows } = await pool.query(query, queryParams);

      if (rows.length > 0) {
        const postIds = rows.map(p => p.id);
        
        // 批量获取视频信息
        const vPlaceholders = postIds.map((_, i) => `$${i + 1}`).join(',');
        const { rows: videos } = await pool.query(`SELECT post_id, video_url, cover_url FROM "post_videos" WHERE post_id IN (${vPlaceholders})`, postIds);
        const videoMap = {};
        videos.forEach(v => { videoMap[v.post_id] = v; });

        // 批量获取图片信息
        const { rows: images } = await pool.query(`SELECT post_id, image_url FROM "post_images" WHERE post_id IN (${vPlaceholders})`, postIds);
        const imageMap = {};
        images.forEach(img => {
          if (!imageMap[img.post_id]) imageMap[img.post_id] = [];
          imageMap[img.post_id].push(img.image_url);
        });

        // 批量获取标签信息
        const { rows: tags } = await pool.query(
          `SELECT pt.post_id, t.id, t.name FROM "tags" t JOIN "post_tags" pt ON t.id = pt.tag_id WHERE pt.post_id IN (${vPlaceholders})`,
          postIds
        );
        const tagMap = {};
        tags.forEach(t => {
          if (!tagMap[t.post_id]) tagMap[t.post_id] = [];
          tagMap[t.post_id].push({ id: t.id, name: t.name });
        });

        // 组装数据
        for (let post of rows) {
          if (post.type === 2) {
            const video = videoMap[post.id];
            post.images = video && video.cover_url ? [video.cover_url] : [];
            post.video_url = video ? video.video_url : null;
            post.image = video && video.cover_url ? video.cover_url : null;
          } else {
            const postImages = imageMap[post.id] || [];
            post.images = postImages;
            post.image = postImages.length > 0 ? postImages[0] : null;
          }
          post.tags = tagMap[post.id] || [];
          post.liked = false;
          post.collected = false;
        }
      }

      // 获取草稿总数
      let countIdx = 0;
      let countQuery = 'SELECT COUNT(*) as total FROM "posts" p WHERE p.status = $' + (++countIdx) + ' AND p.user_id = $' + (++countIdx);
      let countParams = [status.toString(), forcedUserId.toString()];

      if (category) {
        countQuery += ' AND p.category_id = $' + (++countIdx);
        countParams.push(category);
      }

      if (type) {
        countQuery += ' AND p.type = $' + (++countIdx);
        countParams.push(type);
      }

      const { rows: countRows } = await pool.query(countQuery, countParams);
      const total = parseInt(countRows[0].total, 10);
      const pages = Math.ceil(total / limit);

      return res.json({
        code: RESPONSE_CODES.SUCCESS,
        message: 'success',
        data: {
          posts: rows,
          pagination: {
            page,
            limit,
            total,
            pages
          }
        }
      });
    }

    let pIdx = 0;
    let query = `
      SELECT p.*, u.nickname, u.avatar as user_avatar, u.user_id as author_account, u.id as author_auto_id, u.location, u.verified, c.name as category
      FROM "posts" p
      LEFT JOIN "users" u ON p.user_id = u.id
      LEFT JOIN "categories" c ON p.category_id = c.id
      WHERE p.status = $${++pIdx}
    `;
    let queryParams = [status.toString()];

    // 特殊处理推荐频道：热度新鲜度评分前20%的笔记按分数排序
    if (category === 'recommend') {
      // 先获取总笔记数计算20%的数量
      let countIdx = 0;
      let countQuery = 'SELECT COUNT(*) as total FROM "posts" WHERE status = $' + (++countIdx);
      let countParams = [status.toString()];

      if (type) {
        countQuery += ' AND type = $' + (++countIdx);
        countParams.push(type);
      }
      const { rows: totalCountRows } = await pool.query(countQuery, countParams);
      const totalPosts = parseInt(totalCountRows[0].total, 10);
      const recommendLimit = Math.ceil(totalPosts * 0.2);
      // 推荐算法：70%热度+30%新鲜度评分，新发布24小时内的笔记获得新鲜度加分，筛选前20%按分数排序
      let innerIdx = 0;
      let innerWhere = 'p.status = $' + (++innerIdx);
      let innerParams = [status.toString()];
      if (type) {
        innerWhere += ' AND p.type = $' + (++innerIdx);
        innerParams.push(type);
      }
      query = `
        SELECT 
          p.*, 
          u.nickname, 
          u.avatar as user_avatar, 
          u.user_id as author_account, 
          u.id as author_auto_id, 
          u.location, 
          u.verified,
          c.name as category
        FROM (
          SELECT 
            p.*,
            (p.view_count * 0.7 + (24 - LEAST(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600, 24)) * 0.3) as score
          FROM "posts" p 
          WHERE ${innerWhere}
          ORDER BY score DESC
          LIMIT $${++innerIdx}
        ) p
        LEFT JOIN "users" u ON p.user_id = u.id 
        LEFT JOIN "categories" c ON p.category_id = c.id 
        ORDER BY p.score DESC
        LIMIT $${++innerIdx} OFFSET $${++innerIdx} 
      `;

      // 参数设置
      queryParams = [
        ...innerParams,
        recommendLimit.toString(),
        limit.toString(),
        offset.toString()
      ];
    } else {
      let whereConditions = [];
      let additionalParams = [];

      if (category) {
        whereConditions.push('p.category_id = $' + (++pIdx));
        additionalParams.push(category);
      }

      if (userId) {
        whereConditions.push('p.user_id = $' + (++pIdx));
        additionalParams.push(userId);
      }

      if (type) {
        whereConditions.push('p.type = $' + (++pIdx));
        additionalParams.push(type);
      }

      if (whereConditions.length > 0) {
        query += ` AND ${whereConditions.join(' AND ')}`;
      }

      query += ` ORDER BY p.created_at DESC LIMIT $${++pIdx} OFFSET $${++pIdx}`;
      queryParams = [status.toString(), ...additionalParams, limit.toString(), offset.toString()];
    }
    const { rows } = await pool.query(query, queryParams);

    // 获取每个笔记的图片、标签和用户点赞收藏状态
    if (rows.length > 0) {
      const postIds = rows.map(p => p.id);
      
      // 批量获取视频信息
      const vPlaceholders = postIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows: videos } = await pool.query(`SELECT post_id, video_url, cover_url FROM "post_videos" WHERE post_id IN (${vPlaceholders})`, postIds);
      const videoMap = {};
      videos.forEach(v => { videoMap[v.post_id] = v; });

      // 批量获取图片信息
      const { rows: images } = await pool.query(`SELECT post_id, image_url FROM "post_images" WHERE post_id IN (${vPlaceholders})`, postIds);
      const imageMap = {};
      images.forEach(img => {
        if (!imageMap[img.post_id]) imageMap[img.post_id] = [];
        imageMap[img.post_id].push(img.image_url);
      });

      // 批量获取标签信息
      const { rows: tags } = await pool.query(
        `SELECT pt.post_id, t.id, t.name FROM "tags" t JOIN "post_tags" pt ON t.id = pt.tag_id WHERE pt.post_id IN (${vPlaceholders})`,
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
        const likePlaceholders = postIds.map((_, i) => `$${i + 2}`).join(',');
        const { rows: likes } = await pool.query(
          `SELECT target_id FROM "likes" WHERE user_id = $1 AND target_type = 1 AND target_id IN (${likePlaceholders})`,
          [currentUserId.toString(), ...postIds]
        );
        likedPostIds = new Set(likes.map(l => l.target_id.toString()));
      }

      // 批量获取收藏状态
      let collectedPostIds = new Set();
      if (currentUserId) {
        const collectPlaceholders = postIds.map((_, i) => `$${i + 2}`).join(',');
        const { rows: collections } = await pool.query(
          `SELECT post_id FROM "collections" WHERE user_id = $1 AND post_id IN (${collectPlaceholders})`,
          [currentUserId.toString(), ...postIds]
        );
        collectedPostIds = new Set(collections.map(c => c.post_id.toString()));
      }

      // 组装数据
      for (let post of rows) {
        if (post.type === 2) {
          const video = videoMap[post.id];
          post.images = video && video.cover_url ? [video.cover_url] : [];
          post.video_url = video ? video.video_url : null;
          post.image = video && video.cover_url ? video.cover_url : null;
        } else {
          const postImages = imageMap[post.id] || [];
          post.images = postImages;
          post.image = postImages.length > 0 ? postImages[0] : null;
        }
        post.tags = tagMap[post.id] || [];
        post.liked = likedPostIds.has(post.id.toString());
        post.collected = collectedPostIds.has(post.id.toString());
      }
    }

    // 获取总数
    let total;
    if (category === 'recommend') {
      // 推荐频道的总数限制为总笔记数的20%
      let countIdx = 0;
      let countQuery = 'SELECT COUNT(*) as total FROM "posts" WHERE status = $' + (++countIdx);
      let countParams = [status.toString()];

      if (type) {
        countQuery += ' AND type = $' + (++countIdx);
        countParams.push(type);
      }

      const { rows: totalCountRows } = await pool.query(countQuery, countParams);
      const totalPosts = parseInt(totalCountRows[0].total, 10);
      total = Math.ceil(totalPosts * 0.2);
    } else {
      let countIdx = 0;
      let countQuery = 'SELECT COUNT(*) as total FROM "posts" WHERE status = $' + (++countIdx);
      let countParams = [status.toString()];
      let countWhereConditions = [];

      if (category) {
        countQuery = 'SELECT COUNT(*) as total FROM "posts" p LEFT JOIN "categories" c ON p.category_id = c.id WHERE p.status = $' + (++countIdx);
        countWhereConditions.push('p.category_id = $' + (++countIdx));
        countParams.push(category);
      }

      if (userId) {
        countWhereConditions.push('user_id = $' + (++countIdx));
        countParams.push(userId);
      }

      if (type) {
        countWhereConditions.push('type = $' + (++countIdx));
        countParams.push(type);
      }

      if (countWhereConditions.length > 0) {
        countQuery += ` AND ${countWhereConditions.join(' AND ')}`;
      }

      const { rows: countRows } = await pool.query(countQuery, countParams);
      total = parseInt(countRows[0].total, 10);
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        posts: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('获取笔记列表失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取笔记详情
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const postId = req.params.id;
    const currentUserId = req.user ? req.user.id : null;

    // 获取笔记基本信息
    const { rows } = await pool.query(
      `SELECT p.*, u.nickname, u.avatar as user_avatar, u.user_id as author_account, u.id as author_auto_id, u.location, u.verified, c.name as category
       FROM "posts" p
       LEFT JOIN "users" u ON p.user_id = u.id
       LEFT JOIN "categories" c ON p.category_id = c.id
       WHERE p.id = $1`,
      [postId]
    );

    if (rows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '笔记不存在' });
    }

    const post = rows[0];

    // 检查笔记状态权限
    // status: 0=已发布, 1=草稿, 2=待审核, 3=未过审
    // 只有已发布的笔记可以公开访问，其他状态的笔记只有作者本人可以查看
    if (post.status !== 0) {
      // 未发布的笔记，检查是否是作者本人
      if (!currentUserId || currentUserId !== post.user_id) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '笔记不存在' });
      }
    }

    // 根据帖子类型获取对应的媒体文件
    if (post.type === 1) {
      // 图文类型：获取图片
      const { rows: images } = await pool.query('SELECT image_url FROM "post_images" WHERE "post_id" = $1', [postId]);
      post.images = images.map(img => img.image_url);
    } else if (post.type === 2) {
      // 视频类型：获取视频
      const { rows: videos } = await pool.query('SELECT video_url, cover_url FROM "post_videos" WHERE "post_id" = $1', [postId]);
      post.videos = videos;
      // 将第一个视频的URL和封面提取到主对象中，方便前端使用
      if (videos.length > 0) {
        post.video_url = videos[0].video_url;
        post.cover_url = videos[0].cover_url;
      }
    }

    // 获取笔记标签
    const { rows: tags } = await pool.query(
      'SELECT t.id, t.name FROM "tags" t JOIN "post_tags" pt ON t.id = pt.tag_id WHERE pt.post_id = $1',
      [postId]
    );
    post.tags = tags;

    // 检查当前用户是否已点赞和收藏（仅在用户已登录时检查）
    if (currentUserId) {
      const { rows: likeResult } = await pool.query(
        'SELECT id FROM "likes" WHERE "user_id" = $1 AND "target_type" = 1 AND "target_id" = $2',
        [currentUserId, postId]
      );
      post.liked = likeResult.length > 0;

      const { rows: collectResult } = await pool.query(
        'SELECT id FROM "collections" WHERE "user_id" = $1 AND "post_id" = $2',
        [currentUserId, postId]
      );
      post.collected = collectResult.length > 0;
    } else {
      post.liked = false;
      post.collected = false;
    }

    // 检查是否跳过浏览量增加
    const skipViewCount = req.query.skipViewCount === 'true';

    if (!skipViewCount) {
      // 增加浏览量
      await pool.query('UPDATE "posts" SET "view_count" = "view_count" + 1 WHERE "id" = $1', [postId]);
      post.view_count = post.view_count + 1;
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: post
    });
  } catch (error) {
    console.error('获取笔记详情失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 创建笔记
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, content, category_id, images, video, tags, status, type } = req.body;
    const userId = req.user.id;
    const postType = type || 1; // 默认为图文类型

    console.log('=== 创建笔记请求 ===');
    console.log('用户ID:', userId);
    console.log('标题:', title);
    console.log('内容长度:', content ? content.length : 0);
    console.log('分类ID:', category_id);
    console.log('发布类型:', postType);
    console.log('笔记状态:', status);
    console.log('图片数量:', images ? images.length : 0);
    console.log('视频数据:', video ? JSON.stringify(video) : 'null');
    console.log('标签:', tags);

    // 验证必填字段：发布时要求标题和内容，草稿时不强制要求
    if (status !== 1 && (!title || !content)) {
      console.log('❌ 验证失败: 标题或内容为空');
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '发布时标题和内容不能为空' });
    }

    // 对内容进行安全过滤，防止XSS攻击
    const sanitizedContent = content ? sanitizeContent(content) : '';

    // 验证发布类型
    if (postType !== 1 && postType !== 2) {
      console.log('❌ 验证失败: 无效的发布类型');
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '无效的发布类型' });
    }

    // 敏感词检测
    const textToCheck = [title, content].filter(Boolean).join(' ')
    const checkResult = checkContent(textToCheck)
    if (!checkResult.passed) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        code: RESPONSE_CODES.VALIDATION_ERROR,
        message: '内容包含违规信息，请修改后重新发布',
        words: checkResult.words
      })
    }

    // 插入笔记
    console.log('📝 开始插入笔记到数据库...');
    const result = await pool.query(
      'INSERT INTO "posts" ("user_id", "title", "content", "category_id", "status", "type") VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [userId, title || '', sanitizedContent, category_id || null, (status !== undefined ? status : 2).toString(), postType]
    );

    const postId = result.rows[0].id;
    console.log('✅ 笔记插入成功，ID:', postId);

    // 处理图片（图文类型）
    if (postType === 1 && images && images.length > 0) {
      const validUrls = []

      // 处理所有有效的URL
      for (const imageUrl of images) {
        if (imageUrl && typeof imageUrl === 'string') {
          validUrls.push(imageUrl)
        }
      }

      // 插入所有有效的图片URL
      for (const imageUrl of validUrls) {
        await pool.query(
          'INSERT INTO "post_images" ("post_id", "image_url") VALUES ($1, $2)',
          [postId.toString(), imageUrl]
        );
      }
    }

    // 处理视频（视频类型）- 修改为单个视频
    if (postType === 2 && video && video.url && typeof video.url === 'string') {
      console.log('🎥 开始处理视频数据...');
      console.log('视频URL:', video.url);
      console.log('封面URL:', video.coverUrl);

      let coverUrl = video.coverUrl || null;
      let duration = null;

      // 如果提供了视频缓冲区，提取封面
      if (video.buffer) {
        try {
          console.log('🖼️ 开始提取视频封面...');
          const thumbnailResult = await extractVideoThumbnail(video.buffer, video.filename || 'video.mp4');
          if (thumbnailResult.success) {
            coverUrl = thumbnailResult.coverUrl;
            console.log('✅ 视频封面提取成功:', coverUrl);
          } else {
            console.log('❌ 视频封面提取失败:', thumbnailResult.error);
          }
        } catch (error) {
          console.error('❌ 处理视频封面失败:', error);
        }
      }

      // 插入视频记录
      console.log('💾 插入视频记录到数据库...');
      await pool.query(
        'INSERT INTO "post_videos" ("post_id", "video_url", "cover_url") VALUES ($1, $2, $3)',
        [postId.toString(), video.url, coverUrl]
      );
      console.log('✅ 视频记录插入成功');
    }

    // 处理标签
    if (tags && tags.length > 0) {
      for (const tagName of tags) {
        // 检查标签是否存在，不存在则创建
        const { rows: tagRows } = await pool.query('SELECT id FROM "tags" WHERE "name" = $1', [tagName]);
        let tagId;

        if (tagRows.length === 0) {
          const tagResult = await pool.query('INSERT INTO "tags" ("name") VALUES ($1) RETURNING id', [tagName]);
          tagId = tagResult.rows[0].id;
        } else {
          tagId = tagRows[0].id;
        }

        // 关联笔记和标签
        await pool.query('INSERT INTO "post_tags" ("post_id", "tag_id") VALUES ($1, $2)', [postId.toString(), tagId.toString()]);

        // 更新标签使用次数
        await pool.query('UPDATE "tags" SET "use_count" = "use_count" + 1 WHERE "id" = $1', [tagId.toString()]);
      }
    }

    // 处理@用户通知（仅在已发布状态时）
    if (status === 0 && content && hasMentions(content)) {
      const mentionedUsers = extractMentionedUsers(content);

      for (const mentionedUser of mentionedUsers) {
        try {
          // 根据小蓝本号查找用户的自增ID
          const { rows: userRows } = await pool.query('SELECT id FROM "users" WHERE "user_id" = $1', [mentionedUser.userId]);

          if (userRows.length > 0) {
            const mentionedUserId = userRows[0].id;

            // 不给自己发通知
            if (mentionedUserId !== userId) {
              // 创建@用户通知
              const mentionNotificationData = NotificationHelper.createNotificationData({
                userId: mentionedUserId,
                senderId: userId,
                type: NotificationHelper.TYPES.MENTION,
                targetId: postId
              });

              await NotificationHelper.insertNotification(pool, mentionNotificationData);
            }
          }
        } catch (error) {
          console.error('处理@用户通知失败 - 用户: %s:', mentionedUser.userId, error);
        }
      }
    }

    console.log(`✅ 创建笔记成功 - 用户ID: ${userId}, 笔记ID: ${postId}, 类型: ${postType}`);

    // 如果笔记状态为待审核(status=2)，在audit表中添加审核记录
    if (status === 2) {
      try {
        await pool.query(
          'INSERT INTO "audit" ("type", "target_id", "status") VALUES ($1, $2, $3)',
          [3, postId, 0]
        );
        console.log(`✅ 审核记录创建成功 - 笔记ID: ${postId}`);
      } catch (error) {
        console.error('❌ 创建审核记录失败:', error);
      }
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '发布成功',
      data: { id: postId }
    });
  } catch (error) {
    console.error('❌ 创建笔记失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 搜索笔记
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

    console.log(`🔍 搜索笔记 - 关键词: ${keyword}, 页码: ${page}, 每页: ${limit}, 当前用户ID: ${currentUserId}`);

    // 搜索笔记：支持标题和内容搜索（只搜索已通过的笔记）
    const { rows } = await pool.query(
      `SELECT p.*, u.nickname, u.avatar as user_avatar, u.user_id as author_account, u.id as author_auto_id, u.location, u.verified
       FROM "posts" p
       LEFT JOIN "users" u ON p.user_id = u.id
       WHERE p.status = 0 AND (p.title LIKE $1 OR p.content LIKE $2)
       ORDER BY p.created_at DESC
       LIMIT $3 OFFSET $4`,
      [`%${keyword}%`, `%${keyword}%`, limit.toString(), offset.toString()]
    );

    // 获取每个笔记的图片、标签和用户点赞收藏状态
    if (rows.length > 0) {
      const postIds = rows.map(p => p.id);

      // 批量获取图片信息
      const vPlaceholders = postIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows: images } = await pool.query(`SELECT post_id, image_url FROM "post_images" WHERE post_id IN (${vPlaceholders})`, postIds);
      const imageMap = {};
      images.forEach(img => {
        if (!imageMap[img.post_id]) imageMap[img.post_id] = [];
        imageMap[img.post_id].push(img.image_url);
      });

      // 批量获取标签信息
      const { rows: tags } = await pool.query(
        `SELECT pt.post_id, t.id, t.name FROM "tags" t JOIN "post_tags" pt ON t.id = pt.tag_id WHERE pt.post_id IN (${vPlaceholders})`,
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
        const likePlaceholders = postIds.map((_, i) => `$${i + 2}`).join(',');
        const { rows: likes } = await pool.query(
          `SELECT target_id FROM "likes" WHERE user_id = $1 AND target_type = 1 AND target_id IN (${likePlaceholders})`,
          [currentUserId.toString(), ...postIds]
        );
        likedPostIds = new Set(likes.map(l => l.target_id.toString()));
      }

      // 批量获取收藏状态
      let collectedPostIds = new Set();
      if (currentUserId) {
        const collectPlaceholders = postIds.map((_, i) => `$${i + 2}`).join(',');
        const { rows: collections } = await pool.query(
          `SELECT post_id FROM "collections" WHERE user_id = $1 AND post_id IN (${collectPlaceholders})`,
          [currentUserId.toString(), ...postIds]
        );
        collectedPostIds = new Set(collections.map(c => c.post_id.toString()));
      }

      // 组装数据
      for (let post of rows) {
        const postImages = imageMap[post.id] || [];
        post.images = postImages;
        post.tags = tagMap[post.id] || [];
        post.liked = likedPostIds.has(post.id.toString());
        post.collected = collectedPostIds.has(post.id.toString());
      }
    }

    // 获取总数（只统计已通过的笔记）
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) as total FROM "posts" 
       WHERE status = 0 AND (title LIKE $1 OR content LIKE $2)`,
      [`%${keyword}%`, `%${keyword}%`]
    );
    const total = parseInt(countRows[0].total, 10);

    console.log(`  搜索笔记结果 - 找到 ${total} 个笔记，当前页 ${rows.length} 个`);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        posts: rows,
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
    console.error('搜索笔记失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取笔记评论列表
router.get('/:id/comments', optionalAuth, async (req, res) => {
  try {
    const postId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const sort = req.query.sort || 'desc'; // 排序方式：desc（降序）或 asc（升序）
    const currentUserId = req.user ? req.user.id : null;

    console.log(`获取笔记评论列表 - 笔记ID: ${postId}, 页码: ${page}, 每页: ${limit}, 排序: ${sort}, 当前用户ID: ${currentUserId}`);

    // 验证笔记是否存在
    const { rows: postRows } = await pool.query('SELECT id FROM "posts" WHERE "id" = $1', [postId.toString()]);
    if (postRows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '笔记不存在' });
    }

    // 获取顶级评论（parent_id为NULL）
    const orderBy = sort === 'asc' ? 'ASC' : 'DESC';
    const { rows } = await pool.query(
      `SELECT c.*, u.nickname, u.avatar as user_avatar, u.id as user_auto_id, u.user_id as user_display_id, u.location as user_location, u.verified
       FROM "comments" c
       LEFT JOIN "users" u ON c.user_id = u.id
       WHERE c.post_id = $1 AND c.parent_id IS NULL
       ORDER BY c.created_at ${orderBy}
       LIMIT $2 OFFSET $3`,
      [postId, limit.toString(), offset.toString()]
    );

    // 为每个评论检查点赞状态
    if (rows.length > 0) {
      const commentIds = rows.map(c => c.id);

      // 批量获取点赞状态
      let likedCommentIds = new Set();
      if (currentUserId) {
        const likePlaceholders = commentIds.map((_, i) => `$${i + 2}`).join(',');
        const { rows: likes } = await pool.query(
          `SELECT target_id FROM "likes" WHERE user_id = $1 AND target_type = 2 AND target_id IN (${likePlaceholders})`,
          [currentUserId.toString(), ...commentIds]
        );
        likedCommentIds = new Set(likes.map(l => l.target_id.toString()));
      }

      // 批量获取子评论数量
      const replyPlaceholders = commentIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows: replyCounts } = await pool.query(
        `SELECT parent_id, COUNT(*) as count FROM "comments" WHERE parent_id IN (${replyPlaceholders}) GROUP BY parent_id`,
        commentIds
      );
      const replyCountMap = {};
      replyCounts.forEach(r => {
        replyCountMap[r.parent_id] = r.count;
      });

      // 组装数据
      for (let comment of rows) {
        comment.liked = likedCommentIds.has(comment.id.toString());
        comment.reply_count = replyCountMap[comment.id] || 0;
      }
    }

    // 获取总数（直接从posts表读取comment_count字段）
    const { rows: countRows } = await pool.query(
      'SELECT comment_count as total FROM "posts" WHERE "id" = $1',
      [postId]
    );
    const total = parseInt(countRows[0].total, 10);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        comments: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('获取笔记评论列表失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 收藏/取消收藏笔记
router.post('/:id/collect', authenticateToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    // 验证笔记是否存在
    const { rows: postRows } = await pool.query('SELECT id FROM "posts" WHERE "id" = $1', [postId]);
    if (postRows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '笔记不存在' });
    }

    // 检查是否已经收藏
    const { rows: existingCollection } = await pool.query(
      'SELECT id FROM "collections" WHERE "user_id" = $1 AND "post_id" = $2',
      [userId.toString(), postId.toString()]
    );

    if (existingCollection.length > 0) {
      // 已收藏，执行取消收藏
      await pool.query(
        'DELETE FROM "collections" WHERE "user_id" = $1 AND "post_id" = $2',
        [userId.toString(), postId.toString()]
      );

      // 更新笔记收藏数
      await pool.query('UPDATE "posts" SET "collect_count" = "collect_count" - 1 WHERE "id" = $1', [postId.toString()]);

      console.log(`取消收藏成功 - 用户ID: ${userId}, 笔记ID: ${postId}`);
      res.json({ code: RESPONSE_CODES.SUCCESS, message: '取消收藏成功', data: { collected: false } });
    } else {
      // 未收藏，执行收藏
      await pool.query(
        'INSERT INTO "collections" ("user_id", "post_id") VALUES ($1, $2)',
        [userId.toString(), postId.toString()]
      );

      // 更新笔记收藏数
      await pool.query('UPDATE "posts" SET "collect_count" = "collect_count" + 1 WHERE "id" = $1', [postId.toString()]);

      // 获取笔记作者ID，用于创建通知
      const { rows: postResult } = await pool.query('SELECT user_id FROM "posts" WHERE "id" = $1', [postId.toString()]);
      if (postResult.length > 0) {
        const targetUserId = postResult[0].user_id;

        // 创建通知（不给自己发通知）
        if (targetUserId && targetUserId !== userId) {
          const notificationData = NotificationHelper.createCollectPostNotification(targetUserId, userId, postId);
          await NotificationHelper.insertNotification(pool, notificationData);
        }
      }

      console.log(`收藏成功 - 用户ID: ${userId}, 笔记ID: ${postId}`);
      res.json({ code: RESPONSE_CODES.SUCCESS, message: '收藏成功', data: { collected: true } });
    }
  } catch (error) {
    console.error('笔记收藏操作失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 更新笔记
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const { title, content, category_id, images, video, tags, status } = req.body;
    const userId = req.user.id;

    // 验证必填字段：如果不是草稿（status=2），则要求标题、内容和分类不能为空
    if (status !== 1 && (!title || !content || !category_id)) {
      console.log('验证失败 - 必填字段缺失:', { title, content, category_id, status });
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '发布时标题、内容和分类不能为空' });
    }
    const sanitizedContent = content ? sanitizeContent(content) : '';

    // 检查笔记是否存在且属于当前用户
    const { rows: postRows } = await pool.query(
      'SELECT user_id, type FROM "posts" WHERE "id" = $1',
      [postId.toString()]
    );

    if (postRows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '笔记不存在' });
    }

    if (postRows[0].user_id !== userId) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '无权限修改此笔记' });
    }

    const postType = postRows[0].type;

    // 在更新之前获取原始笔记信息（用于对比@用户变化）
    const { rows: originalPostRows } = await pool.query('SELECT status, content FROM "posts" WHERE "id" = $1', [postId.toString()]);
    const wasOriginallyDraft = originalPostRows.length > 0 && originalPostRows[0].status === 1;
    const originalContent = originalPostRows.length > 0 ? originalPostRows[0].content : '';

    // 更新笔记基本信息
    await pool.query(
      'UPDATE "posts" SET "title" = $1, "content" = $2, "category_id" = $3, "status" = $4 WHERE "id" = $5',
      [title || '', sanitizedContent, category_id || null, (status !== undefined ? status : 2).toString(), postId.toString()]
    );

    // 根据笔记类型处理媒体文件
    if (postType === 2) {
      // 视频笔记：检查是否有视频相关更新
      const hasVideoUpdate = video !== undefined || video_url !== undefined || cover_url !== undefined;

      if (hasVideoUpdate) {
        // 获取原有视频记录
        const { rows: oldVideoRows } = await pool.query('SELECT video_url, cover_url FROM "post_videos" WHERE "post_id" = $1', [postId.toString()]);
        const oldVideoData = oldVideoRows.length > 0 ? oldVideoRows[0] : null;

        let newVideoUrl = null;
        let newCoverUrl = null;
        let shouldCleanupVideo = false;

        if (video && video.url) {
          // 有完整的video对象，说明是新上传的视频
          newVideoUrl = video.url;
          newCoverUrl = video.coverUrl || null;
          shouldCleanupVideo = oldVideoData && oldVideoData.video_url !== newVideoUrl;
        } else if (video_url !== undefined) {
          // 有分离的video_url字段
          newVideoUrl = video_url;
          newCoverUrl = cover_url !== undefined ? cover_url : (oldVideoData ? oldVideoData.cover_url : null);
          shouldCleanupVideo = oldVideoData && oldVideoData.video_url !== newVideoUrl;
        } else if (cover_url !== undefined && oldVideoData) {
          // 仅更新封面，保持原视频URL不变
          newVideoUrl = oldVideoData.video_url;
          newCoverUrl = cover_url;
          shouldCleanupVideo = false; // 仅更新封面，不清理视频文件
        }

        // 更新数据库记录
        if (newVideoUrl) {
          // 删除原有记录
          await pool.query('DELETE FROM "post_videos" WHERE "post_id" = $1', [postId.toString()]);

          // 插入新记录
          await pool.query(
            'INSERT INTO "post_videos" ("post_id", "video_url", "cover_url") VALUES ($1, $2, $3)',
            [postId.toString(), newVideoUrl, newCoverUrl]
          );

          // 只有在视频URL发生变化时才清理旧视频文件
          if (shouldCleanupVideo && oldVideoData) {
            const oldVideoUrls = [oldVideoData.video_url].filter(url => url);
            const oldCoverUrls = [oldVideoData.cover_url].filter(url => url && url !== newCoverUrl);

            if (oldVideoUrls.length > 0 || oldCoverUrls.length > 0) {
              // 异步清理文件，不阻塞响应
              batchCleanupFiles(oldVideoUrls, oldCoverUrls).catch(error => {
                console.error('清理废弃视频文件失败:', error);
              });
            }
          }
        }
      }
    } else {
      // 图文笔记：删除原有图片并插入新的
      await pool.query('DELETE FROM "post_images" WHERE "post_id" = $1', [postId.toString()]);

      if (images && images.length > 0) {
        const validUrls = []

        // 处理所有有效的URL
        for (const imageUrl of images) {
          if (imageUrl && typeof imageUrl === 'string') {
            validUrls.push(imageUrl)
          }
        }

        // 插入所有有效的图片URL
        for (const imageUrl of validUrls) {
          await pool.query(
            'INSERT INTO "post_images" ("post_id", "image_url") VALUES ($1, $2)',
            [postId, imageUrl]
          );
        }
      }
    }

    // 获取原有标签列表（在删除前）
    const { rows: oldTagsResult } = await pool.query(
      'SELECT t.id, t.name FROM "tags" t JOIN "post_tags" pt ON t.id = pt.tag_id WHERE pt.post_id = $1',
      [postId.toString()]
    );
    const oldTags = oldTagsResult.map(tag => tag.name);
    const oldTagIds = new Map(oldTagsResult.map(tag => [tag.name, tag.id]));

    // 新标签列表
    const newTags = tags || [];

    // 找出需要删除的标签（在旧标签中但不在新标签中）
    const tagsToRemove = oldTags.filter(tagName => !newTags.includes(tagName));

    // 找出需要新增的标签（在新标签中但不在旧标签中）
    const tagsToAdd = newTags.filter(tagName => !oldTags.includes(tagName));

    // 删除原有标签关联
    await pool.query('DELETE FROM "post_tags" WHERE "post_id" = $1', [postId.toString()]);

    // 减少已删除标签的使用次数
    for (const tagName of tagsToRemove) {
      const tagId = oldTagIds.get(tagName);
      if (tagId) {
        await pool.query('UPDATE "tags" SET "use_count" = GREATEST("use_count" - 1, 0) WHERE "id" = $1', [tagId]);
      }
    }

    // 处理新标签
    if (newTags.length > 0) {
      for (const tagName of newTags) {
        // 检查标签是否存在，不存在则创建
        const { rows: tagRows } = await pool.query('SELECT id FROM "tags" WHERE "name" = $1', [tagName]);
        let tagId;

        if (tagRows.length === 0) {
          const tagResult = await pool.query('INSERT INTO "tags" ("name") VALUES ($1) RETURNING id', [tagName]);
          tagId = tagResult.rows[0].id;
        } else {
          tagId = tagRows[0].id;
        }

        // 关联笔记和标签
        await pool.query('INSERT INTO "post_tags" ("post_id", "tag_id") VALUES ($1, $2)', [postId, tagId]);

        // 只对新增的标签增加使用次数（不在旧标签列表中的）
        if (tagsToAdd.includes(tagName)) {
          await pool.query('UPDATE "tags" SET "use_count" = "use_count" + 1 WHERE "id" = $1', [tagId]);
        }
      }
    }

    // 处理@用户通知的逻辑
    if (status === 0 && content) { // 只有在已发布状态下才处理@通知
      // 获取新内容中的@用户
      const newMentionedUsers = hasMentions(content) ? extractMentionedUsers(content) : [];
      const newMentionedUserIds = new Set(newMentionedUsers.map(user => user.userId));

      // 获取原内容中的@用户（如果不是从草稿变为发布）
      let oldMentionedUserIds = new Set();
      if (!wasOriginallyDraft && originalContent && hasMentions(originalContent)) {
        const oldMentionedUsers = extractMentionedUsers(originalContent);
        oldMentionedUserIds = new Set(oldMentionedUsers.map(user => user.userId));
      }

      // 找出需要删除通知的用户（在旧列表中但不在新列表中）
      const usersToRemoveNotification = [...oldMentionedUserIds].filter(userId => !newMentionedUserIds.has(userId));

      // 找出需要添加通知的用户（在新列表中但不在旧列表中）
      const usersToAddNotification = [...newMentionedUserIds].filter(userId => !oldMentionedUserIds.has(userId));

      // 删除不再需要的@通知
      for (const mentionedUserId of usersToRemoveNotification) {
        try {
          // 根据小蓝本号查找用户的自增ID
          const { rows: userRows } = await pool.query('SELECT id FROM "users" WHERE "user_id" = $1', [mentionedUserId]);

          if (userRows.length > 0) {
            const mentionedUserAutoId = userRows[0].id;

            // 删除该用户的@通知
            await NotificationHelper.deleteNotifications(pool, {
              type: NotificationHelper.TYPES.MENTION,
              targetId: postId,
              senderId: userId,
              userId: mentionedUserAutoId
            });
          }
        } catch (error) {
          console.error('删除@用户通知失败 - 用户: %s:', mentionedUserId, error);
        }
      }

      // 添加新的@通知
      for (const mentionedUserId of usersToAddNotification) {
        try {
          // 根据小蓝本号查找用户的自增ID
          const { rows: userRows } = await pool.query('SELECT id FROM "users" WHERE "user_id" = $1', [mentionedUserId]);

          if (userRows.length > 0) {
            const mentionedUserAutoId = userRows[0].id;

            // 不给自己发通知
            if (mentionedUserAutoId !== userId) {
              // 创建@用户通知
              const mentionNotificationData = NotificationHelper.createNotificationData({
                userId: mentionedUserAutoId,
                senderId: userId,
                type: NotificationHelper.TYPES.MENTION,
                targetId: postId
              });

              await NotificationHelper.insertNotification(pool, mentionNotificationData);

              console.log('添加@通知 - 笔记ID: %s, 用户: %s', postId, mentionedUserId);
            }
          }
        } catch (error) {
          console.error('处理@用户通知失败 - 用户: %s:', mentionedUserId, error);
        }
      }
    }

    console.log(`更新笔记成功 - 用户ID: ${userId}, 笔记ID: ${postId}`);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '更新成功',
      data: { id: postId }
    });
  } catch (error) {
    console.error('更新笔记失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 删除笔记
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    // 检查笔记是否存在且属于当前用户
    const { rows: postRows } = await pool.query(
      'SELECT user_id FROM "posts" WHERE "id" = $1',
      [postId.toString()]
    );

    if (postRows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '笔记不存在' });
    }

    if (postRows[0].user_id !== userId) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '无权限删除此笔记' });
    }

    // 获取笔记关联的标签，减少标签使用次数
    const { rows: tagResult } = await pool.query(
      'SELECT tag_id FROM "post_tags" WHERE "post_id" = $1',
      [postId.toString()]
    );

    // 减少标签使用次数
    for (const tag of tagResult) {
      await pool.query('UPDATE "tags" SET "use_count" = GREATEST("use_count" - 1, 0) WHERE "id" = $1', [tag.tag_id.toString()]);
    }

    // 获取笔记关联的视频文件，用于清理
    const { rows: videoRows } = await pool.query('SELECT video_url, cover_url FROM "post_videos" WHERE "post_id" = $1', [postId.toString()]);

    // 删除相关数据（由于外键约束，需要按顺序删除）
    await pool.query('DELETE FROM "post_images" WHERE "post_id" = $1', [postId.toString()]);
    await pool.query('DELETE FROM "post_videos" WHERE "post_id" = $1', [postId.toString()]);
    await pool.query('DELETE FROM "post_tags" WHERE "post_id" = $1', [postId.toString()]);
    await pool.query('DELETE FROM "likes" WHERE "target_type" = 1 AND "target_id" = $1', [postId.toString()]);
    await pool.query('DELETE FROM "collections" WHERE "post_id" = $1', [postId.toString()]);
    await pool.query('DELETE FROM "comments" WHERE "post_id" = $1', [postId.toString()]);
    await pool.query('DELETE FROM "notifications" WHERE "target_id" = $1', [postId.toString()]);

    // 清理关联的视频文件
    if (videoRows.length > 0) {
      const videoUrls = videoRows.map(row => row.video_url).filter(url => url);
      const coverUrls = videoRows.map(row => row.cover_url).filter(url => url);

      // 异步清理文件，不阻塞响应
      batchCleanupFiles(videoUrls, coverUrls).catch(error => {
        console.error('清理笔记关联视频文件失败:', error);
      });
    }

    // 最后删除笔记
    await pool.query('DELETE FROM "posts" WHERE "id" = $1', [postId.toString()]);

    console.log(`删除笔记成功 - 用户ID: ${userId}, 笔记ID: ${postId}`);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '删除成功'
    });
  } catch (error) {
    console.error('删除笔记失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 取消收藏笔记
router.delete('/:id/collect', authenticateToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    console.log(`取消收藏 - 用户ID: ${userId}, 笔记ID: ${postId}`);

    // 删除收藏记录
    const result = await pool.query(
      'DELETE FROM "collections" WHERE "user_id" = $1 AND "post_id" = $2',
      [userId.toString(), postId.toString()]
    );

    if (result.rowCount === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '收藏记录不存在' });
    }

    // 更新笔记收藏数
    await pool.query('UPDATE "posts" SET "collect_count" = "collect_count" - 1 WHERE "id" = $1', [postId.toString()]);

    console.log(`取消收藏成功 - 用户ID: ${userId}, 笔记ID: ${postId}`);
    res.json({ code: RESPONSE_CODES.SUCCESS, message: '取消收藏成功', data: { collected: false } });
  } catch (error) {
    console.error('取消笔记收藏失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

module.exports = router;