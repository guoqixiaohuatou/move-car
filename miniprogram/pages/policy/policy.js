/**
 * 隐私政策
 *
 * 这里写的每一个字段、每一个期限，都必须和代码实际行为一致 ——
 * 审核时审核员会逐条比对，声明了但做不到 = 虚假宣传，直接驳回。
 *
 * 对应关系：
 *   logRetentionDays    → 云函数 COL_LOGS 清理周期（需自行配置定时触发器）
 *   车牌/手机号/备注     → 云函数 save 写入 COL_CARS
 *   留言                → 云函数 notify 写入 COL_LOGS
 *   OpenID             → 云函数 getWXContext().OPENID
 */
Page({
  data: {
    // ★ 上线前改成你实际生效的日期
    effectiveDate: '2026-09-07',
    version: '1.0',
    // ★ 与你在云开发定时触发器里配置的清理周期保持一致；未配置定时清理就填「长期」
    logRetentionDays: 90
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: '隐私政策' })
  },

  onShareAppMessage() {
    return {
      title: '挪车助手隐私政策',
      path: '/pages/policy/policy'
    }
  }
})
