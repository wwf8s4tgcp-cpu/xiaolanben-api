/**
 * 通用数据库操作工具（PostgreSQL 版）
 * 适配 Supabase PostgreSQL
 */
const { pool } = require('../config/config');

/**
 * 展开数组参数，将 ? 替换为 $1,$2,... 并展开参数数组
 * 处理 mysql2 兼容的 IN (?) 语法
 */
function expandArrayParams(sql, params = []) {
  let text = sql;
  const values = [];
  let paramIndex = 0;

  // 逐字符扫描，找到 ? 占位符
  let i = 0;
  while (i < text.length) {
    const qIndex = text.indexOf('?', i);
    if (qIndex === -1) break;

    const currentParam = params[paramIndex];

    // 检查这个 ? 是否在 IN () 中（简单启发式：前面有 IN ( 且后面有 )）
    const beforeQ = text.slice(Math.max(0, qIndex - 10), qIndex).toUpperCase();
    const afterQ = text.slice(qIndex + 1, qIndex + 2);

    if (Array.isArray(currentParam) && (beforeQ.includes('IN(') || beforeQ.includes('IN (')) && afterQ === ')') {
      // 展开数组
      const expanded = currentParam.map((_, idx) => `$${values.length + idx + 1}`);
      text = text.slice(0, qIndex) + expanded.join(',') + text.slice(qIndex + 1);
      values.push(...currentParam);
    } else {
      // 普通参数
      text = text.slice(0, qIndex) + `$${values.length + 1}` + text.slice(qIndex + 1);
      values.push(currentParam);
    }

    paramIndex++;
    i = qIndex + 1;
  }

  return { text, values };
}

/**
 * 执行 SQL 查询
 * 兼容 mysql2 风格的 ? 占位符和 pg 原生的 $N 格式
 * 自动处理数组参数展开（如 IN (?) 中的数组）
 *
 * @param {string} sql - SQL 语句
 * @param {Array} params - 参数数组
 * @returns {Promise<{rows: Array, rowCount: number}>}
 */
async function execute(sql, params = []) {
  // 已经有 $N 占位符的直接用
  if (/\$\d+/.test(sql)) {
    return pool.query(sql, params);
  }

  // 转换 ? 占位符，展开数组参数
  const { text, values } = expandArrayParams(sql, params);
  return pool.query(text, values);
}

/**
 * 将 MySQL 的 ? 占位符转换为 PostgreSQL 的 $1, $2... 格式
 * @deprecated 使用 execute 替代
 */
function convertPlaceholders(sql, values = []) {
  let index = 0;
  const text = sql.replace(/\?/g, () => `$${++index}`);
  return { text, values };
}

/**
 * 检查记录是否存在
 * @param {string} table - 表名
 * @param {string} field - 字段名
 * @param {*} value - 字段值
 * @returns {Promise<boolean>} 是否存在
 */
async function recordExists(table, field, value) {
  const result = await execute(
    `SELECT 1 FROM "${table}" WHERE "${field}" = $1 LIMIT 1`,
    [value]
  );
  return result.rows.length > 0;
}

/**
 * 检查多个记录是否存在
 * @param {string} table - 表名
 * @param {string} field - 字段名
 * @param {Array} values - 字段值数组
 * @returns {Promise<Object>} {existingCount: number, missingValues: Array}
 */
async function recordsExist(table, field, values) {
  if (!values || values.length === 0) {
    return { existingCount: 0, missingValues: [] };
  }

  const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
  const result = await execute(
    `SELECT "${field}" FROM "${table}" WHERE "${field}" IN (${placeholders})`,
    values
  );

  const existingValues = result.rows.map(row => row[field]);
  const missingValues = values.filter(value => !existingValues.includes(value));

  return {
    existingCount: existingValues.length,
    missingValues
  };
}

/**
 * 检查唯一性约束
 * @param {string} table - 表名
 * @param {string} field - 字段名
 * @param {*} value - 字段值
 * @param {number} excludeId - 排除的ID（用于更新操作）
 * @returns {Promise<boolean>} 是否唯一
 */
async function isUnique(table, field, value, excludeId = null) {
  let query = `SELECT 1 FROM "${table}" WHERE "${field}" = $1`;
  const params = [value];

  if (excludeId) {
    query += ' AND "id" != $2';
    params.push(excludeId);
  }

  const result = await execute(query, params);
  return result.rows.length === 0;
}

/**
 * 创建记录
 * @param {string} table - 表名
 * @param {Object} data - 数据对象
 * @returns {Promise<number>} 插入的ID
 */
async function createRecord(table, data) {
  const fields = Object.keys(data);
  const values = Object.values(data);
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(',');
  const quotedFields = fields.map(f => `"${f}"`).join(',');

  const result = await execute(
    `INSERT INTO "${table}" (${quotedFields}) VALUES (${placeholders}) RETURNING "id"`,
    values
  );

  return result.rows[0].id;
}

/**
 * 更新记录
 * @param {string} table - 表名
 * @param {number} id - 记录ID
 * @param {Object} data - 更新数据
 * @returns {Promise<number>} 影响的行数
 */
async function updateRecord(table, id, data) {
  const fields = Object.keys(data);
  const values = Object.values(data);
  const setClause = fields.map((f, i) => `"${f}" = $${i + 1}`).join(', ');

  const result = await execute(
    `UPDATE "${table}" SET ${setClause} WHERE "id" = $${fields.length + 1}`,
    [...values, id]
  );

  return result.rowCount;
}

/**
 * 删除记录
 * @param {string} table - 表名
 * @param {number} id - 记录ID
 * @returns {Promise<number>} 影响的行数
 */
async function deleteRecord(table, id) {
  const result = await execute(`DELETE FROM "${table}" WHERE "id" = $1`, [id]);
  return result.rowCount;
}

/**
 * 批量删除记录
 * @param {string} table - 表名
 * @param {Array} ids - ID数组
 * @returns {Promise<number>} 影响的行数
 */
async function deleteRecords(table, ids) {
  if (!ids || ids.length === 0) {
    return 0;
  }

  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const result = await execute(
    `DELETE FROM "${table}" WHERE "id" IN (${placeholders})`,
    ids
  );

  return result.rowCount;
}

/**
 * 获取记录详情
 * @param {string} table - 表名
 * @param {number} id - 记录ID
 * @param {string} fields - 要查询的字段，默认为*
 * @returns {Promise<Object|null>} 记录对象或null
 */
async function getRecord(table, id, fields = '*') {
  const result = await execute(
    `SELECT ${fields} FROM "${table}" WHERE "id" = $1 LIMIT 1`,
    [id]
  );

  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * 获取分页记录列表
 * @param {string} table - 表名
 * @param {Object} options - 查询选项
 * @param {number} options.page - 页码
 * @param {number} options.limit - 每页数量
 * @param {string} options.where - WHERE条件
 * @param {Array} options.params - 查询参数
 * @param {string} options.orderBy - 排序字段
 * @param {string} options.fields - 查询字段
 * @returns {Promise<Object>} {data: Array, total: number, page: number, limit: number}
 */
async function getRecords(table, options = {}) {
  const {
    page = 1,
    limit = 20,
    where = '',
    params = [],
    orderBy = '"created_at" DESC',
    fields = '*'
  } = options;

  const offset = (page - 1) * limit;

  // 构建查询条件
  const whereClause = where ? `WHERE ${where}` : '';

  // 获取总数
  const countResult = await execute(
    `SELECT COUNT(*) as total FROM "${table}" ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  // 获取数据 - 注意：LIMIT/OFFSET 的参数在 params 之后
  const allParams = [...params, limit, offset];
  const dataResult = await execute(
    `SELECT ${fields} FROM "${table}" ${whereClause} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    allParams
  );

  return {
    data: dataResult.rows,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}

/**
 * 执行级联删除
 * @param {Array} cascadeRules - 级联删除规则数组
 * @param {number|Array} targetIds - 目标ID或ID数组
 * @returns {Promise<void>}
 */
async function cascadeDelete(cascadeRules, targetIds) {
  const ids = Array.isArray(targetIds) ? targetIds : [targetIds];

  for (const rule of cascadeRules) {
    const { table, field } = rule;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');

    await execute(
      `DELETE FROM "${table}" WHERE "${field}" IN (${placeholders})`,
      ids
    );
  }
}

/**
 * 将 mysql2 风格的行查询结果转换为 pg 风格
 * mysql2: [rows, fields] = await pool.execute(...)
 * pg:     result = await pool.query(...) → result.rows
 */
function rows(result) {
  return result.rows;
}

/**
 * 获取单个行（去掉数组包装）
 */
function row(result) {
  return result.rows[0] || null;
}

module.exports = {
  execute,
  convertPlaceholders,
  expandArrayParams,
  recordExists,
  recordsExist,
  isUnique,
  createRecord,
  updateRecord,
  deleteRecord,
  deleteRecords,
  getRecord,
  getRecords,
  cascadeDelete,
  rows,
  row
};
