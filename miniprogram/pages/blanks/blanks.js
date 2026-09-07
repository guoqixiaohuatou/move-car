const app = getApp()
const util = require('../../utils/util.js')

/** 出码版本 → 给管理员的提示文案（版本烧死在图片里，印错就是一批废纸） */
function envTipOf(env) {
  if (env === 'release') {
    return '正式版码：现在就可以打印贴出。小程序正式发布后扫码即可绑定车辆；发布前扫不开属正常现象。'
  }
  if (env === 'trial') {
    return '体验版码：仅供现在自测绑定流程。小程序正式发布后这批码会作废，届时需重新生成并打印。'
  }
  return ''
}

Page({
  data: {
    items: [], // [{ codeId, fileID }]
    savingAll: false,
    savedCount: 0 // 已保存张数（用于「全部保存」进度反馈）
  },

  onLoad(options) {
    let items = []
    try {
      // items 通过 JSON 编码后 URL 传过来；长度有限（最多 5 张 + fileID，每张约 100B，完全够用）
      items = JSON.parse(decodeURIComponent(options.items || '[]'))
    } catch (e) {
      items = []
    }
    if (!Array.isArray(items) || items.length === 0) {
      util.toast('没有可展示的空白码')
      setTimeout(() => wx.navigateBack(), 1200)
      return
    }
    // 标注序号，方便分发时知道哪张是哪张
    items = items.map((it, idx) => ({ ...it, index: idx + 1 }))

    // 出码版本：决定这批贴纸是「现在就能印」还是「只能自测」
    const env = options.env || (items[0] && items[0].env) || ''
    this.setData({ items, env, envKind: env, envTip: envTipOf(env) })
  },

  /**
   * 点开某张码 → 全屏预览（长按图片可识别 / 保存）
   * 这是分发时的主要路径：分发人一张一张点开，发给亲友扫
   */
  onPreview(e) {
    const { idx } = e.currentTarget.dataset
    const item = this.data.items[idx]
    if (!item || !item.fileID) {
      util.toast('这张码还没生成图片，请稍后重试')
      return
    }
    wx.previewImage({
      urls: [item.fileID],
      current: item.fileID
    })
  },

  /** 复制单张的码 ID（方便自己留底） */
  onCopy(e) {
    const { id } = e.currentTarget.dataset
    util.copy(id).then(() => util.toast('已复制码 ID', 'success'))
  },

  /**
   * 一张张保存到相册（依次处理，避免触发系统并发限制）
   * 用现有的 requirePrivacyAuthorize 流程，失败的那张跳过、不中断后续
   */
  async onSaveAll() {
    if (this.data.savingAll) return
    const items = this.data.items.filter((it) => !!it.fileID)
    if (items.length === 0) {
      util.toast('暂无可保存的图片')
      return
    }

    this.setData({ savingAll: true, savedCount: 0 })
    wx.showLoading({ title: '保存 0/' + items.length, mask: true })

    let ok = 0
    let fail = 0
    for (let i = 0; i < items.length; i++) {
      try {
        const dl = await wx.cloud.downloadFile({ fileID: items[i].fileID })
        await this.saveToAlbum(dl.tempFilePath)
        ok++
      } catch (e) {
        fail++
      }
      this.setData({ savedCount: ok + fail })
      wx.showLoading({ title: `已保存 ${ok}/${items.length}`, mask: true })
    }

    wx.hideLoading()
    this.setData({ savingAll: false })

    const tip =
      fail === 0
        ? `已全部保存 ${ok} 张到相册，可直接打印或转发`
        : `保存完成：${ok} 张成功，${fail} 张失败（可能被隐私授权拦截）`
    wx.showModal({
      title: fail === 0 ? '已保存到相册' : '部分保存失败',
      content: tip,
      showCancel: fail === 0,
      confirmText: '知道了'
    })
  },

  /**
   * 写入相册（兼容隐私协议）
   * 与 code.js 同款逻辑；这里内联一份避免跨页 require 的复杂度
   */
  saveToAlbum(filePath) {
    const doSave = () =>
      new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({ filePath, success: resolve, fail: reject })
      })
    if (wx.requirePrivacyAuthorize) {
      return new Promise((resolve, reject) => {
        wx.requirePrivacyAuthorize({
          success: () => doSave().then(resolve, reject),
          fail: reject
        })
      })
    }
    return doSave()
  }
})