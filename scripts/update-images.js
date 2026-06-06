const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

async function updateImages() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'xiaoshiliu',
    port: process.env.DB_PORT || 3306,
  });

  // 9种宽高比，模拟瀑布流不同高度
  const ratios = [
    { w: 300, h: 400 },  // 3:4 竖长
    { w: 400, h: 400 },  // 1:1 方形
    { w: 400, h: 300 },  // 4:3 横宽
    { w: 320, h: 400 },  // 4:5 竖
    { w: 400, h: 320 },  // 5:4 横
    { w: 300, h: 450 },  // 2:3 竖长
    { w: 450, h: 300 },  // 3:2 横宽
    { w: 300, h: 360 },  // 5:6 竖
    { w: 360, h: 300 },  // 6:5 横
  ];

  const [posts] = await pool.query('SELECT id FROM posts ORDER BY id');
  console.log(`正在更新 ${posts.length} 篇笔记的图片...`);

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const ratio = ratios[i % ratios.length];
    const seed = 100 + i;
    
    // 每篇笔记1~5张图片
    const imgCount = 1 + (i % 5);
    
    // 删除旧图片
    await pool.query('DELETE FROM post_images WHERE post_id = ?', [post.id]);
    
    // 插入新图片
    for (let j = 0; j < imgCount; j++) {
      const imgSeed = seed + j * 1000;
      const imgUrl = `https://picsum.photos/seed/${imgSeed}/${ratio.w}/${ratio.h}`;
      await pool.query(
        'INSERT INTO post_images (post_id, image_url) VALUES (?, ?)',
        [post.id, imgUrl]
      );
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  已更新 ${i + 1}/${posts.length}`);
    }
  }

  console.log('完成！所有笔记图片已更新为 picsum.photos');
  await pool.end();
}

updateImages().catch(err => {
  console.error('失败:', err);
  process.exit(1);
});
