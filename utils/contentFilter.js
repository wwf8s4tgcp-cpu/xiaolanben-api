/**
 * 内容审核工具 - 敏感词过滤
 */
const { SensitiveWordTool } = require('sensitive-word-tool')

const filter = new SensitiveWordTool({ useDefaultWords: true })

/**
 * 检测文本是否包含敏感词
 * @param {string} text - 待检测文本
 * @returns {{ passed: boolean, words: string[] }} 审核结果
 */
function checkContent(text) {
  if (!text || typeof text !== 'string') return { passed: true, words: [] }
  const words = filter.match(text)
  return { passed: words.length === 0, words }
}

/**
 * 过滤敏感词（替换为*）
 * @param {string} text - 待过滤文本
 * @returns {string} 过滤后的文本
 */
function filterContent(text) {
  if (!text || typeof text !== 'string') return text || ''
  return filter.filter(text)
}

module.exports = { checkContent, filterContent }
