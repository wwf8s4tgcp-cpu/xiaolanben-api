/**
 * 小蓝本校园图文社区 - 应用配置文件
 * 集中管理所有配置项
 * 
 * @author ZTMYO
 * @github https://github.com/ZTMYO
 * @description Express应用的核心配置管理
 * @version v1.3.2
 */

const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });


const config = {
  // 服务器配置
  server: {
    port: process.env.PORT || 3001,
    env: process.env.NODE_ENV || 'development'
  },

  // CORS配置
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim()) : ['http://localhost:5173', 'http://localhost:3001']
  },

  // JWT配置
  jwt: {
    secret: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d'
  },

  // Supabase (PostgreSQL) 数据库配置
  database: {
    connectionString: 'postgresql://postgres:3ab%40%2CVCy*zALsGk@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres',
    host: 'aws-1-ap-northeast-1.pooler.supabase.com',
    user: 'postgres.jilfvyspdgasvpzvntyc',
    password: '3ab@,VCy*zALsGk',
    database: 'postgres',
    port: 5432,
    ssl: { rejectUnauthorized: false }
  },

  // Supabase 客户端配置
  supabase: {
    url: process.env.SUPABASE_URL || 'https://vwf8s4tgcp-cpu.supabase.co',
    anonKey: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppbGZ2eXNwZGdhc3ZwenZudHljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MTQ3NDMsImV4cCI6MjA5NjI5MDc0M30.awFcIfYcbwi-pDR7qFUlcQjIx68Ay0TJjkRU17S-XVQ'
  },

  // 上传配置
  upload: {
    // 图片上传配置
    image: {
      maxSize: process.env.IMAGE_MAX_SIZE || '10mb',
      allowedTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
      // 图片上传策略配置
      strategy: process.env.IMAGE_UPLOAD_STRATEGY || 'imagehost', // 'local', 'imagehost' 或 'r2'
      // 本地存储配置
      local: {
        uploadDir: process.env.IMAGE_LOCAL_UPLOAD_DIR || 'uploads/images',
        baseUrl: process.env.LOCAL_BASE_URL || 'http://localhost:3001'
      },
      // 第三方图床配置
      imagehost: {
        apiUrl: process.env.IMAGEHOST_API_URL || 'https://api.xinyew.cn/api/360tc',
        timeout: parseInt(process.env.IMAGEHOST_TIMEOUT) || 60000
      },
      // Cloudflare R2配置
      r2: {
        accountId: process.env.R2_ACCOUNT_ID,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        bucketName: process.env.R2_BUCKET_NAME,
        endpoint: process.env.R2_ENDPOINT,
        publicUrl: process.env.R2_PUBLIC_URL, // 可选：自定义域名
        region: process.env.R2_REGION || 'auto'
      }
    },
    // 视频上传配置
    video: {
      maxSize: process.env.VIDEO_MAX_SIZE || '100mb',
      allowedTypes: ['video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv', 'video/webm'],
      // 视频上传策略配置（只支持本地和R2，不支持第三方图床）
      strategy: process.env.VIDEO_UPLOAD_STRATEGY || 'local', // 'local' 或 'r2'
      // 本地存储配置
      local: {
        uploadDir: process.env.VIDEO_LOCAL_UPLOAD_DIR || 'uploads/videos',
        baseUrl: process.env.LOCAL_BASE_URL || 'http://localhost:3001'
      },
      // Cloudflare R2配置
      r2: {
        accountId: process.env.R2_ACCOUNT_ID,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        bucketName: process.env.R2_BUCKET_NAME,
        endpoint: process.env.R2_ENDPOINT,
        publicUrl: process.env.R2_PUBLIC_URL, // 可选：自定义域名
        region: process.env.R2_REGION || 'auto'
      }
    }
  },

  // API配置
  api: {
    baseUrl: process.env.API_BASE_URL || 'http://localhost:3001',
    timeout: 30000
  },

  // 分页配置
  pagination: {
    defaultLimit: 20,
    maxLimit: 100
  },

  // 缓存配置
  cache: {
    ttl: 300 // 5分钟
  },

  // 邮件服务配置
  email: {
    // 是否启用邮件功能
    enabled: process.env.EMAIL_ENABLED === 'true', // 默认不启用
    // SMTP服务器配置
    smtp: {
      host: process.env.SMTP_HOST || 'smtp.qq.com',
      port: parseInt(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE === 'false' ? false : true, // 默认使用SSL
      auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASSWORD || ''
      }
    },
    // 发件人配置
    from: {
      email: process.env.EMAIL_FROM || '',
      name: process.env.EMAIL_FROM_NAME || '小石榴校园图文社区'
    }
  },

  // IP属地查询配置
  ipLocation: {
    primaryApi: process.env.IP_LOCATION_PRIMARY_API || 'https://api.pearktrue.cn/api/ip/details',
    backupApi: process.env.IP_LOCATION_BACKUP_API || 'https://api.pearktrue.cn/api/ip/high',
    primaryTimeout: parseInt(process.env.IP_LOCATION_PRIMARY_TIMEOUT) || 10000,
    backupTimeout: parseInt(process.env.IP_LOCATION_BACKUP_TIMEOUT) || 5000
  }
};

// PostgreSQL 连接池配置
const pgPoolConfig = {
  connectionString: config.database.connectionString || undefined,
  host: config.database.host,
  user: config.database.user,
  password: config.database.password,
  database: config.database.database,
  port: config.database.port,
  ssl: config.database.ssl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
};

// 创建连接池
const pool = new Pool(pgPoolConfig);

// 连接池错误处理
pool.on('error', (err) => {
  console.error('PostgreSQL 连接池异常错误:', err.message);
});

module.exports = {
  ...config,
  pool
};