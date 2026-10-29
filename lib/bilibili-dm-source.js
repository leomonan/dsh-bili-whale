/**
 * Bilibili DM inbox protocol adapter.
 * Parsing CLI exit codes and receipts belongs here; scheduler owns delivery retries and state.
 */
export function createBilibiliDmSource({ runCommand } = {}) {
  if (typeof runCommand !== 'function') throw new TypeError('runCommand is required')

  return {
    async pollOnce() {
      const result = await runCommand(['dm-await', '--once', '--json', '--peek'])
      const line = String(result.out ?? '').trim().split('\n').pop() ?? ''
      let payload = null
      try { payload = JSON.parse(line) } catch { payload = null }

      // Exit code 1 means a normal empty inbox; all other non-zero codes are failures.
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(String(result.err || '').trim() || '私信监听失败')
      }
      if (!payload || typeof payload.hit !== 'boolean') {
        throw new Error('私信监听返回无效结果')
      }
      if (payload.hit && !payload.receipt) {
        throw new Error('私信命中但没有回执，无法确认交付')
      }
      return payload
    },

    async ack(receipt) {
      if (typeof receipt !== 'string' || !receipt.trim()) throw new TypeError('receipt is required')
      return runCommand(['dm-await', '--ack', receipt])
    },
  }
}
