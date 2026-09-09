const app = getApp()
const util = require('../../utils/util.js')
const config = require('../../config.js')

/** 筛选标签：与云函数 adminList 的 filter 取值一一对应 */
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'bound', label: '已绑定' },
  { key: 'blank', label: '空白码' },
  { key: 'disabled', label: '已停用' }
]

const PAGE_SIZE = 20

Page({
  data: {
    // 身份校验中 / 非管理员 → 先挡一层，避免闪一下后台内容
    checking: true,
    isAdmin: false,
    myOpenid: '',

    // 总览
    stats: null,

    // 列表
    filters: FILTERS,
    filter: 'all',
    keyword: '',
    list: [],
    page: 1,
    total: 0,
    hasMore: false,
    loading: false,
    loadingMore: false,
    expectEnv: '',

    // 展开详情的码（一次只展开一张，避免页面过长）
    expandedId: '',
    detail: null,
    revealingPhone: false,

    // 运行模式（从首页拆过来的全局开关）
    isRelease: config.RUN_MODE === 'release',
    runModeLoading: false,
    runModeSrc: ''
  },

  onLoad() {
    this.checkAdmin()
  },

  onShow() {
    // 从其他页返回（比如刚生成完空白码）时刷新；首次由 checkAdmin 触发
    if (this.data.isAdmin) this.refresh({ silent: true })
  },

  onPullDownRefresh() {
    if (!this.data.isAdmin) {
      wx.stopPullDownRefresh()
      return
    }
    this.refresh().then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.loadMore()
  },

  /* ==========================================================
   * 身份
   * ========================================================== */

  /** 非管理员直接挡掉 —— 云函数侧也有校验，这里只是体验层 */
  async checkAdmin() {
    try {
      const r = await app.call('getProfile', {})
      const isAdmin = !!r.isAdmin
      this.setData({ isAdmin, myOpenid: r.openid || '', checking: false })
      if (!isAdmin) {
        wx.showModal({
          title: '无权访问',
          content: '管理后台仅对管理员开放。若你是本小程序的管理员，请先到首页认领管理员身份。',
          showCancel: false,
          confirmText: '返回',
          success: () => wx.navigateBack()
        })
        return
      }
      this.refresh()
    } catch (err) {
      this.setData({ checking: false })
      util.toast(err.message || '身份验证失败')
      setTimeout(() => wx.navigateBack(), 1500)
    }
  },

  /* ==========================================================
   * 数据
   * ========================================================== */

  /** 刷新统计 + 列表（reset = 回到第一页） */
  async refresh(options) {
    const opts = options || {}
    if (!opts.silent) this.setData({ loading: true })
    this.setData({ page: 1, expandedId: '', detail: null, revealingPhone: false })
    try {
      await Promise.all([this.loadStats(), this.loadList(1), this.loadRunMode()])
    } finally {
      this.setData({ loading: false })
    }
  },

  async loadStats() {
    try {
      const s = await app.call('adminStats', {})
      this.setData({ stats: s })
    } catch (err) {
      // 统计失败不阻塞列表
    }
  },

  async loadList(page) {
    const { filter, keyword } = this.data
    const res = await app.call('adminList', {
      filter,
      keyword,
      page,
      pageSize: PAGE_SIZE
    })
    const expectEnv = res.expectEnv || ''
    const items = (res.items || []).map((it) => this.decorate(it, expectEnv))
    this.setData({
      // 先记 expectEnv 再渲染列表：派生字段（版本是否匹配）依赖它
      expectEnv,
      list: items,
      total: res.total || 0,
      page,
      hasMore: !!res.hasMore
    })
    return res
  },

  /** 加前端展示用的派生字段 */
  decorate(it, expectEnv) {
    const env = expectEnv || this.data.expectEnv
    // 码图版本与当前运行模式不一致 → 这张码扫不开，必须在列表里一眼可见
    const envMismatch = !!it.wxacodeEnv && !!env && it.wxacodeEnv !== env
    return {
      ...it,
      title: it.plate || '空白挪车码',
      plateText: it.plate || '',
      phoneText: it.phoneMask || '未填手机号',
      ownerText: it.ownerOpenidMask || '未绑定',
      createText: util.formatTime(it.createTime, false),
      lastText: it.lastNotifyTime ? util.fromNow(it.lastNotifyTime) : '暂无',
      envText: it.wxacodeEnv ? (it.wxacodeEnv === 'release' ? '正式版' : '体验版') : '未出图',
      // 码图版本与当前运行模式不一致 → 这张码扫不开，重点标红
      envMismatch,
      // 空白码没有出过图也是异常
      noImage: !it.hasImage
    }
  },

  async loadMore() {
    this.setData({ loadingMore: true })
    try {
      const next = this.data.page + 1
      const res = await app.call('adminList', {
        filter: this.data.filter,
        keyword: this.data.keyword,
        page: next,
        pageSize: PAGE_SIZE
      })
      const more = (res.items || []).map((it) => this.decorate(it, res.expectEnv || this.data.expectEnv))
      this.setData({
        list: this.data.list.concat(more),
        page: next,
        hasMore: !!res.hasMore
      })
    } catch (err) {
      util.toast(err.message || '加载失败')
    } finally {
      this.setData({ loadingMore: false })
    }
  },

  /** 重算所有派生字段（筛选/搜索切换后） */
  resync() {
    this.setData({
      list: this.data.list.map((it) => this.decorate(it))
    })
  },

  /* ==========================================================
   * 搜索 / 筛选
   * ========================================================== */

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  onSearch() {
    this.refresh()
  },

  onClearKeyword() {
    this.setData({ keyword: '' })
    this.refresh()
  },

  onFilterTap(e) {
    const { key } = e.currentTarget.dataset
    if (key === this.data.filter) return
    this.setData({ filter: key })
    this.refresh()
  },

  /* ==========================================================
   * 单张码：展开 / 详情 / 操作
   * ========================================================== */

  async onCardTap(e) {
    const { id } = e.currentTarget.dataset
    if (this.data.expandedId === id) {
      this.setData({ expandedId: '', detail: null, revealingPhone: false })
      return
    }
    this.setData({ expandedId: id, detail: null, revealingPhone: false })
    // 详情里有完整手机号和诊断，按需加载
    try {
      const d = await app.call('adminDetail', { codeId: id })
      if (this.data.expandedId !== id) return // 期间又切了别的卡
      this.setData({
        detail: {
          phone: d.phone || '',
          phoneText: d.phone ? util.maskPhone(d.phone) : '未填手机号',
          ownerOpenid: d.ownerOpenid || '',
          carModel: d.carModel || '',
          quota: d.quota || 0,
          verdict: d.verdict || '',
          envMatch: !!d.envMatch,
          fileID: d.wxacodeFileID || '',
          updateText: util.formatTime(d.updateTime, true)
        }
      })
    } catch (err) {
      util.toast(err.message || '加载详情失败')
    }
  },

  /** 完整手机号默认打码，点一下才显示（避免后台一屏全是真实号码） */
  onRevealPhone() {
    const d = this.data.detail
    if (!d) return
    this.setData({
      revealingPhone: true,
      detail: { ...d, phoneText: d.phone || '未填' }
    })
  },

  onCopyCodeId(e) {
    const { id } = e.currentTarget.dataset
    util.copy(id).then((ok) => util.toast(ok ? '已复制码 ID' : '复制失败', ok ? 'success' : 'none'))
  },

  onCopyOpenid() {
    const id = this.data.myOpenid
    if (!id) {
      util.toast('没有读到 openid')
      return
    }
    util.copy(id).then(() => {
      wx.showModal({
        title: '我的 openid',
        content: id + '\n\n已复制到剪贴板（手机复制只能在手机粘贴，无法粘到电脑）。',
        showCancel: false,
        confirmText: '知道了'
      })
    })
  },

  /**
   * 改车牌（showModal 的 editable 输入框，避免为此再做一个表单页）
   * ⚠️ 给空白码填车牌时，云函数会把归属挂到管理员名下并回传 ownerSet:'admin'
   * —— 否则这张码会变成谁的首页都看不到的「无主码」。
   */
  onEditPlate(e) {
    const { id, plate } = e.currentTarget.dataset
    wx.showModal({
      title: '修改车牌',
      placeholderText: '例如 京A12345',
      editable: true,
      confirmText: '保存',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        const v = String(r.content || '').trim()
        if (!v) {
          util.toast('车牌不能为空')
          return
        }
        wx.showLoading({ title: '保存中…', mask: true })
        try {
          const res = await app.call('adminUpdate', { codeId: id, plate: v })
          wx.hideLoading()
          util.toast(res.ownerSet === 'admin' ? '已保存，该码已挂到你名下' : '已保存', 'success')
          this.refresh({ silent: true })
        } catch (err) {
          wx.hideLoading()
          util.toast(err.message || '保存失败')
        }
      }
    })
  },

  /** 改手机号（留空 = 不接受电话联系，只收微信通知） */
  onEditPhone(e) {
    const { id } = e.currentTarget.dataset
    wx.showModal({
      title: '修改手机号',
      content: '留空表示车主不接受电话联系，只接收微信通知。',
      placeholderText: '11 位手机号，可留空',
      editable: true,
      confirmText: '保存',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        const v = String(r.content || '').trim()
        if (v && !util.isPhone(v)) {
          util.toast('手机号格式不正确')
          return
        }
        wx.showLoading({ title: '保存中…', mask: true })
        try {
          await app.call('adminUpdate', { codeId: id, phone: v })
          wx.hideLoading()
          util.toast('已保存', 'success')
          this.refresh({ silent: true })
        } catch (err) {
          wx.hideLoading()
          util.toast(err.message || '保存失败')
        }
      }
    })
  },

  /** 预览码图 */
  async onPreviewCode(e) {
    const { id } = e.currentTarget.dataset
    wx.showLoading({ title: '加载中…', mask: true })
    try {
      const d = await app.call('adminDetail', { codeId: id })
      wx.hideLoading()
      if (!d.wxacodeFileID) {
        util.toast('这张码还没出图，请先「重新出图」')
        return
      }
      wx.previewImage({ urls: [d.wxacodeFileID], current: d.wxacodeFileID })
    } catch (err) {
      wx.hideLoading()
      util.toast(err.message || '加载失败')
    }
  },

  /** 启用 / 停用 */
  async onToggle(e) {
    const { id, enabled } = e.currentTarget.dataset
    const next = !enabled
    wx.showLoading({ title: '处理中…', mask: true })
    try {
      await app.call('adminUpdate', { codeId: id, enabled: next })
      wx.hideLoading()
      util.toast(next ? '已启用通知' : '已暂停通知', 'success')
      this.refresh({ silent: true })
    } catch (err) {
      wx.hideLoading()
      util.toast(err.message || '操作失败')
    }
  },

  /**
   * 重新出图
   * 版本是烧死在图片里的，切了运行模式旧码不会自动变 —— 必须显式重出。
   */
  onRebuild(e) {
    const { id } = e.currentTarget.dataset
    wx.showActionSheet({
      itemList: ['跟随当前运行模式（推荐）', '强制正式版（可打印）', '强制体验版（仅自测）'],
      success: async (res) => {
        const envMap = [undefined, 'release', 'trial']
        const envVersion = envMap[res.tapIndex]
        wx.showLoading({ title: '出图中…', mask: true })
        try {
          const r = await app.call('adminRebuild', { codeId: id, envVersion })
          wx.hideLoading()
          util.toast(`已重新出图（${r.envVersion === 'release' ? '正式版' : '体验版'}）`, 'success')
          this.refresh({ silent: true })
        } catch (err) {
          wx.hideLoading()
          wx.showModal({
            title: '出图失败',
            content: err.message || String(err),
            showCancel: false,
            confirmText: '知道了'
          })
        }
      },
      fail: () => {}
    })
  },

  /** 解绑：码 ID 和贴纸不变，清空车辆信息让别人可重新绑定 */
  onUnbind(e) {
    const { id, plate } = e.currentTarget.dataset
    const name = plate ? `${plate} 的挪车码` : '这张空白码'
    wx.showModal({
      title: '解绑这张码？',
      content:
        `将清空${name}绑定的车牌与联系方式，还原成空白码。\n\n` +
        '码 ID 和已打印的贴纸不变，别人扫码可重新绑定。',
      confirmText: '解绑',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '处理中…', mask: true })
        try {
          await app.call('adminUnbind', { codeId: id })
          wx.hideLoading()
          util.toast('已解绑，可重新绑定', 'success')
          this.refresh({ silent: true })
        } catch (err) {
          wx.hideLoading()
          util.toast(err.message || '解绑失败')
        }
      }
    })
  },

  /** 删除 */
  onDelete(e) {
    const { id, plate } = e.currentTarget.dataset
    const name = plate ? `${plate} 的挪车码` : '这张空白码'
    wx.showModal({
      title: '删除挪车码',
      content: `确定删除${name}吗？\n\n删除后这张码立即失效且不可恢复，已打印的贴纸作废（码图文件也会一并清除）。`,
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '删除中…', mask: true })
        try {
          await app.call('adminRemove', { codeId: id })
          wx.hideLoading()
          util.toast('已删除', 'success')
          this.refresh({ silent: true })
        } catch (err) {
          wx.hideLoading()
          util.toast(err.message || '删除失败')
        }
      }
    })
  },

  /* ==========================================================
   * 运行模式（从首页拆过来的全局开关）
   * ========================================================== */

  async loadRunMode() {
    try {
      const r = await app.call('getRunMode', {})
      this.setData({ isRelease: !!r.isRelease, runModeSrc: r.source || '' })
    } catch (err) {
      this.setData({
        isRelease: config.RUN_MODE === 'release',
        runModeSrc: 'read-failed'
      })
    }
  },

  onRunModeChange(e) {
    const nextRelease = !!e.detail.value
    const next = nextRelease ? 'release' : 'trial'
    const confirm = nextRelease
      ? {
          title: '切换到正式版？',
          content:
            '正式版下任何微信用户都能扫开挪车码。\n\n' +
            '请先确认小程序已完成 ICP 备案并正式发布，否则路人仍扫不开。',
          confirmText: '切到正式版'
        }
      : {
          title: '切回体验版？',
          content: '体验版仅体验成员能扫开挪车码，适合调试阶段。',
          confirmText: '切回体验版'
        }

    wx.showModal({
      title: confirm.title,
      content: confirm.content,
      confirmText: confirm.confirmText,
      cancelText: '再想想',
      success: (res) => {
        if (res.confirm) this.applyRunMode(next)
        else this.setData({ isRelease: !nextRelease })
      }
    })
  },

  async applyRunMode(mode) {
    this.setData({ runModeLoading: true })
    wx.showLoading({ title: '切换中…', mask: true })
    try {
      const r = await app.call('setRunMode', { runMode: mode })
      this.setData({ isRelease: !!r.isRelease })
      wx.hideLoading()

      if (r.persisted === false) {
        wx.showModal({
          title: '切换未生效',
          content:
            '已尝试写入，但回读到的运行模式仍是「' +
            (r.isRelease ? '正式版' : '体验版') +
            '」。请到云开发控制台确认 sys_config/global 可正常写入后重试。',
          showCancel: false,
          confirmText: '知道了'
        })
        return
      }

      util.toast(r.hint || (r.isRelease ? '已切到正式版' : '已切回体验版'), 'success')
      wx.showModal({
        title: '已有挪车码需要重新出图',
        content:
          '码的版本是烧在图片里的，切换模式后：\n\n' +
          '· 之后新建的码 → 直接是新版本\n' +
          '· 已有的码 → 在本页对每张点「重新出图」\n' +
          '· 已打印贴出去的贴纸 → 必须重新出图并重印\n\n' +
          '列表里标红「版本不符」的就是需要重新出图的。',
        showCancel: false,
        confirmText: '知道了'
      })
      this.refresh({ silent: true })
    } catch (err) {
      wx.hideLoading()
      this.setData({ isRelease: mode !== 'release' })
      const detail = (err && err.message) || '未知错误'
      wx.showModal({
        title: '切换失败',
        content: detail + (err && err.code ? `\n错误码：${err.code}` : ''),
        showCancel: false,
        confirmText: '知道了'
      })
    } finally {
      this.setData({ runModeLoading: false })
    }
  },

  /* ==========================================================
   * 生成空白码（从首页拆过来的高频入口，后台也留一份）
   * ========================================================== */

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
    this.pickBlankCount('release')
  },

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
      const itemsJson = encodeURIComponent(JSON.stringify(items))
      wx.navigateTo({
        url: `/pages/blanks/blanks?items=${itemsJson}&env=${envVersion || ''}`
      })
    } catch (err) {
      wx.hideLoading()
      util.toast(err.message || '生成失败')
    }
  }
})
