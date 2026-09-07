const app = getApp()
const util = require('../../utils/util.js')

Page({
  data: {
    loading: true,
    codeId: '',
    plate: '',
    logs: []
  },

  onLoad(options) {
    if (options.codeId) {
      this.setData({ codeId: options.codeId })
      this.loadLogs()
    } else {
      this.setData({ loading: false })
    }
  },

  async loadLogs() {
    this.setData({ loading: true })
    try {
      const res = await app.call('logs', { codeId: this.data.codeId })
      const logs = (res.logs || []).map((l) => ({
        ...l,
        timeText: util.formatTime(l.createTime)
      }))
      this.setData({
        logs,
        plate: res.plate || '',
        loading: false
      })
    } catch (err) {
      this.setData({ loading: false })
      util.toast(err.message || '加载失败')
    }
  }
})
