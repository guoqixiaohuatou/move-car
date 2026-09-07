const config = require('./config.js')

App({
  globalData: {
    openid: '',
    // 云开发是否可用（初始化失败时降级提示，不至于白屏）
    cloudReady: false,

    // 由云端自动发现的订阅消息模板 ID
    // null = 还没去拉过；'' = 拉过但没找到可用模板
    templateId: null,
    templateTitle: '',
    _templatePromise: null
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '请升级微信到最新版本，或把开发者工具的「调试基础库」调到 2.2.3 以上。',
        showCancel: false
      })
      return
    }

    // 初始化云开发
    const initOptions = { traceUser: true }
    if (config.CLOUD_ENV) {
      initOptions.env = config.CLOUD_ENV
    }
    wx.cloud.init(initOptions)
    this.globalData.cloudReady = true

    // 提前拉取模板 ID，避免订阅授权时还没拿到
    this.ensureTemplate()

    // 注册隐私保护授权处理（app.json 里 __usePrivacyCheck__: true）
    this.initPrivacy()
  },

  /* ============================================================
   * 隐私保护指引授权
   * ------------------------------------------------------------
   * app.json 开启 __usePrivacyCheck__ 后，调用相册类隐私接口
   * （保存挪车码 saveImageToPhotosAlbum）
   * 会被微信拦截并回调 onNeedPrivacyAuthorization。
   *
   * 不注册这个监听 = 真机上这两个功能直接失败，且不会有任何报错提示。
   *
   * 前提：必须在 mp 后台「设置 - 服务内容声明 - 用户隐私保护指引」
   * 填写并发布，否则这里弹了也没用，接口仍会被拦。
   * ============================================================ */
  initPrivacy() {
    if (!wx.onNeedPrivacyAuthorization) return

    wx.onNeedPrivacyAuthorization((resolve) => {
      wx.showModal({
        title: '用户隐私保护提示',
        content:
          '使用前请先阅读并同意《用户隐私保护指引》。\n\n' +
          '我们仅收集：车牌号（必填）、手机号（选填）。' +
          '用途只有一个——他人需要挪车时联系到你。不做广告、不共享给第三方。',
        confirmText: '同意',
        cancelText: '查看政策',
        success: (res) => {
          if (res.confirm) {
            // buttonId 可自定义，用于微信侧统计；event 必须是 'agree' / 'disagree'
            resolve({ buttonId: 'agree-btn', event: 'agree' })
          } else {
            resolve({ event: 'disagree' })
            wx.navigateTo({ url: '/pages/policy/policy' })
          }
        },
        fail: () => resolve({ event: 'disagree' })
      })
    })
  },

  /* ============================================================
   * 模板发现
   * ------------------------------------------------------------
   * 订阅消息模板 ID 不需要手填：云端会读取账号下选用过的模板，
   * 优先挑标题含「挪车 / 移车」的那一个。这里把它取回来供授权使用。
   * ============================================================ */
  ensureTemplate() {
    const g = this.globalData
    if (g.templateId !== null) return Promise.resolve(g.templateId)
    if (g._templatePromise) return g._templatePromise

    g._templatePromise = this.call('templateInfo', {})
      .then((r) => {
        g.templateId = (r && r.templateId) || ''
        g.templateTitle = (r && r.title) || ''
        return g.templateId
      })
      .catch(() => {
        g.templateId = ''
        return ''
      })

    return g._templatePromise
  },

  /**
   * 补充一次微信通知额度
   * ------------------------------------------------------------
   * 订阅消息是「一次性」的：车主同意 1 次 = 可推送 1 次，不是长期订阅。
   * 所以每次进小程序都尝试申请一次，同意后由服务端累加额度。
   * 车主在弹窗里勾选「总是保持以上选择」后，后续进入会静默累积，不用反复点。
   *
   * @param {object} opts
   * @param {boolean} opts.force 是否强制弹授权（默认静默，仅在同意时才累加）
   * @returns {Promise<number|null>} 当前剩余额度；未授权/无模板返回 null
   */
  async requestNotifyQuota(opts = {}) {
    if (!wx.requestSubscribeMessage) return null

    // config.js 里填了就用填的，否则用云端自动发现的
    let tmplId = config.TEMPLATE_ID
    if (!tmplId) {
      tmplId = await this.ensureTemplate()
    }
    if (!tmplId) return null

    return new Promise((resolve) => {
      wx.requestSubscribeMessage({
        tmplIds: [tmplId],
        complete: (res) => {
          const state = res[tmplId]
          // accept: 同意  reject: 拒绝  ban: 被封禁  filter: 模板被过滤
          // 非 accept 直接放弃本轮累积，不打扰用户
          if (state !== 'accept') {
            resolve(null)
            return
          }
          this.call('addQuota', {})
            .then((r) => resolve(r && r.quota != null ? r.quota : null))
            .catch(() => resolve(null))
        }
      })
    })
  },

  /**
   * 统一的云函数调用封装
   * @param {string} action 云函数路由名
   * @param {object} payload 业务参数
   * @returns {Promise<object>} 云函数返回的 data 部分
   */
  call(action, payload = {}) {
    return wx.cloud
      .callFunction({
        name: config.CLOUD_FUNC,
        data: { action, payload }
      })
      .then((res) => {
        const data = res && res.result
        if (!data) {
          throw new Error('云函数无返回')
        }
        if (data.code !== 0) {
          const err = new Error(data.message || '请求失败')
          err.code = data.code
          err.detail = data.detail
          throw err
        }
        return data.data
      })
  }
})
