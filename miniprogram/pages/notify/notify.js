const app = getApp()
const config = require('../../config.js')
const util = require('../../utils/util.js')

const QUICK_MSGS = [
  '您的车挡住我了，麻烦挪一下',
  '您的车挡住了消防通道',
  '您的车没关灯 / 没关窗',
  '车辆疑似被剐蹭，请来看一下'
]

Page({
  data: {
    loading: true,
    errorMsg: '',
    // null = 还没查到；false = 空白码未绑定；true = 已绑定车辆
    bound: null,

    codeId: '',
    plateFull: '',
    plateMask: '',
    isNewEnergy: false,
    carModel: '',
    phone: '', // 仅用于 wx.makePhoneCall，不渲染到页面
    showPlainPhone: config.SHOW_PLAIN_PHONE,
    phoneMask: '',

    quickMsgs: QUICK_MSGS,
    message: '',

    notifying: false,
    countdown: 0, // 通知冷却倒计时（秒）
    notified: false,
    notifyResult: ''
  },

  onLoad(options) {
    // 解析入口参数
    // - 小程序码：options.scene
    // - 普通链接二维码：options.q（URL，需要从中取 codeId）
    // - 调试直传：options.codeId
    let codeId = options.codeId || ''

    if (!codeId && options.scene) {
      codeId = decodeURIComponent(options.scene)
    }
    if (!codeId && options.q) {
      const q = decodeURIComponent(options.q)
      const m = q.match(/[?&]codeId=([^&#]+)/) || q.match(/[?&]scene=([^&#]+)/)
      if (m) codeId = m[1]
    }

    if (!codeId) {
      this.setData({
        loading: false,
        errorMsg: '无法识别这个二维码，请确认贴纸是否完整、有无污损。'
      })
      return
    }

    this.setData({ codeId })
    this.loadCar()
  },

  async loadCar() {
    try {
      const car = await app.call('getByCode', { codeId: this.data.codeId })

      // 空白码：尚未绑定车辆，走绑定引导，不发通知也不显示号码
      if (car.bound === false) {
        this.setData({ loading: false, bound: false })
        return
      }

      const plateFull = car.plateFull || car.plateMask || ''
      // 车牌总长度 8 位为新能源（绿牌），7 位为普通（蓝牌）
      const isNewEnergy = String(plateFull).length === 8
      this.setData({
        loading: false,
        bound: true,
        plateFull,
        plateMask: car.plateMask,
        isNewEnergy,
        carModel: car.carModel || '',
        phone: car.phone || '',
        phoneMask: car.phoneMask || '',
        hasPhone: !!car.phone
      })
    } catch (err) {
      this.setData({
        loading: false,
        errorMsg: err.message || '这个挪车码暂时无法使用'
      })
    }
  },

  /** 空白码 → 去绑定车辆 */
  onBindTap() {
    wx.navigateTo({ url: `/pages/edit/edit?codeId=${this.data.codeId}&bind=1` })
  },

  /** 快捷留言 */
  onQuickMsg(e) {
    const { text } = e.currentTarget.dataset
    this.setData({ message: text })
  },

  onMessageInput(e) {
    this.setData({ message: e.detail.value })
  },

  /** 微信通知车主 */
  async onNotify() {
    if (this.data.notifying || this.data.countdown > 0) return

    this.setData({ notifying: true })
    wx.showLoading({ title: '正在通知…', mask: true })

    try {
      const res = await app.call('notify', {
        codeId: this.data.codeId,
        message: this.data.message
      })

      wx.hideLoading()
      this.setData({
        notifying: false,
        notified: true,
        notifyResult: res.delivered ? 'sent' : (res.reason || 'unknown')
      })

      if (res.delivered) {
        wx.showModal({
          title: '已通知车主',
          content: this.data.hasPhone
            ? '车主已收到微信通知，请稍等片刻。若情况紧急，可直接拨打电话。'
            : '车主已收到微信通知，请稍等片刻。',
          showCancel: false,
          confirmText: '好的'
        })
        this.startCountdown(config.NOTIFY_COOLDOWN_SEC)
      } else {
        // 未送达（未开启 / 额度用完 / 被停用）
        this.showNotifyFail(res.message || '车主暂未开启微信通知。')
      }
    } catch (err) {
      wx.hideLoading()
      this.setData({ notifying: false })
      const msg = err.message || '通知失败'
      if (String(err.code) === 'COOLDOWN') {
        wx.showToast({ title: msg, icon: 'none' })
        this.startCountdown(err.detail || config.NOTIFY_COOLDOWN_SEC)
      } else {
        wx.showModal({
          title: '通知失败',
          content: `${msg}\n你可以直接拨打车主电话。`,
          confirmText: '拨打电话',
          cancelText: '关闭',
          success: (r) => r.confirm && this.makeCall()
        })
      }
    }
  },

  /** 通知未送达时的友好提示（车主未开启 / 额度用完 / 被停用）
   *  注意：之前直接调用 this.showNotifyFail 但该方法未定义，导致崩溃。
   *        这里补上，未送达不再抛错，而是引导扫码方直接拨号。 */
  showNotifyFail(msg) {
    wx.showModal({
      title: '微信通知未送达',
      content: `${msg}\n你可以直接拨打车主电话。`,
      confirmText: '拨打电话',
      cancelText: '关闭',
      success: (r) => r.confirm && this.makeCall()
    })
  },

  /** 拨打电话 */
  makeCall() {
    const phone = this.data.phone
    if (!phone) {
      util.toast('车主未留电话')
      return
    }
    wx.makePhoneCall({
      phoneNumber: phone,
      fail: () => {
        /* 用户取消拨号，无需处理 */
      }
    })
  },

  onCallTap() {
    this.makeCall()
  },

  /** 复制号码（不想直接拨号时用，例如先发短信） */
  onCopyPhone() {
    const phone = this.data.phone
    if (!phone) {
      util.toast('车主未留电话')
      return
    }
    util.copy(phone).then(() => util.toast('号码已复制', 'success'))
  },

  /** 冷却倒计时 */
  startCountdown(sec) {
    this.clearTimer()
    this.setData({ countdown: sec })
    const tick = () => {
      const left = this.data.countdown - 1
      if (left <= 0) {
        this.setData({ countdown: 0 })
        this.clearTimer()
        return
      }
      this.setData({ countdown: left })
      this._timer = setTimeout(tick, 1000)
    }
    this._timer = setTimeout(tick, 1000)
  },

  clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  },

  onUnload() {
    this.clearTimer()
  },

  onHide() {
    this.clearTimer()
  },

  /** 扫码方是车主本人时的入口 */
  goHome() {
    wx.navigateTo({ url: '/pages/home/home' })
  }
})
