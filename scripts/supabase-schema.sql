-- ============================================================
-- 小蓝本校园图文社区 - Supabase (PostgreSQL) 数据库初始化脚本
-- 在 Supabase SQL Editor 中运行此脚本
-- ============================================================

-- 1. 用户表
CREATE TABLE IF NOT EXISTS "users" (
  "id" BIGSERIAL NOT NULL,
  "password" VARCHAR(255) DEFAULT NULL,
  "user_id" VARCHAR(50) NOT NULL,
  "nickname" VARCHAR(100) NOT NULL,
  "email" VARCHAR(100) DEFAULT NULL,
  "avatar" VARCHAR(500) DEFAULT NULL,
  "bio" TEXT DEFAULT NULL,
  "location" VARCHAR(100) DEFAULT NULL,
  "follow_count" INTEGER DEFAULT 0,
  "fans_count" INTEGER DEFAULT 0,
  "like_count" INTEGER DEFAULT 0,
  "is_active" BOOLEAN DEFAULT TRUE,
  "last_login_at" TIMESTAMP DEFAULT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "gender" VARCHAR(10) DEFAULT NULL,
  "zodiac_sign" VARCHAR(20) DEFAULT NULL,
  "mbti" VARCHAR(4) DEFAULT NULL,
  "education" VARCHAR(50) DEFAULT NULL,
  "major" VARCHAR(100) DEFAULT NULL,
  "interests" JSONB DEFAULT NULL,
  "verified" BOOLEAN DEFAULT FALSE,
  PRIMARY KEY ("id"),
  CONSTRAINT "users_user_id_key" UNIQUE ("user_id")
);
CREATE INDEX IF NOT EXISTS "idx_users_user_id" ON "users" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email");
CREATE INDEX IF NOT EXISTS "idx_users_created_at" ON "users" ("created_at");
COMMENT ON TABLE "users" IS '用户表';
COMMENT ON COLUMN "users"."id" IS '用户ID';
COMMENT ON COLUMN "users"."user_id" IS '小石榴号';
COMMENT ON COLUMN "users"."is_active" IS '是否激活';
COMMENT ON COLUMN "users"."verified" IS '认证状态：false-未认证，true-已认证';

-- 自动更新 updated_at 的触发器函数
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 为用户表添加 updated_at 触发器
DROP TRIGGER IF EXISTS trigger_users_updated_at ON "users";
CREATE TRIGGER trigger_users_updated_at
    BEFORE UPDATE ON "users"
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 2. 管理员表
CREATE TABLE IF NOT EXISTS "admin" (
  "id" BIGSERIAL NOT NULL,
  "username" VARCHAR(50) NOT NULL,
  "password" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "admin_username_key" UNIQUE ("username")
);
CREATE INDEX IF NOT EXISTS "idx_admin_username" ON "admin" ("username");
COMMENT ON TABLE "admin" IS '管理员表';

-- 3. 分类表
CREATE TABLE IF NOT EXISTS "categories" (
  "id" SERIAL NOT NULL,
  "name" VARCHAR(50) NOT NULL,
  "category_title" VARCHAR(50) DEFAULT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "categories_name_key" UNIQUE ("name"),
  CONSTRAINT "categories_category_title_key" UNIQUE ("category_title")
);
COMMENT ON TABLE "categories" IS '分类表';

-- 4. 笔记表
CREATE TABLE IF NOT EXISTS "posts" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "content" TEXT NOT NULL,
  "category_id" INTEGER DEFAULT NULL,
  "type" INTEGER DEFAULT 1,
  "view_count" BIGINT DEFAULT 0,
  "like_count" INTEGER DEFAULT 0,
  "collect_count" INTEGER DEFAULT 0,
  "comment_count" INTEGER DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "status" SMALLINT DEFAULT 2,
  PRIMARY KEY ("id"),
  CONSTRAINT "posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "posts_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "idx_posts_user_id" ON "posts" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_posts_category_id" ON "posts" ("category_id");
CREATE INDEX IF NOT EXISTS "idx_posts_created_at" ON "posts" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_posts_like_count" ON "posts" ("like_count");
CREATE INDEX IF NOT EXISTS "idx_posts_category_id_created_at" ON "posts" ("category_id", "created_at");
COMMENT ON TABLE "posts" IS '笔记表';
COMMENT ON COLUMN "posts"."type" IS '笔记类型：1-图片笔记，2-视频笔记';
COMMENT ON COLUMN "posts"."status" IS '笔记状态：0-发布（审核通过），1-草稿，2-待审核';

-- 5. 笔记图片表
CREATE TABLE IF NOT EXISTS "post_images" (
  "id" BIGSERIAL NOT NULL,
  "post_id" BIGINT NOT NULL,
  "image_url" VARCHAR(500) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "post_images_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_post_images_post_id" ON "post_images" ("post_id");
COMMENT ON TABLE "post_images" IS '笔记图片表';

-- 6. 笔记视频表
CREATE TABLE IF NOT EXISTS "post_videos" (
  "id" BIGSERIAL NOT NULL,
  "post_id" BIGINT NOT NULL,
  "cover_url" VARCHAR(500) DEFAULT NULL,
  "video_url" VARCHAR(500) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "post_videos_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_post_videos_post_id" ON "post_videos" ("post_id");
COMMENT ON TABLE "post_videos" IS '笔记视频表';

-- 7. 标签表
CREATE TABLE IF NOT EXISTS "tags" (
  "id" SERIAL NOT NULL,
  "name" VARCHAR(50) NOT NULL,
  "use_count" INTEGER DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "tags_name_key" UNIQUE ("name")
);
CREATE INDEX IF NOT EXISTS "idx_tags_name" ON "tags" ("name");
CREATE INDEX IF NOT EXISTS "idx_tags_use_count" ON "tags" ("use_count");
COMMENT ON TABLE "tags" IS '标签表';

-- 8. 笔记标签关联表
CREATE TABLE IF NOT EXISTS "post_tags" (
  "id" BIGSERIAL NOT NULL,
  "post_id" BIGINT NOT NULL,
  "tag_id" INTEGER NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "post_tags_post_id_tag_id_key" UNIQUE ("post_id", "tag_id"),
  CONSTRAINT "post_tags_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE,
  CONSTRAINT "post_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_post_tags_post_id" ON "post_tags" ("post_id");
CREATE INDEX IF NOT EXISTS "idx_post_tags_tag_id" ON "post_tags" ("tag_id");
COMMENT ON TABLE "post_tags" IS '笔记标签关联表';

-- 9. 关注关系表
CREATE TABLE IF NOT EXISTS "follows" (
  "id" BIGSERIAL NOT NULL,
  "follower_id" BIGINT NOT NULL,
  "following_id" BIGINT NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "follows_follower_id_following_id_key" UNIQUE ("follower_id", "following_id"),
  CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "follows_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_follows_follower_id" ON "follows" ("follower_id");
CREATE INDEX IF NOT EXISTS "idx_follows_following_id" ON "follows" ("following_id");
COMMENT ON TABLE "follows" IS '关注关系表';

-- 10. 点赞表
CREATE TABLE IF NOT EXISTS "likes" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "target_type" SMALLINT NOT NULL,
  "target_id" BIGINT NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "likes_user_id_target_type_target_id_key" UNIQUE ("user_id", "target_type", "target_id"),
  CONSTRAINT "likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_likes_user_id" ON "likes" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_likes_target" ON "likes" ("target_type", "target_id");
COMMENT ON TABLE "likes" IS '点赞表';
COMMENT ON COLUMN "likes"."target_type" IS '目标类型: 1-笔记, 2-评论';

-- 11. 收藏表
CREATE TABLE IF NOT EXISTS "collections" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "post_id" BIGINT NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "collections_user_id_post_id_key" UNIQUE ("user_id", "post_id"),
  CONSTRAINT "collections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "collections_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_collections_user_id" ON "collections" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_collections_post_id" ON "collections" ("post_id");
COMMENT ON TABLE "collections" IS '收藏表';

-- 12. 评论表
CREATE TABLE IF NOT EXISTS "comments" (
  "id" BIGSERIAL NOT NULL,
  "post_id" BIGINT NOT NULL,
  "user_id" BIGINT NOT NULL,
  "parent_id" BIGINT DEFAULT NULL,
  "content" TEXT NOT NULL,
  "like_count" INTEGER DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE,
  CONSTRAINT "comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_comments_post_id" ON "comments" ("post_id");
CREATE INDEX IF NOT EXISTS "idx_comments_user_id" ON "comments" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_comments_parent_id" ON "comments" ("parent_id");
CREATE INDEX IF NOT EXISTS "idx_comments_created_at" ON "comments" ("created_at");
COMMENT ON TABLE "comments" IS '评论表';

-- 13. 通知表
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "sender_id" BIGINT NOT NULL,
  "type" SMALLINT NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "target_id" BIGINT DEFAULT NULL,
  "comment_id" BIGINT DEFAULT NULL,
  "is_read" BOOLEAN DEFAULT FALSE,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "notifications_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "notifications_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_notifications_user_id" ON "notifications" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_notifications_sender_id" ON "notifications" ("sender_id");
CREATE INDEX IF NOT EXISTS "idx_notifications_type" ON "notifications" ("type");
CREATE INDEX IF NOT EXISTS "idx_notifications_is_read" ON "notifications" ("is_read");
CREATE INDEX IF NOT EXISTS "idx_notifications_user_read" ON "notifications" ("user_id", "is_read");
CREATE INDEX IF NOT EXISTS "idx_notifications_created_at" ON "notifications" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_notifications_comment_id" ON "notifications" ("comment_id");
COMMENT ON TABLE "notifications" IS '通知表';
COMMENT ON COLUMN "notifications"."type" IS '通知类型: 1-点赞, 2-评论, 3-关注';

-- 14. 用户会话表
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "token" VARCHAR(255) NOT NULL,
  "refresh_token" VARCHAR(255) DEFAULT NULL,
  "expires_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "user_agent" TEXT DEFAULT NULL,
  "is_active" BOOLEAN DEFAULT TRUE,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "user_sessions_token_key" UNIQUE ("token"),
  CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_user_sessions_user_id" ON "user_sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_user_sessions_token" ON "user_sessions" ("token");
CREATE INDEX IF NOT EXISTS "idx_user_sessions_expires_at" ON "user_sessions" ("expires_at");

DROP TRIGGER IF EXISTS trigger_user_sessions_updated_at ON "user_sessions";
CREATE TRIGGER trigger_user_sessions_updated_at
    BEFORE UPDATE ON "user_sessions"
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE "user_sessions" IS '用户会话表';

-- 15. 管理员会话表
CREATE TABLE IF NOT EXISTS "admin_sessions" (
  "id" BIGSERIAL NOT NULL,
  "admin_id" BIGINT NOT NULL,
  "token" VARCHAR(255) NOT NULL,
  "refresh_token" VARCHAR(255) DEFAULT NULL,
  "expires_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "user_agent" TEXT DEFAULT NULL,
  "is_active" BOOLEAN DEFAULT TRUE,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "admin_sessions_token_key" UNIQUE ("token"),
  CONSTRAINT "admin_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_admin_sessions_admin_id" ON "admin_sessions" ("admin_id");
CREATE INDEX IF NOT EXISTS "idx_admin_sessions_token" ON "admin_sessions" ("token");
CREATE INDEX IF NOT EXISTS "idx_admin_sessions_expires_at" ON "admin_sessions" ("expires_at");

DROP TRIGGER IF EXISTS trigger_admin_sessions_updated_at ON "admin_sessions";
CREATE TRIGGER trigger_admin_sessions_updated_at
    BEFORE UPDATE ON "admin_sessions"
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE "admin_sessions" IS '管理员会话表';

-- 16. 审核表
CREATE TABLE IF NOT EXISTS "audit" (
  "id" BIGSERIAL NOT NULL,
  "admin_id" BIGINT DEFAULT NULL,
  "type" SMALLINT NOT NULL,
  "target_id" BIGINT NOT NULL,
  "remark" TEXT DEFAULT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "audit_time" TIMESTAMP DEFAULT NULL,
  "status" SMALLINT DEFAULT 0,
  PRIMARY KEY ("id"),
  CONSTRAINT "audit_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "idx_audit_admin_id" ON "audit" ("admin_id");
CREATE INDEX IF NOT EXISTS "idx_audit_type" ON "audit" ("type");
CREATE INDEX IF NOT EXISTS "idx_audit_target_id" ON "audit" ("target_id");
CREATE INDEX IF NOT EXISTS "idx_audit_status" ON "audit" ("status");
CREATE INDEX IF NOT EXISTS "idx_audit_created_at" ON "audit" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_audit_type_target" ON "audit" ("type", "target_id");
COMMENT ON TABLE "audit" IS '审核表';
COMMENT ON COLUMN "audit"."type" IS '审核类型：1-用户个人审核，2-用户官方审核，3-内容审核，4-评论审核';
COMMENT ON COLUMN "audit"."status" IS '审核状态：0-待审核，1-审核通过，2-审核拒绝';

-- 17. 用户认证表
CREATE TABLE IF NOT EXISTS "user_verification" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "type" SMALLINT NOT NULL,
  "status" SMALLINT DEFAULT 0,
  "real_name" VARCHAR(200) NOT NULL,
  "id_card" VARCHAR(18) NOT NULL,
  "contact_name" VARCHAR(50) DEFAULT NULL,
  "contact_phone" VARCHAR(20) DEFAULT NULL,
  "title" VARCHAR(100) DEFAULT NULL,
  "description" TEXT DEFAULT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id"),
  CONSTRAINT "user_verification_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "user_verification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_user_verification_type" ON "user_verification" ("type");
CREATE INDEX IF NOT EXISTS "idx_user_verification_status" ON "user_verification" ("status");
COMMENT ON TABLE "user_verification" IS '用户认证表';
COMMENT ON COLUMN "user_verification"."type" IS '认证类型：1=官方认证 2=个人认证';
COMMENT ON COLUMN "user_verification"."status" IS '认证状态：0=待审核 1=已通过 2=已拒绝';

-- 18. 用户封禁表
CREATE TABLE IF NOT EXISTS "user_ban" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "reason" TEXT NOT NULL,
  "end_time" TIMESTAMP DEFAULT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "status" SMALLINT DEFAULT 0,
  "operator" BIGINT NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "user_ban_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_user_ban_user_id" ON "user_ban" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_user_ban_status" ON "user_ban" ("status");
CREATE INDEX IF NOT EXISTS "idx_user_ban_created_at" ON "user_ban" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_user_ban_operator" ON "user_ban" ("operator");
COMMENT ON TABLE "user_ban" IS '用户封禁表';
COMMENT ON COLUMN "user_ban"."status" IS '状态：0=封禁中，1=管理员解封，2=自动解封，3=永久封禁，4=封禁撤销';

-- 插入默认管理员账户（密码: 123456 的 SHA256 哈希）
INSERT INTO "admin" ("username", "password")
VALUES ('admin', '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92')
ON CONFLICT ("username") DO NOTHING;

-- 验证结果
SELECT '数据库初始化完成！' AS message;
SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = 'public';
