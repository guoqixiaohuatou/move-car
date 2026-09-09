const app = getApp()
const util = require('../../utils/util.js')
const config = require('../../config.js')

Page({
  data: {
    loading: true,
    cars: [],
    // null = 还没查过；true/false = 查询结果
    tplReady: null,
    tplHint: '',
    // 当前运行模式（只读展示；切换开关已拆到「管理后台」页）
    // 初值直接用配置兜底，避免「云端其实已是正式版、页面却先闪一下体验版」
    isRelease: config.RUN_MODE === 'release',
    // 运行模式来源诊断（db / doc-missing / db-invalid / read-failed / read-error）
    runModeSrc: '',
    // 当前用户是否为空白码管理员（决定是否显示「生成空白码」入口）
    isAdmin: false,
    // 系统里是否已有人认领管理员（认领后对所有人隐藏「认领」入口，防陌生人抢认）
    hasAdmin: false,
    myOpenid: ''
  },

  onLoad() {
    this.checkTemplate()
  },

  onShow() {
    this.loadCars()
    this.refreshSubscribeQuota()
    this.loadRunMode()
    this.loadProfile()
  },

  /** 读取当前用户身份（是否空白码管理员 + openid，供配置权限用） */
  async loadProfile() {
    try {
      const r = await app.call('getProfile', {})
      this.setData({
        isAdmin: !!r.isAdmin,
        hasAdmin: !!r.hasAdmin,
        myOpenid: r.openid || ''
      })
    } catch (err) {
      // 读取失败按非管理员处理，不影响其他功能
    }
  },

  /**
   * 复制我的 openid 已移入管理后台（首页不再展示真实 openid，避免误触泄露）。
   * 首页只保留「认领管理员」这一条通路 —— 系统还没有管理员时必须能在首页认领，
   * 否则新装后没有任何入口能进入管理后台。
   */
  async onClaimAdmin() {
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '认领管理员身份',
        content:
          '认领后，只有你的微信账号能生成空白挪车码并分发给他人绑定。\n\n' +
          '（提示：微信号 ≠ openid，本操作写入的是微信系统下发的真实 openid，无需你手动粘贴。）',
        confirmText: '认领',
        cancelText: '再想想',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirmed) return
    wx.showLoading({ title: '认领中…', mask: true })
    try {
      const res = await app.call('claimAdmin', {})
      wx.hideLoading()
      this.setData({
        isAdmin: !!res.isAdmin,
        hasAdmin: true,
        myOpenid: res.openid || this.data.myOpenid
      })
      util.toast('已认领 ✓ 现在可以生成空白挪车码了', 'success')
    } catch (err) {
      wx.hideLoading()
      util.toast(err.message || '认领失败')
    }
  },

  /** 读取当前运行模式，刷新开关状态 */
  async loadRunMode() {
    try {
      const r = await app.call('getRunMode', {})
      this.setData({ isRelease: !!r.isRelease, runModeSrc: r.source || '' })
    } catch (err) {
      // 读取失败：用前端配置的兜底值，不让开关莫名回弹成「体验版」
      // （曾出现过云端正常、前端读超时导致开关显示错的排查噩梦）
      this.setData({
        isRelease: config.RUN_MODE === 'release',
        runModeSrc: 'read-failed:' + ((err && err.message) || 'unknown')
      })
    }
  },

  /** 检查统一通知模板是否就绪 */
  async checkTemplate() {
    try {
      const info = await app.call('templateInfo', {})
      this.setData({
        tplReady: !!info.ready,
        tplHint: info.ready ? '' : info.hint || ''
      })
    } catch (err) {
      // 查不到就当未配置，不影响拨号功能
      this.setData({ tplReady: false })
    }
  },

  onTplWarnTap() {
    wx.showModal({
      title: '如何启用微信通知',
      content:
        '1. 打开 mp.weixin.qq.com → 功能 → 订阅消息\n' +
        '2. 公共模板库搜索「挪车」，选用任意一个\n' +
        '3. 回到小程序，重新进入本页即可自动识别\n\n' +
        '未启用也能正常使用，扫码方可以直接拨打电话联系你。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  onPullDownRefresh() {
    this.loadCars().then(() => wx.stopPullDownRefresh())
  },

  /** 加载我的车辆 */
  async loadCars() {
    this.setData({ loading: true })
    try {
      const list = await app.call('list', {})
      const cars = (list || []).map((c) => ({
        ...c,
        // bound === false = 空白码，还没绑定车辆（老数据没有该字段，视为已绑定）
        isBlank: c.bound === false,
        phoneMask: util.maskPhone(c.phone),
        createTimeText: util.formatTime(c.createTime, false),
        lastNotifyText: c.lastNotifyTime ? util.fromNow(c.lastNotifyTime) : '暂无'
      }))
      this.setData({ cars, loading: false })
    } catch (err) {
      this.setData({ loading: false })
      util.toast(err.message || '加载失败')
    }
  },

  /**
   * 补充订阅消息额度
   * 订阅消息是「一次性」的：车主授权 1 次 = 可推送 1 次。
   * 所以每次进入首页都尝试申请一次，车主勾选「总是保持以上选择」后
   * 后续进小程序会自动静默累积额度，我们把它累加存到服务端。
   */
  async refreshSubscribeQuota() {
    const quota = await app.requestNotifyQuota()
    // 车主同意了授权才需要刷新列表（额度有变化）
    if (quota !== null) {
      this.loadCars()
    }
  },

  /** 新增车辆 */
  goEdit() {
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  /**
   * 生成空白挪车码（弹出选张数）
   * ------------------------------------------------------------
   * 默认 1 张（单人用 / 自印自贴）。需要批量印贴纸时选 2~5 张一次性出。
   * 绑定规则统一是「先到先得」——谁先扫码填车牌，这张码就归谁。
   */
  /**
   * 点「＋ 空白挪车码」
   * ------------------------------------------------------------
   * 小程序码的版本（体验版 / 正式版）是烧死在图片里的，事后改不了：
   * 体验版码正式发布后路人扫不开，正式版码发布前扫不开。
   * 所以正式版还没发布（运行模式为 trial）时，先让管理员选用途，避免印错一批废纸。
   */
  onBlankTap() {
    if (!this.data.isRelease) {
      wx.showModal({
        title: '生成哪种挪车码？',
        content:
          '正式版：现在就能打印贴出，小程序正式发布后扫码即可绑定；发布前扫不开属正常现象。\n\n' +
          '体验版：现在就能扫码自测绑定流程，但正式发布后这张码会作废，需要重新打印。',
        cancelText: '体验版（自测）',
        confirmText: '正式版（打印）',
        success: (m) => {
          if (!m.confirm && !m.cancel) return
          this.pickBlankCount(m.confirm ? 'release' : 'trial')
        }
      })
      return
    }
    // 已是正式版运行模式，出的一律是正式版码
    this.pickBlankCount('release')
  },

  /** 选生成张数（1~5，与云函数 MAX_BLANK_BATCH 对齐） */
  pickBlankCount(envVersion) {
    wx.showActionSheet({
      itemList: ['1 张（默认）', '2 张', '3 张', '4 张', '5 张（最多）'],
      success: (res) => {
        const idx = res.tapIndex
        if (typeof idx !== 'number' || idx < 0) return
        this.generateBlanks(idx + 1, envVersion)
      },
      fail: () => {}
    })
  },

  /** 真正调用云函数批量生成 */
  async generateBlanks(count, envVersion) {
    wx.showLoading({ title: `生成 ${count} 张中…`, mask: true })
    try {
      const r = await app.call('createBlanks', { count, envVersion })
      wx.hideLoading()
      const items = r.items || []
      if (items.length === 0) {
        util.toast(r.message || '生成失败，请重试')
        return
      }
      // 跳到批量展示页：URL 长度有限（最多 5 张 * ~100B = 500B），
      // 用 encodeURIComponent 包裹 JSON 即可
      const itemsJson = encodeURIComponent(JSON.stringify(items))
      const env = envVersion || ''
      wx.navigateTo({ url: `/pages/blanks/blanks?items=${itemsJson}&env=${env}` })
    } catch (err) {
      wx.hideLoading()
      util.toast(err.message || '生成失败')
    }
  },

  /** 编辑车辆 */
  onEditTap(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({ url: `/pages/edit/edit?codeId=${id}` })
  },

  /** 绑定空白码（首页直接发起，与扫码绑定走同一个页面） */
  onBindTap(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({ url: `/pages/edit/edit?codeId=${id}&bind=1` })
  },

  /** 查看挪车码 */
  onCodeTap(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({ url: `/pages/code/code?codeId=${id}` })
  },

  /** 通知记录 */
  onLogsTap(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({ url: `/pages/logs/logs?codeId=${id}` })
  },

  /** 启用 / 停用 */
  async onToggleTap(e) {
    const { id, enabled } = e.currentTarget.dataset
    const next = !enabled
    try {
      await app.call('toggle', { codeId: id, enabled: next })
      util.toast(next ? '已启用通知' : '已暂停通知', 'success')
      this.loadCars()
    } catch (err) {
      util.toast(err.message || '操作失败')
    }
  },

  /** 删除 */
  onDeleteTap(e) {
    const { id, plate, blank } = e.currentTarget.dataset
    // 空白码还没有车牌，文案不能套用「XX 的挪车码」
    const name = blank ? '这张空白挪车码' : `${plate} 的挪车码`
    wx.showModal({
      title: '删除挪车码',
      content: `确定删除${name}吗？已打印的二维码将立即失效，此操作不可恢复。`,
      confirmColor: '#ff4d4f',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await app.call('remove', { codeId: id })
          util.toast('已删除', 'success')
          this.loadCars()
        } catch (err) {
          util.toast(err.message || '删除失败')
        }
      }
    })
  },

  /** 长复制链接（备用：手动生成二维码时用） */
  onCopyLink(e) {
    const { codeId } = e.currentTarget.dataset
    util.copy(codeId).then(() => util.toast('已复制码 ID', 'success'))
  },

  /** 进管理后台（仅管理员可见入口，云函数侧另有身份校验） */
  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' })
  },

  /** 隐私政策（审核要求：需在小程序内易于访问） */
  goPolicy() {
    wx.navigateTo({ url: '/pages/policy/policy' })
  }
})
