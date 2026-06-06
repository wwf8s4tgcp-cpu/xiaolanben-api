const { Pool } = require('pg');
const crypto = require('crypto');

async function createUser() {
  const pool = new Pool({
    host: 'db.jilfvyspdgasvpzvntyc.supabase.co',
    user: 'postgres',
    password: process.env.BD_PWD || '3ab@,VCy*zALsGk',
    database: 'postgres',
    port: 5432,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const hash = crypto.createHash('sha256').update('123456').digest('hex');
    
    let r = await pool.query("DELETE FROM users WHERE user_id = 'xcdklxg'");
    console.log('Deleted old user, rows:', r.rowCount);

    r = await pool.query("INSERT INTO users (user_id, nickname, password, email, avatar, bio, location) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      ['xcdklxg', 'test', hash, '', '', '', '']);
    console.log('Created user, id:', r.rows[0].id);
    
    r = await pool.query("SELECT id, user_id, is_active FROM users WHERE user_id = $1 AND password = $2", 
      ['xcdklxg', hash]);
    console.log('Login check:', r.rows.length > 0 ? 'PASS' : 'FAIL');
  } catch(e) {
    console.log('Error:', e.message);
  }
  pool.end();
}
createUser();
