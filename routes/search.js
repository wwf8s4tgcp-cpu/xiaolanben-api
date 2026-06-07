const express = require('express');
const router = express.Router();
const { HTTP_STATUS, RESPONSE_CODES, ERROR_MESSAGES } = require('../constants');
const { pool } = require('../config/config');
const { optionalAuth } = require('../middleware/auth');

// 搜索（通用搜索接口）
router.get('/', optionalAuth, async (req, res) => {
  try {
    const keyword = req.query.keyword || '';
    const tag = req.query.tag || '';
    const type = req.query.type || 'all'; // all, posts, videos, users
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const currentUserId = req.user ? req.user.id : null;

    // 如果既没有关键词也没有标签，返回空结果
    if (!keyword.trim() && !tag.trim()) {
      return res.json({
        code: RESPONSE_CODES.SUCCESS,
        message: 'success',
        data: {
          keyword,
          tag,
          type,
          data: [],
          tagStats: [],
          pagination: {
            page,
            limit,
            total: 0,
            pages: 0
          }
        }
      });
    }

    let result = {};

    // all、posts、videos都返回笔记内容，但根据type过滤不同类型
    if (type === 'all' || type === 'posts' || type === 'videos') {
      // 构建搜索条件（使用动态参数编号）
      let paramIndex = 0;
      const $p = () => `$${++paramIndex}`;
      let whereConditions = [];
      let queryParams = [];

      // 关键词搜索条件 - 匹配小蓝本号、昵称、标题、正文内容、标签名称中的任意一种
      if (keyword.trim()) {
        whereConditions.push(`(p.title ILIKE ${$p()} OR p.content ILIKE ${$p()} OR u.nickname ILIKE ${$p()} OR u.user_id ILIKE ${$p()} OR EXISTS (SELECT 1 FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id = p.id AND t.name ILIKE ${$p()}))`);
        queryParams.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
      }

      // 标签搜索条件
      if (tag.trim()) {
        whereConditions.push(`EXISTS (SELECT 1 FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id = p.id AND t.name = ${$p()})`);
        queryParams.push(tag);
      }

      // 添加status条件，确保只搜索已发布的笔记
      whereConditions.push('p.status = 0');

      // 根据type添加内容类型过滤
      if (type === 'posts') {
        whereConditions.push('p.type = 1');
      } else if (type === 'videos') {
        whereConditions.push('p.type = 2');
      }

      // 构建WHERE子句
      let whereClause = '';
      if (whereConditions.length > 0) {
        whereClause = `WHERE ${whereConditions.join(' AND ')}`;
      }

      // 搜索笔记
      const { rows: postRows } = await pool.query(
        `SELECT p.*, u.nickname, u.avatar as user_avatar, u.user_id as author_account, u.location
         FROM posts p
         LEFT JOIN users u ON p.user_id = u.id
         ${whereClause}
         ORDER BY p.created_at DESC
         LIMIT ${$p()} OFFSET ${$p()}`,
        [...queryParams, limit, offset]
      );

      // 获取每个笔记的图片、标签和用户点赞收藏状态
      if (postRows.length > 0) {
        const postIds = postRows.map(p => Number(p.id));

        // 修复头像字段映射问题
        for (let post of postRows) {
          post.avatar = post.user_avatar;
          post.author = post.nickname;
        }

        // 批量获取视频信息
        const { rows: videos } = await pool.query(
          'SELECT post_id, video_url, cover_url FROM post_videos WHERE post_id = ANY($1)',
          [postIds]
        );
        const videoMap = {};
        videos.forEach(v => { videoMap[v.post_id] = v; });

        // 批量获取图片信息
        const { rows: images } = await pool.query(
          'SELECT post_id, image_url FROM post_images WHERE post_id = ANY($1)',
          [postIds]
        );
        const imageMap = {};
        images.forEach(img => {
          if (!imageMap[img.post_id]) imageMap[img.post_id] = [];
          imageMap[img.post_id].push(img.image_url);
        });

        // 批量获取标签信息
        const { rows: tags } = await pool.query(
          'SELECT pt.post_id, t.id, t.name FROM tags t JOIN post_tags pt ON t.id = pt.tag_id WHERE pt.post_id = ANY($1)',
          [postIds]
        );
        const tagMap = {};
        tags.forEach(t => {
          if (!tagMap[t.post_id]) tagMap[t.post_id] = [];
          tagMap[t.post_id].push({ id: t.id, name: t.name });
        });

        // 批量获取点赞状态
        let likedPostIds = new Set();
        if (currentUserId) {
          const { rows: likes } = await pool.query(
            'SELECT target_id FROM likes WHERE user_id = $1 AND target_type = 1 AND target_id = ANY($2)',
            [currentUserId, postIds]
          );
          likedPostIds = new Set(likes.map(l => String(l.target_id)));
        }

        // 批量获取收藏状态
        let collectedPostIds = new Set();
        if (currentUserId) {
          const { rows: collections } = await pool.query(
            'SELECT post_id FROM collections WHERE user_id = $1 AND post_id = ANY($2)',
            [currentUserId, postIds]
          );
          collectedPostIds = new Set(collections.map(c => String(c.post_id)));
        }

        // 组装数据
        for (let post of postRows) {
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
          post.liked = likedPostIds.has(String(post.id));
          post.collected = collectedPostIds.has(String(post.id));
        }
      }

      // 获取笔记总数 - 使用相同的搜索条件（whereClause + queryParams），不含 LIMIT/OFFSET
      const { rows: postCountResult } = await pool.query(
        `SELECT COUNT(*) as total FROM posts p
         LEFT JOIN users u ON p.user_id = u.id
         ${whereClause}`,
        queryParams
      );

      // 统计标签频率 - 始终基于keyword搜索结果，不受当前tag筛选影响
      let tagStats = [];
      if (keyword.trim()) {
        // 构建仅基于keyword的参数编号
        let kwParamIndex = 0;
        const $kw = () => `$${++kwParamIndex}`;
        const keywordWhereClause = `WHERE p.status = 0 AND (p.title ILIKE ${$kw()} OR p.content ILIKE ${$kw()} OR u.nickname ILIKE ${$kw()} OR u.user_id ILIKE ${$kw()} OR EXISTS (SELECT 1 FROM post_tags pt2 JOIN tags t2 ON pt2.tag_id = t2.id WHERE pt2.post_id = p.id AND t2.name ILIKE ${$kw()}))`;
        const keywordParams = [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`];

        // 获取keyword搜索结果中的标签统计
        const { rows: tagStatsResult } = await pool.query(
          `SELECT t.name, COUNT(*) as count
           FROM tags t
           JOIN post_tags pt ON t.id = pt.tag_id
           JOIN posts p ON pt.post_id = p.id
           LEFT JOIN users u ON p.user_id = u.id
           ${keywordWhereClause}
           GROUP BY t.id, t.name
           ORDER BY count DESC
           LIMIT 10`,
          keywordParams
        );

        tagStats = tagStatsResult.map(item => ({
          id: item.name,
          label: item.name,
          count: item.count
        }));

        // 如果指定了tag，且tag不在前10中，则需要将其补充进去
        if (tag && !tagStats.some(t => t.id === tag)) {
          const { rows: tagCount } = await pool.query(
            `SELECT COUNT(*) as count
             FROM post_tags pt
             JOIN tags t ON pt.tag_id = t.id
             JOIN posts p ON pt.post_id = p.id
             LEFT JOIN users u ON p.user_id = u.id
             ${keywordWhereClause} AND t.name = $${++kwParamIndex}`,
            [...keywordParams, tag]
          );

          if (tagCount[0].count > 0) {
            tagStats.push({
              id: tag,
              label: tag,
              count: tagCount[0].count
            });
            // 重新排序并保持10个限制
            tagStats.sort((a, b) => b.count - a.count);
            if (tagStats.length > 10) {
              // 如果选中的标签在排序后还是最后一位且超过了10个，则保留它，去掉倒数第二个
              const tagIndex = tagStats.findIndex(t => t.id === tag);
              if (tagIndex >= 10) {
                 tagStats.splice(9, 1); // 去掉第10个
              } else {
                 tagStats.pop();
              }
            }
          }
        }
      }

      // all模式直接返回数据，posts模式和videos模式返回posts结构
      if (type === 'all') {
        result = {
          data: postRows,
          tagStats: tagStats,
          pagination: {
            page,
            limit,
            total: Number(postCountResult[0].total),
            pages: Math.ceil(Number(postCountResult[0].total) / limit)
          }
        };
      } else if (type === 'posts' || type === 'videos') {
        result.posts = {
          data: postRows,
          tagStats: tagStats,
          pagination: {
            page,
            limit,
            total: Number(postCountResult[0].total),
            pages: Math.ceil(Number(postCountResult[0].total) / limit)
          }
        };
      }
    }

    // 只有当type为'users'时才搜索用户
    if (type === 'users') {
      let userParamIndex = 0;
      const $u = () => `$${++userParamIndex}`;

      // 搜索用户
      const { rows: userRows } = await pool.query(
        `SELECT u.id, u.user_id, u.nickname, u.avatar, u.bio, u.location, u.follow_count, u.fans_count, u.like_count, u.created_at, u.verified,
                (SELECT COUNT(*) FROM posts WHERE user_id = u.id AND status = 0) as post_count
         FROM users u
         WHERE u.nickname ILIKE ${$u()} OR u.user_id ILIKE ${$u()}
         ORDER BY u.created_at DESC
         LIMIT ${$u()} OFFSET ${$u()}`,
        [`%${keyword}%`, `%${keyword}%`, limit, offset]
      );

      // 检查关注状态（仅在用户已登录时）
      if (currentUserId && userRows.length > 0) {
        const userIds = userRows.map(u => Number(u.id));

        // 批量获取关注状态
        const { rows: follows } = await pool.query(
          'SELECT following_id FROM follows WHERE follower_id = $1 AND following_id = ANY($2)',
          [currentUserId, userIds]
        );
        const followingSet = new Set(follows.map(f => String(f.following_id)));

        // 批量获取互相关注状态
        const { rows: mutuals } = await pool.query(
          'SELECT follower_id FROM follows WHERE following_id = $1 AND follower_id = ANY($2)',
          [currentUserId, userIds]
        );
        const mutualSet = new Set(mutuals.map(f => String(f.follower_id)));

        for (let user of userRows) {
          const userIdStr = String(user.id);
          user.isFollowing = followingSet.has(userIdStr);
          const isFollowedBy = mutualSet.has(userIdStr);
          user.isMutual = user.isFollowing && isFollowedBy;

          // 设置按钮类型
          if (String(user.id) === String(currentUserId)) {
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
        for (let user of userRows) {
          user.isFollowing = false;
          user.isMutual = false;
          user.buttonType = 'follow';
        }
      }

      // 获取用户总数
      let userCountParamIndex = 0;
      const $uc = () => `$${++userCountParamIndex}`;

      const { rows: userCountResult } = await pool.query(
        `SELECT COUNT(*) as total FROM users
         WHERE nickname ILIKE ${$uc()} OR user_id ILIKE ${$uc()}`,
        [`%${keyword}%`, `%${keyword}%`]
      );

      result.users = {
        data: userRows,
        pagination: {
          page,
          limit,
          total: Number(userCountResult[0].total),
          pages: Math.ceil(Number(userCountResult[0].total) / limit)
        }
      };
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        keyword,
        tag,
        type: type,
        ...result
      }
    });
  } catch (error) {
    console.error('搜索失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

module.exports = router;
