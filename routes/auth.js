const express = require('express');
const router = express.Router();
const { HTTP_STATUS, RESPONSE_CODES, ERROR_MESSAGES } = require('../constants');
const { pool, email: emailConfig } = require('../config/config');
const { generateAccessToken, generateRefreshToken, verifyToken } = require('../utils/jwt');
const { authenticateToken } = require('../middleware/auth');
const { getIPLocation, getRealIP } = require('../utils/ipLocation');
const { sendEmailCode } = require('../utils/email');
const svgCaptcha = require('svg-captcha');
const path = require('path');
const fs = require('fs');
const { execute: dbExec } = require('../utils/dbHelper');

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length < 3 || email.length > 320) return false;
  if (/\s/.test(email)) return false;

  const atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex !== email.lastIndexOf('@')) return false;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (local.length < 1 || local.length > 64) return false;
  if (domain.length < 1 || domain.length > 255) return false;
  if (!domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  if (domain.includes('..')) return false;

  for (let i = 0; i < local.length; i++) {
    const c = local.charCodeAt(i);
    const isAlphaNum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    const isAllowedSymbol = "!#$%&'*+/=?^_`{|}~.-".includes(local[i]);
    if (!isAlphaNum && !isAllowedSymbol) return false;
  }

  for (let i = 0; i < domain.length; i++) {
    const c = domain.charCodeAt(i);
    const isAlphaNum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    const isAllowedSymbol = domain[i] === '-' || domain[i] === '.';
    if (!isAlphaNum && !isAllowedSymbol) return false;
  }

  return true;
}

// 存储验证码的临时对象
const captchaStore = new Map();
// 存储邮箱验证码的临时对象
const emailCodeStore = new Map();

// 获取邮件功能配置状�?router.get('/email-config', (req, res) => {
  res.json({
    code: RESPONSE_CODES.SUCCESS,
    data: {
      emailEnabled: emailConfig.enabled
    },
    message: 'success'
  });
});

// 生成验证�?router.get('/captcha', (req, res) => {
  try {
    // 字体文件路径
    const fontDir = path.join(__dirname, '..', 'fonts');

    // 自动读取字体文件夹中的所�?ttf文件
    let fontFiles = [];
    if (fs.existsSync(fontDir)) {
      fontFiles = fs.readdirSync(fontDir).filter(file => file.endsWith('.ttf'));
    }

    // 如果有字体文件，随机选择一个加�?    if (fontFiles.length > 0) {
      const randomFont = fontFiles[Math.floor(Math.random() * fontFiles.length)];
      const fontPath = path.join(fontDir, randomFont);
      svgCaptcha.loadFont(fontPath);
    }

    const captcha = svgCaptcha.create({
      size: 4, // 验证码长�?      ignoreChars: '0o1ilcIC', // 排除容易混淆的字�?      noise: 4, // 干扰线条�?      color: true, // 彩色验证�?      fontSize: 40,
      background: `#${Math.floor(Math.random() * 16777215).toString(16)}`, // 随机颜色
    });

    // 生成唯一的captchaId
    const captchaId = Date.now() + Math.random().toString(36).substr(2, 9);

    // 存储验证码（半分钟过期）
    captchaStore.set(captchaId, {
      text: captcha.text, // 保持原始大小�?      expires: Date.now() + 30 * 1000 // 半分钟过�?    });

    // 清理过期的验证码
    for (const [key, value] of captchaStore.entries()) {
      if (Date.now() > value.expires) {
        captchaStore.delete(key);
      }
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      data: {
        captchaId,
        captchaSvg: captcha.data
      },
      message: '验证码生成成�?
    });
  } catch (error) {
    console.error('生成验证码失�?', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 检查用户ID是否已存�?router.get('/check-user-id', async (req, res) => {
  try {
    const { user_id } = req.query; // 前端传过来的小石榴号
    if (!user_id) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '请输入小石榴�? });
    }
    // 查数据库是否已有该ID
    const { rows: existingUser } = await dbExec(
      'SELECT id FROM users WHERE user_id = ?',
      [user_id.toString()]
    );
    // 存在返回false，不存在返回true（供前端判断是否可继续）
    res.json({
      code: RESPONSE_CODES.SUCCESS,
      data: { isUnique: existingUser.length === 0 },
      message: existingUser.length > 0 ? '小石榴号已存�? : '小石榴号可用'
    });
  } catch (error) {
    console.error('检查用户ID失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 发送邮箱验证码
router.post('/send-email-code', async (req, res) => {
  try {
    // 检查邮件功能是否启�?    if (!emailConfig.enabled) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮件功能未启�? });
    }

    const { email } = req.body;

    if (!email) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '请输入邮箱地址' });
    }

    // 验证邮箱格式
    if (!isValidEmail(email)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮箱格式不正�? });
    }

    // 检查邮箱是否已被注�?    const { rows: existingUser } = await dbExec(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existingUser.length > 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.CONFLICT, message: '该邮箱已被注�? });
    }

    // 生成6位随机验证码
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // 发送验证码到邮�?    await sendEmailCode(email, code);

    // 存储验证码（10分钟过期�?    const expires = Date.now() + 10 * 60 * 1000;
    emailCodeStore.set(email, {
      code,
      expires
    });

    // 清理过期的验证码
    for (const [key, value] of emailCodeStore.entries()) {
      if (Date.now() > value.expires) {
        emailCodeStore.delete(key);
      }
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '验证码发送成功，请查收邮�?
    });

  } catch (error) {
    console.error('发送邮箱验证码失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: '验证码发送失败，请稍后重�? });
  }
});

// 绑定邮箱
router.post('/bind-email', authenticateToken, async (req, res) => {
  try {
    // 检查邮件功能是否启�?    if (!emailConfig.enabled) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮件功能未启�? });
    }

    const { email, emailCode } = req.body;
    const userId = req.user.id;

    if (!email || !emailCode) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '请输入邮箱和验证�? });
    }

    // 验证邮箱格式
    if (!isValidEmail(email)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮箱格式不正�? });
    }

    // 检查邮箱是否已被其他用户使�?    const { rows: existingUser } = await dbExec(
      'SELECT id FROM users WHERE email = ? AND id != ?',
      [email, userId.toString()]
    );

    if (existingUser.length > 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.CONFLICT, message: '该邮箱已被其他用户绑�? });
    }

    // 验证邮箱验证�?    const storedEmailCode = emailCodeStore.get(email);
    if (!storedEmailCode) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮箱验证码已过期或不存在' });
    }

    if (Date.now() > storedEmailCode.expires) {
      emailCodeStore.delete(email);
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮箱验证码已过期' });
    }

    if (emailCode !== storedEmailCode.code) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮箱验证码错�? });
    }

    // 验证码验证成功，删除已使用的验证�?    emailCodeStore.delete(email);

    // 更新用户邮箱
    await dbExec(
      'UPDATE users SET email = ? WHERE id = ?',
      [email, userId.toString()]
    );

    console.log(`用户绑定邮箱成功 - 用户ID: ${userId}, 邮箱: ${email}`);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '邮箱绑定成功',
      data: { email }
    });

  } catch (error) {
    console.error('绑定邮箱失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: '绑定邮箱失败，请稍后重试' });
  }
});

// 发送找回密码验证码
router.post('/send-reset-code', async (req, res) => {
  try {
    // 检查邮件功能是否启�?    if (!emailConfig.enabled) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮件功能未启�? });
    }

    const { email } = req.body;

    if (!email) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '请输入邮箱地址' });
    }

    // 验证邮箱格式
    if (!isValidEmail(email)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮箱格式不正�? });
    }

    // 检查邮箱是否已注册
    const { rows: existingUser } = await dbExec(
      'SELECT id, user_id FROM users WHERE email = ?',
      [email]
    );

    if (existingUser.length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.NOT_FOUND, message: '该邮箱未绑定任何账号' });
    }

    // 生成6位随机验证码
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // 发送验证码到邮�?    await sendEmailCode(email, code);

    // 存储验证码（10分钟过期�?    const expires = Date.now() + 10 * 60 * 1000;
    emailCodeStore.set(`reset_${email}`, {
      code,
      expires,
      userId: existingUser[0].id
    });

    // 清理过期的验证码
    for (const [key, value] of emailCodeStore.entries()) {
      if (Date.now() > value.expires) {
        emailCodeStore.delete(key);
      }
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '验证码发送成功，请查收邮�?,
      data: {
        user_id: existingUser[0].user_id
      }
    });

  } catch (error) {
    console.error('发送找回密码验证码失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: '验证码发送失败，请稍后重�? });
  }
});

// 验证找回密码验证�?router.post('/verify-reset-code', async (req, res) => {
  try {
    // 检查邮件功能是否启�?    if (!emailConfig.enabled) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮件功能未启�? });
    }

    const { email, emailCode } = req.body;

    if (!email || !emailCode) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '缺少必要参数' });
    }

    // 验证邮箱验证�?    const storedData = emailCodeStore.get(`reset_${email}`);
    if (!storedData) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '验证码已过期，请重新获取' });
    }

    if (Date.now() > storedData.expires) {
      emailCodeStore.delete(`reset_${email}`);
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '验证码已过期，请重新获取' });
    }

    if (storedData.code !== emailCode) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '验证码错�? });
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '验证码验证成�?
    });

  } catch (error) {
    console.error('验证找回密码验证码失�?', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: '验证失败，请稍后重试' });
  }
});

// 重置密码
router.post('/reset-password', async (req, res) => {
  try {
    // 检查邮件功能是否启�?    if (!emailConfig.enabled) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮件功能未启�? });
    }

    const { email, emailCode, newPassword } = req.body;

    if (!email || !emailCode || !newPassword) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '缺少必要参数' });
    }

    // 验证密码长度
    if (newPassword.length < 6 || newPassword.length > 20) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '密码长度必须�?-20位之�? });
    }

    // 验证邮箱验证�?    const storedData = emailCodeStore.get(`reset_${email}`);
    if (!storedData) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '验证码已过期，请重新获取' });
    }

    if (Date.now() > storedData.expires) {
      emailCodeStore.delete(`reset_${email}`);
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '验证码已过期，请重新获取' });
    }

    if (storedData.code !== emailCode) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '验证码错�? });
    }

    // 更新密码
    await dbExec(
      'UPDATE users SET password = encode(digest(?, \'sha256\'), \'hex\') WHERE email = ?',
      [newPassword, email]
    );

    // 删除已使用的验证�?    emailCodeStore.delete(`reset_${email}`);

    console.log(`用户重置密码成功 - 邮箱: ${email}`);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '密码重置成功，请使用新密码登�?
    });

  } catch (error) {
    console.error('重置密码失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: '重置密码失败，请稍后重试' });
  }
});

// 解除邮箱绑定
router.delete('/unbind-email', authenticateToken, async (req, res) => {
  try {
    // 检查邮件功能是否启�?    if (!emailConfig.enabled) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮件功能未启�? });
    }

    const userId = req.user.id;

    // 检查用户是否已绑定邮箱
    const { rows: userRows } = await dbExec(
      'SELECT email FROM users WHERE id = ?',
      [userId.toString()]
    );

    if (userRows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存�? });
    }

    const currentEmail = userRows[0].email;
    if (!currentEmail || currentEmail.trim() === '') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '您尚未绑定邮�? });
    }

    // 解除邮箱绑定（将email设为空字符串�?    await dbExec(
      'UPDATE users SET email = ? WHERE id = ?',
      ['', userId.toString()]
    );

    console.log(`用户解除邮箱绑定成功 - 用户ID: ${userId}, 原邮�? ${currentEmail}`);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '邮箱解绑成功'
    });

  } catch (error) {
    console.error('解除邮箱绑定失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: '解除邮箱绑定失败，请稍后重试' });
  }
});

// 用户注册
router.post('/register', async (req, res) => {
  try {
    const { user_id, nickname, password, captchaId, captchaText, email, emailCode } = req.body;

    // 根据邮件功能是否启用，决定必填参�?    const isEmailEnabled = emailConfig.enabled;

    if (isEmailEnabled) {
      // 邮件功能启用时，邮箱和邮箱验证码必填
      if (!user_id || !nickname || !password || !captchaId || !captchaText || !email || !emailCode) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '缺少必要参数' });
      }
    } else {
      // 邮件功能未启用时，邮箱和邮箱验证码可�?      if (!user_id || !nickname || !password || !captchaId || !captchaText) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '缺少必要参数' });
      }
    }

    // 检查用户ID是否已存�?    const { rows: existingUser } = await dbExec(
      'SELECT id FROM users WHERE user_id = ?',
      [user_id.toString()]
    );
    if (existingUser.length > 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.CONFLICT, message: '用户ID已存�? });
    }

    // 验证验证�?    const storedCaptcha = captchaStore.get(captchaId);
    if (!storedCaptcha) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '验证码已过期或不存在' });
    }

    if (Date.now() > storedCaptcha.expires) {
      captchaStore.delete(captchaId);
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '验证码已过期' });
    }

    if (captchaText !== storedCaptcha.text) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '验证码错�? });
    }

    // 验证码验证成功，删除已使用的验证�?    captchaStore.delete(captchaId);

    // 邮件功能启用时才验证邮箱
    if (isEmailEnabled) {
      // 验证邮箱格式
      if (!isValidEmail(email)) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮箱格式不正�? });
      }

      // 验证邮箱验证�?      const storedEmailCode = emailCodeStore.get(email);
      if (!storedEmailCode) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮箱验证码已过期或不存在' });
      }

      if (Date.now() > storedEmailCode.expires) {
        emailCodeStore.delete(email);
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮箱验证码已过期' });
      }

      if (emailCode !== storedEmailCode.code) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '邮箱验证码错�? });
      }

      // 邮箱验证码验证成功，删除已使用的验证�?      emailCodeStore.delete(email);
    }

    if (user_id.length < 3 || user_id.length > 15) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '小石榴号长度必须�?-15位之�? });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(user_id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '小石榴号只能包含字母、数字和下划�? });
    }

    if (nickname.length > 10) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '昵称长度必须少于10�? });
    }

    if (password.length < 6 || password.length > 20) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '密码长度必须�?-20位之�? });
    }

    // 获取用户IP属地
    const userIP = getRealIP(req);
    let ipLocation;
    try {
      ipLocation = await getIPLocation(userIP);
    } catch (error) {
      ipLocation = '未知';
    }
    // 获取用户User-Agent
    const userAgent = req.headers['user-agent'] || '';
    // 默认头像使用空字符串，前端会使用本地默认头像
    const defaultAvatar = '';

    // 插入新用户（密码使用SHA2哈希加密�?    // 邮件功能未启用时，email字段存储空字符串
    const userEmail = isEmailEnabled ? email : '';
    const { rows: insertResult } = await dbExec(
      'INSERT INTO users (user_id, nickname, password, email, avatar, bio, location, last_login_at) VALUES (?, encode(digest(?, \'sha256\'), \'hex\'), ?, ?, ?, ?, NOW()) RETURNING id',
      [user_id, password, userEmail, defaultAvatar, '', ipLocation]
    );

    const userId = insertResult[0].id;

    // 生成JWT令牌
    const accessToken = generateAccessToken({ userId, user_id });
    const refreshToken = generateRefreshToken({ userId, user_id });

    // 保存会话
    await dbExec(
      'INSERT INTO user_sessions (user_id, token, refresh_token, expires_at, user_agent, is_active) VALUES (?, ?, ?, NOW() + INTERVAL \'7 days\', ?, 1)',
      [userId.toString(), accessToken, refreshToken, userAgent]
    );

    // 获取完整用户信息
    const { rows: userRows } = await dbExec(
      'SELECT id, user_id, nickname, avatar, bio, location, follow_count, fans_count, like_count FROM users WHERE id = ?',
      [userId.toString()]
    );

    console.log(`用户注册成功 - 用户ID: ${userId}, 小石榴号: ${userRows[0].user_id}`);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '注册成功',
      data: {
        user: userRows[0],
        tokens: {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600
        }
      }
    });
  } catch (error) {
    console.error('用户注册失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 用户登录
router.post('/login', async (req, res) => {
  try {
    const { user_id, password } = req.body;
    if (!user_id || !password) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '缺少必要参数' });
    }

    // 查找用户
    const { rows: userRows } = await dbExec(
      'SELECT id, user_id, nickname, avatar, bio, location, follow_count, fans_count, like_count, is_active, gender, zodiac_sign, mbti, education, major, interests FROM users WHERE user_id = ?',
      [user_id.toString()]
    );

    if (userRows.length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存�? });
    }

    const user = userRows[0];

    if (!user.is_active) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '账户已被禁用' });
    }

    // 验证密码（SHA256 哈希比较�?    const crypto = require('crypto');
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    const { rows: passwordCheck } = await dbExec(
      'SELECT 1 FROM users WHERE id = ? AND password = ?',
      [user.id.toString(), passwordHash]
    );

    if (passwordCheck.length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '密码错误' });
    }

    // 生成JWT令牌
    const accessToken = generateAccessToken({ userId: user.id, user_id: user.user_id });
    const refreshToken = generateRefreshToken({ userId: user.id, user_id: user.user_id });

    // 获取用户IP和User-Agent
    const userIP = getRealIP(req);
    const userAgent = req.headers['user-agent'] || '';

    // 获取IP地理位置并更新用户location和最后登录时�?    const ipLocation = await getIPLocation(userIP);
    await dbExec(
      'UPDATE users SET location = ?, last_login_at = NOW() WHERE id = ?',
      [ipLocation, user.id.toString()]
    );

    // 清除旧会话并保存新会�?    await dbExec('UPDATE user_sessions SET is_active = false WHERE user_id = ?', [user.id.toString()]);
    await dbExec(
      'INSERT INTO user_sessions (user_id, token, refresh_token, expires_at, user_agent, is_active) VALUES (?, ?, ?, NOW() + INTERVAL \'7 days\', ?, 1)',
      [user.id.toString(), accessToken, refreshToken, userAgent]
    );

    // 更新用户对象中的location字段
    user.location = ipLocation;

    // 移除密码字段
    delete user.password;

    // 处理interests字段（如果是JSON字符串则解析�?    if (user.interests) {
      try {
        user.interests = typeof user.interests === 'string'
          ? JSON.parse(user.interests)
          : user.interests;
      } catch (e) {
        user.interests = null;
      }
    }

    console.log(`用户登录成功 - 用户ID: ${user.id}, 小石榴号: ${user.user_id}`);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '登录成功',
      data: {
        user,
        tokens: {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600
        }
      }
    });
  } catch (error) {
    console.error('用户登录失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 刷新令牌
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '缺少刷新令牌' });
    }

    // 验证刷新令牌
    const decoded = verifyToken(refresh_token);

    // 检查会话是否有�?    const { rows: sessionRows } = await dbExec(
      'SELECT id FROM user_sessions WHERE user_id = ? AND refresh_token = ? AND is_active = true AND expires_at > NOW()',
      [decoded.userId.toString(), refresh_token]
    );

    if (sessionRows.length === 0) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({ code: RESPONSE_CODES.UNAUTHORIZED, message: '刷新令牌无效或已过期' });
    }

    // 生成新的令牌
    const newAccessToken = generateAccessToken({ userId: decoded.userId, user_id: decoded.user_id });
    const newRefreshToken = generateRefreshToken({ userId: decoded.userId, user_id: decoded.user_id });

    // 获取用户IP和User-Agent
    const userIP = getRealIP(req);
    const userAgent = req.headers['user-agent'] || '';

    // 获取IP地理位置并更新用户location
    const ipLocation = await getIPLocation(userIP);
    await dbExec(
      'UPDATE users SET location = ? WHERE id = ?',
      [ipLocation, decoded.userId.toString()]
    );

    // 更新会话
    await dbExec(
      'UPDATE user_sessions SET token = ?, refresh_token = ?, expires_at = NOW() + INTERVAL \'7 days\', user_agent = ? WHERE id = ?',
      [newAccessToken, newRefreshToken, userAgent, sessionRows[0].id.toString()]
    );

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '令牌刷新成功',
      data: {
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        expires_in: 3600
      }
    });
  } catch (error) {
    console.error('刷新令牌失败:', error);
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ code: RESPONSE_CODES.UNAUTHORIZED, message: '刷新令牌无效' });
  }
});

// 退出登�?router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const token = req.token;

    // 将当前会话设为无�?    await dbExec(
      'UPDATE user_sessions SET is_active = false WHERE user_id = ? AND token = ?',
      [userId.toString(), token]
    );

    console.log(`用户退出成�?- 用户ID: ${userId}`);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '退出成�?
    });
  } catch (error) {
    console.error('退出登录失�?', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取当前用户信息
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows: userRows } = await dbExec(
      'SELECT u.id, u.user_id, u.nickname, u.avatar, u.bio, u.location, u.email, u.follow_count, u.fans_count, u.like_count, u.is_active, u.created_at, u.gender, u.zodiac_sign, u.mbti, u.education, u.major, u.interests, u.verified, uv.title as verified_title FROM users u LEFT JOIN user_verification uv ON u.id = uv.user_id AND uv.status = 1 WHERE u.id = ?',
      [userId.toString()]
    );

    if (userRows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '用户不存�? });
    }

    const user = userRows[0];

    // 处理interests字段（如果是JSON字符串则解析�?    if (user.interests) {
      try {
        user.interests = typeof user.interests === 'string'
          ? JSON.parse(user.interests)
          : user.interests;
      } catch (e) {
        user.interests = null;
      }
    }

    // 查询用户的封禁状�?    const { rows: banResult } = await dbExec(
      'SELECT reason, end_time, created_at FROM user_ban WHERE user_id = ? AND status IN (0, 3) ORDER BY created_at DESC LIMIT 1',
      [user.id.toString()]
    );

    // 添加封禁状态信�?    if (banResult.length > 0) {
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

// 管理员登�?router.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '缺少必要参数' });
    }

    // 查找管理�?    const { rows: adminRows } = await dbExec(
      'SELECT id, username, password FROM admin WHERE username = ?',
      [username]
    );

    if (adminRows.length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.NOT_FOUND, message: '管理员账号不存在' });
    }

    const admin = adminRows[0];

    // 验证密码（哈希比较）
    const { rows: passwordCheck } = await dbExec(
      'SELECT 1 FROM admin WHERE id = ? AND password = encode(digest(?, \'sha256\'), \'hex\')',
      [admin.id.toString(), password]
    );

    if (passwordCheck.length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '密码错误' });
    }

    // 生成JWT令牌
    const accessToken = generateAccessToken({
      adminId: admin.id,
      username: admin.username,
      type: 'admin'
    });
    const refreshToken = generateRefreshToken({
      adminId: admin.id,
      username: admin.username,
      type: 'admin'
    });

    // 获取用户IP和User-Agent
    const userIP = getRealIP(req);
    const userAgent = req.headers['user-agent'] || '';

    // 清除旧会话并保存新会�?    await dbExec('UPDATE admin_sessions SET is_active = false WHERE admin_id = ?', [admin.id.toString()]);
    await dbExec(
      'INSERT INTO admin_sessions (admin_id, token, refresh_token, expires_at, user_agent, is_active) VALUES (?, ?, ?, NOW() + INTERVAL \'7 days\', ?, 1)',
      [admin.id.toString(), accessToken, refreshToken, userAgent]
    );

    // 移除密码字段
    delete admin.password;

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '登录成功',
      data: {
        admin,
        tokens: {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600
        }
      }
    });
  } catch (error) {
    console.error('管理员登录失�?', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取当前管理员信�?router.get('/admin/me', authenticateToken, async (req, res) => {
  try {
    // 检查是否为管理员token
    if (!req.user.type || req.user.type !== 'admin') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '权限不足' });
    }

    const adminId = req.user.adminId;

    const { rows: adminRows } = await dbExec(
      'SELECT id, username FROM admin WHERE id = ?',
      [adminId.toString()]
    );

    if (adminRows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '管理员不存在' });
    }

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: adminRows[0]
    });
  } catch (error) {
    console.error('获取管理员信息失�?', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 获取管理员列�?router.get('/admin/admins', authenticateToken, async (req, res) => {
  try {
    // 检查是否为管理员token
    if (!req.user.type || req.user.type !== 'admin') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '权限不足' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    // 搜索条件
    let whereClause = '';
    const params = [];

    if (req.query.username) {
      whereClause += ' WHERE username LIKE ?';
      params.push(`%${req.query.username}%`);
    }

    // 验证排序字段
    const allowedSortFields = ['username', 'created_at'];
    const sortField = allowedSortFields.includes(req.query.sortField) ? req.query.sortField : 'created_at';
    const sortOrder = req.query.sortOrder && req.query.sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // 获取总数
    const countQuery = `SELECT COUNT(*) as total FROM admin ${whereClause}`;
    const { rows: countRows } = await dbExec(countQuery, params);
    const total = countRows[0].total;

    // 查询管理员列�?    const dataQuery = `
      SELECT username, password, created_at
      FROM admin
      ${whereClause}
      ORDER BY ${sortField} ${sortOrder}
      LIMIT ? OFFSET ?
    `;
    const { rows: adminRows } = await dbExec(dataQuery, [...params, String(limit), String(offset)]);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: 'success',
      data: {
        data: adminRows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('获取管理员列表失�?', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 创建管理�?router.post('/admin/admins', authenticateToken, async (req, res) => {
  try {
    // 检查是否为管理员token
    if (!req.user.type || req.user.type !== 'admin') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '权限不足' });
    }

    const { username, password } = req.body;

    // 验证必填字段
    if (!username || !password) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '账号和密码不能为�? });
    }

    // 检查用户名是否已存�?    const { rows: existingRows } = await dbExec(
      'SELECT id FROM admin WHERE username = ?',
      [username]
    );

    if (existingRows.length > 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.CONFLICT, message: '账号已存�? });
    }

    // 创建管理员（密码使用SHA2哈希加密�?    const { rows: insertResult } = await dbExec(
      'INSERT INTO admin (username, password, created_at) VALUES (?, encode(digest(?, \'sha256\'), \'hex\'), NOW()) RETURNING id',
      [username, password]
    );

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '创建管理员成�?,
      data: {
        id: insertResult[0].id
      }
    });
  } catch (error) {
    console.error('创建管理员失�?', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 更新管理员信�?router.put('/admin/admins/:id', authenticateToken, async (req, res) => {
  try {
    // 检查是否为管理员token
    if (!req.user.type || req.user.type !== 'admin') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '权限不足' });
    }

    const adminId = req.params.id;
    const { password } = req.body;

    // 验证必填字段
    if (!password) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '密码不能为空' });
    }

    // 检查管理员是否存在
    const { rows: adminRows } = await dbExec(
      'SELECT username FROM admin WHERE username = ?',
      [adminId]
    );

    if (adminRows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '管理员不存在' });
    }

    // 更新管理员密码（使用SHA2哈希加密�?    await dbExec(
      'UPDATE admin SET password = encode(digest(?, \'sha256\'), \'hex\') WHERE username = ?',
      [password, adminId]
    );

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '更新管理员信息成�?
    });
  } catch (error) {
    console.error('更新管理员信息失�?', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 删除管理�?router.delete('/admin/admins/:id', authenticateToken, async (req, res) => {
  try {
    // 检查是否为管理员token
    if (!req.user.type || req.user.type !== 'admin') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '权限不足' });
    }

    const adminId = req.params.id;

    // 检查管理员是否存在
    const { rows: adminRows } = await dbExec(
      'SELECT username FROM admin WHERE username = ?',
      [adminId]
    );

    if (adminRows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '管理员不存在' });
    }

    // 删除管理�?    await dbExec('DELETE FROM admin WHERE username = ?', [adminId]);

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '删除管理员成�?
    });
  } catch (error) {
    console.error('删除管理员失�?', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 重置管理员密�?router.put('/admin/admins/:id/password', authenticateToken, async (req, res) => {
  try {
    // 检查是否为管理员token
    if (!req.user.type || req.user.type !== 'admin') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '权限不足' });
    }

    const adminId = req.params.id;
    const { password } = req.body;

    // 验证密码
    if (!password || password.length < 6) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '密码不能为空且长度不能少�?�? });
    }

    // 检查管理员是否存在
    const { rows: adminRows } = await dbExec(
      'SELECT id FROM admin WHERE id = ?',
      [adminId.toString()]
    );

    if (adminRows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ code: RESPONSE_CODES.NOT_FOUND, message: '管理员不存在' });
    }

    // 更新密码（使用SHA2哈希加密�?    await dbExec(
      'UPDATE admin SET password = encode(digest(?, \'sha256\'), \'hex\') WHERE id = ?',
      [password, adminId.toString()]
    );

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '重置密码成功'
    });
  } catch (error) {
    console.error('重置密码失败:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// 管理员刷新令�?router.post('/admin/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ code: RESPONSE_CODES.VALIDATION_ERROR, message: '缺少刷新令牌' });
    }

    // 验证刷新令牌
    const decoded = verifyToken(refresh_token);

    // 检查是否为管理员令�?    if (!decoded.type || decoded.type !== 'admin') {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({ code: RESPONSE_CODES.UNAUTHORIZED, message: '无效的刷新令�? });
    }

    // 检查会话是否有�?    const { rows: sessionRows } = await dbExec(
      'SELECT id FROM admin_sessions WHERE admin_id = ? AND refresh_token = ? AND is_active = true AND expires_at > NOW()',
      [decoded.adminId.toString(), refresh_token]
    );

    if (sessionRows.length === 0) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({ code: RESPONSE_CODES.UNAUTHORIZED, message: '刷新令牌无效或已过期' });
    }

    // 生成新的令牌
    const newAccessToken = generateAccessToken({
      adminId: decoded.adminId,
      username: decoded.username,
      type: 'admin'
    });
    const newRefreshToken = generateRefreshToken({
      adminId: decoded.adminId,
      username: decoded.username,
      type: 'admin'
    });

    // 获取用户IP和User-Agent
    const userAgent = req.headers['user-agent'] || '';

    // 更新会话
    await dbExec(
      'UPDATE admin_sessions SET token = ?, refresh_token = ?, expires_at = NOW() + INTERVAL \'7 days\', user_agent = ? WHERE id = ?',
      [newAccessToken, newRefreshToken, userAgent, sessionRows[0].id.toString()]
    );

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '令牌刷新成功',
      data: {
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        expires_in: 3600
      }
    });
  } catch (error) {
    console.error('刷新令牌失败:', error);
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ code: RESPONSE_CODES.UNAUTHORIZED, message: '刷新令牌无效' });
  }
});

// 管理员登�?router.post('/admin/logout', authenticateToken, async (req, res) => {
  try {
    // 检查是否为管理员token
    if (!req.user.type || req.user.type !== 'admin') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ code: RESPONSE_CODES.FORBIDDEN, message: '权限不足' });
    }

    const adminId = req.user.adminId || req.user.id;
    const token = req.token;

    // 注销会话
    await dbExec(
      'UPDATE admin_sessions SET is_active = false WHERE admin_id = ? AND token = ?',
      [adminId.toString(), token]
    );

    res.json({
      code: RESPONSE_CODES.SUCCESS,
      message: '登出成功'
    });
  } catch (error) {
    console.error('管理员登出失�?', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ code: RESPONSE_CODES.ERROR, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

module.exports = router;
