const app = getApp()
const util = require('../../utils/util.js')

Page({
  data: {
    loading: true,
    cars: [],
    // null = 还没查过；true/false = 查询结果
    tplReady: null,
    tplHint: '',
    // 运行模式开关状态（trial / release）
    isRelease: false,
    runModeLoading: false,
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
   * 复制我的 openid（配置空白码权限用）
   * 注意：手机剪贴板无法直接粘贴到电脑（微信不会跨设备同步剪贴板），
   * 所以复制后要把 openid 原样弹出来，方便在电脑上照着手动输入。
   */
  onCopyOpenid() {
    const id = this.data.myOpenid
    if (!id) {
      wx.showModal({
        title: 'openid 为空',
        content: '没能读到你的 openid。请下拉刷新首页后重试；仍不行可到云开发控制台 → 云端测试执行 {"action":"getProfile"} 查看。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    util.copy(id).then((succ) => {
      wx.showModal({
        title: succ ? '已复制到手机剪贴板' : '复制失败',
        content:
          `${id}\n\n` +
          '⚠️ 手机复制的内容只能在手机上粘贴，无法直接粘到电脑。\n' +
          '要在电脑端配置，请照着上面这串手动输入。',
        confirmText: succ ? '知道了' : '长按上方文字复制',
        showCancel: false
      })
    })
  },

  /** 认领管理员身份（自助配置空白码权限，无需去控制台粘 openid） */
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
      this.setData({ isRelease: !!r.isRelease })
    } catch (err) {
      // 读取失败不打扰用户，默认按 trial 显示
    }
  },

  /**
   * 运行模式开关：体验版 ↔ 正式版
   * switch 的视觉会先变，这里根据目标值弹确认框；取消则回弹。
   */
  onRunModeChange(e) {
    const nextRelease = !!e.detail.value
    const next = nextRelease ? 'release' : 'trial'

    const confirm = nextRelease
      ? {
          title: '切换到正式版？',
          content:
            '正式版下，任何微信用户都能扫开你的挪车码。\n\n' +
            '请先确认小程序已完成 ICP 备案并正式发布 —— 否则路人仍扫不开（体验成员不受影响）。',
          confirmText: '切到正式版'
        }
      : {
          title: '切回体验版？',
          content: '体验版仅「体验成员」能扫开挪车码，路人扫不开。适合调试阶段使用。',
          confirmText: '切回体验版'
        }

    wx.showModal({
      title: confirm.title,
      content: confirm.content,
      confirmText: confirm.confirmText,
      cancelText: '再想想',
      success: (res) => {
        if (res.confirm) {
          this.applyRunMode(next)
        } else {
          // 取消 → 回弹开关
          this.setData({ isRelease: !nextRelease })
        }
      }
    })
  },

  /** 真正调用云函数切换运行模式 */
  async applyRunMode(mode) {
    this.setData({ runModeLoading: true })
    wx.showLoading({ title: '切换中…', mask: true })
    try {
      const r = await app.call('setRunMode', { runMode: mode })
      this.setData({ isRelease: !!r.isRelease })
      wx.hideLoading()
      util.toast(r.hint || (r.isRelease ? '已切到正式版' : '已切回体验版'), 'success')
      // 旧码指向旧版本，必须重新生成才生效
      wx.showModal({
        title: '记得重新生成挪车码',
        content:
          '运行模式已切换，但旧的挪车码仍指向旧版本。请到「查看挪车码」页删除并重新生成，' +
          '路人才/体验成员才能扫开新码。',
        showCancel: false,
        confirmText: '知道了'
      })
    } catch (err) {
      wx.hideLoading()
      this.setData({ isRelease: mode !== 'release' })
      util.toast(err.message || '切换失败')
    } finally {
      this.setData({ runModeLoading: false })
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
  onBlankTap() {
    wx.showActionSheet({
      itemList: ['1 张（默认）', '2 张', '3 张', '4 张', '5 张（最多）'],
      success: (res) => {
        const idx = res.tapIndex
        if (typeof idx !== 'number' || idx < 0) return
        this.generateBlanks(idx + 1)
      },
      fail: () => {}
    })
  },

  /** 真正调用云函数批量生成 */
  async generateBlanks(count) {
    wx.showLoading({ title: `生成 ${count} 张中…`, mask: true })
    try {
      const r = await app.call('createBlanks', { count })
      wx.hideLoading()
      const items = r.items || []
      if (items.length === 0) {
        util.toast(r.message || '生成失败，请重试')
        return
      }
      // 跳到批量展示页：URL 长度有限（最多 5 张 * ~100B = 500B），
      // 用 encodeURIComponent 包裹 JSON 即可
      const itemsJson = encodeURIComponent(JSON.stringify(items))
      wx.navigateTo({ url: `/pages/blanks/blanks?items=${itemsJson}` })
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

  /** 隐私政策（审核要求：需在小程序内易于访问） */
  goPolicy() {
    wx.navigateTo({ url: '/pages/policy/policy' })
  }
})
