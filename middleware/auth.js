const { verifyToken, extractTokenFromHeader } = require('../utils/jwt');
const { pool } = require('../config/config');
const { HTTP_STATUS, RESPONSE_CODES } = require('../constants');

/**
 * 认证中间�?- 验证JWT token
 */
async function authenticateToken(req, res, next) {
  try {
    const token = extractTokenFromHeader(req);

    if (!token) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        code: RESPONSE_CODES.UNAUTHORIZED,
        message: '访问令牌缺失'
      });
    }

    // 验证token
    const decoded = verifyToken(token);

    // 检查是否为管理员token
    if (decoded.type === 'admin') {
      // 管理员token验证
      const { rows: adminRows } = await pool.query(
        'SELECT id, username FROM admin WHERE id = $1',
        [decoded.adminId]
      );

      if (adminRows.length === 0) {
        return res.status(HTTP_STATUS.UNAUTHORIZED).json({
          code: RESPONSE_CODES.UNAUTHORIZED,
          message: '管理员不存在'
        });
      }

      // 检查管理员会话是否有效
      const { rows: sessionRows } = await pool.query(
        'SELECT id FROM admin_sessions WHERE admin_id = $1 AND token = $2 AND is_active = true AND expires_at > NOW()',
        [decoded.adminId, token]
      );

      if (sessionRows.length === 0) {
        return res.status(HTTP_STATUS.UNAUTHORIZED).json({
          code: RESPONSE_CODES.UNAUTHORIZED,
          message: '会话已过期，请重新登�?
        });
      }

      // 将管理员信息添加到请求对�?      req.user = {
        ...adminRows[0],
        type: 'admin',
        adminId: decoded.adminId
      };
      req.token = token;

      return next();
    } else {
      // 普通用户token验证
      if (!decoded.userId) {
        return res.status(HTTP_STATUS.UNAUTHORIZED).json({
          code: RESPONSE_CODES.UNAUTHORIZED,
          message: '无效的访问令�?
        });
      }

      // 检查用户是否存在且活跃
      const { rows: userRows } = await pool.query(
        'SELECT id, user_id, nickname, avatar, is_active FROM users WHERE id = $1 AND is_active = true',
        [decoded.userId]
      );

      if (userRows.length === 0) {
        return res.status(HTTP_STATUS.UNAUTHORIZED).json({
          code: RESPONSE_CODES.UNAUTHORIZED,
          message: '用户不存在或已被禁用'
        });
      }

      // 检查会话是否有�?      const { rows: sessionRows } = await pool.query(
        'SELECT id FROM user_sessions WHERE user_id = $1 AND token = $2 AND is_active = true AND expires_at > NOW()',
        [decoded.userId, token]
      );

      if (sessionRows.length === 0) {
        return res.status(HTTP_STATUS.UNAUTHORIZED).json({
          code: RESPONSE_CODES.UNAUTHORIZED,
          message: '会话已过期，请重新登�?
        });
      }

      // 将用户信息添加到请求对象
      req.user = userRows[0];
      req.token = token;

      return next();
    }
  } catch (error) {
    console.error('Token验证失败:', error);
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      code: RESPONSE_CODES.UNAUTHORIZED,
      message: '无效的访问令�?
    });
  }
}

/**
 * 可选认证中间件 - 如果有token则验证，没有则跳�? */
async function optionalAuth(req, res, next) {
  try {
    const token = extractTokenFromHeader(req);

    if (!token) {
      req.user = null;
      return next();
    }

    // 验证token
    const decoded = verifyToken(token);

    // 检查用户是否存在且活跃
    const { rows: userRows } = await pool.query(
      'SELECT id, user_id, nickname, avatar, is_active FROM users WHERE id = $1 AND is_active = true',
      [decoded.userId]
    );

    if (userRows.length > 0) {
      // 检查会话是否有�?      const { rows: sessionRows } = await pool.query(
        'SELECT id FROM user_sessions WHERE user_id = $1 AND token = $2 AND is_active = true AND expires_at > NOW()',
        [decoded.userId, token]
      );

      if (sessionRows.length > 0) {
        req.user = userRows[0];
        req.token = token;
      } else {
        req.user = null;
      }
    } else {
      req.user = null;
    }

    next();
  } catch (error) {
    // 如果token无效，设置user为null继续执行
    req.user = null;
    next();
  }
}

module.exports = {
  authenticateToken,
  optionalAuth
};
