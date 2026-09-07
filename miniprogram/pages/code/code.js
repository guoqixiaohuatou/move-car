const app = getApp()
const config = require('../../config.js')
const util = require('../../utils/util.js')

Page({
  data: {
    codeId: '',
    plate: '',
    carModel: '',
    // 空白码：还没绑定车辆
    isBlank: false,
    qrUrl: '', // 云存储 fileID 或临时路径
    loading: true,
    // 统一通知模板是否就绪（null = 还没查过）
    tplReady: null,
    quota: 0,
    subscribing: false
  },

  onLoad(options) {
    if (!options.codeId) {
      util.toast('缺少码 ID')
      setTimeout(() => wx.navigateBack(), 1200)
      return
    }
    this.setData({ codeId: options.codeId })
    this.loadDetail()
    this.checkTemplate()
  },

  /** 模板未启用时不显示通知区块，避免车主点了没反应 */
  async checkTemplate() {
    const tmplId = config.TEMPLATE_ID || (await app.ensureTemplate())
    this.setData({ tplReady: !!tmplId })
  },

  async loadDetail() {
    this.setData({ loading: true })
    try {
      const detail = await app.call('detail', { codeId: this.data.codeId })
      // bound === false = 空白码，还没有车牌
      const isBlank = detail.bound === false
      this.setData({
        plate: detail.plate,
        carModel: detail.carModel || '',
        quota: detail.quota || 0,
        isBlank,
        loading: false
      })
      wx.setNavigationBarTitle({ title: detail.plate || '空白挪车码' })
      // 取小程序码（云函数里已缓存，重复调用不会重复生成）
      const qr = await app.call('getWxacode', { codeId: this.data.codeId })
      this.setData({ qrUrl: qr.fileID })
    } catch (err) {
      this.setData({ loading: false })
      util.toast(err.message || '加载失败')
    }
  },

  /** 订阅授权（累积通知额度） */
  async onSubscribe() {
    // config.js 填了就用填的，否则用云端自动发现的
    const tmplId = config.TEMPLATE_ID || (await app.ensureTemplate())

    if (!tmplId) {
      wx.showModal({
        title: '还没启用微信通知',
        content:
          '到 mp.weixin.qq.com → 功能 → 订阅消息 → 公共模板库，搜索「挪车」选用一个模板，再回来重试。\n\n拨号功能不受影响，别人扫码仍可直接打电话给你。',
        showCancel: false
      })
      return
    }

    this.setData({ subscribing: true })
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      complete: async (res) => {
        this.setData({ subscribing: false })
        const state = res[tmplId]

        if (state === 'accept') {
          try {
            const r = await app.call('addQuota', { codeId: this.data.codeId })
            this.setData({ quota: r.quota })
            util.toast(`开启成功，当前可通知 ${r.quota} 次`, 'success')
          } catch (err) {
            util.toast(err.message || '开启失败')
          }
        } else if (state === 'reject') {
          wx.showModal({
            title: '需要你的授权',
            content:
              '未勾选「请挪车提醒」，当有扫码请求时你就收不到微信通知了。建议重新点击并在弹窗中勾选。',
            confirmText: '重新授权',
            success: (r) => r.confirm && this.onSubscribe()
          })
        } else if (state === 'ban' || state === 'filter') {
          wx.showModal({
            title: '该模板不可用',
            content:
              '模板被微信封禁或过滤（ban / filter）。请到公众平台「订阅消息 - 我的模板」换一个模板；若手动填过 MANUAL.templateId，记得同步更新。',
            showCancel: false
          })
        } else {
          // 通常是开发者工具不支持，或 errMsg 类错误
          wx.showModal({
            title: '授权未完成',
            content: '请在真机上操作（开发者工具不支持订阅消息授权）。若已是真机，请确认公众平台已选用订阅消息模板。',
            showCancel: false
          })
        }
      }
    })
  },

  /** 保存小程序码到相册 */
  async onSave() {
    if (!this.data.qrUrl) return

    wx.showLoading({ title: '保存中…', mask: true })
    try {
      // 1. 云存储 fileID → 本地临时文件
      const dl = await wx.cloud.downloadFile({ fileID: this.data.qrUrl })
      const tempPath = dl.tempFilePath

      // 2. 写入相册（隐私协议开启时，内部会先拉起相册授权）
      await this.saveToAlbum(tempPath)

      wx.hideLoading()
      wx.showModal({
        title: '已保存到相册',
        content: '接下来：把这张图打印出来（建议 6~8cm 见方，用不干胶纸或塑封），贴在挡风玻璃左下角内侧即可。',
        showCancel: false,
        confirmText: '知道了'
      })
    } catch (err) {
      wx.hideLoading()
      const msg = String(err.errMsg || err.message || '')
      if (/auth|privacy|deny|authorize/i.test(msg)) {
        // 用户拒授权 / 隐私协议未含相册范围：引导重新授权
        wx.showModal({
          title: '需要相册授权',
          content:
            '保存图片需要授权「保存到相册」。请按提示同意后重试；\n\n' +
            '若仍失败，请到微信「我 - 设置 - 个人信息与权限 - 授权管理」中重置本小程序权限，' +
            '并确认开发者已在公众平台「隐私保护指引」中声明了「相册（保存到相册）」。',
          confirmText: '重新授权',
          cancelText: '取消',
          success: (r) => r.confirm && this.onSave()
        })
      } else {
        util.toast('保存失败，可尝试长按图片保存')
      }
    }
  },

  /**
   * 写入相册（兼容隐私协议）
   * ------------------------------------------------------------
   * __usePrivacyCheck__ 开启后，saveImageToPhotosAlbum 受隐私保护指引约束，
   * 旧版 wx.authorize('scope.writePhotosAlbum') 已失效、设置页也无此开关。
   * 正确做法：用 wx.requirePrivacyAuthorize 先拉起隐私授权，用户同意后再保存。
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
  },

  /** 预览大图 */
  onPreview() {
    if (!this.data.qrUrl) return
    wx.previewImage({ urls: [this.data.qrUrl], current: this.data.qrUrl })
  },

  onLogsTap() {
    wx.navigateTo({ url: `/pages/logs/logs?codeId=${this.data.codeId}` })
  },

  onEditTap() {
    // 空白码走绑定流程（edit 页据此跳过「拉详情」，因为该码还不归任何人）
    const suffix = this.data.isBlank ? '&bind=1' : ''
    wx.navigateTo({ url: `/pages/edit/edit?codeId=${this.data.codeId}${suffix}` })
  }
})
