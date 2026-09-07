const app = getApp()
const util = require('../../utils/util.js')

/** 31 个省级行政区简称 */
const PROVINCES = [
  '京', '津', '沪', '渝', '冀', '豫', '云', '辽', '黑', '湘',
  '皖', '鲁', '新', '苏', '浙', '赣', '鄂', '桂', '甘', '晋',
  '蒙', '陕', '吉', '闽', '贵', '粤', '青', '藏', '川', '宁', '琼'
]

/** 新能源车牌正则：用于编辑回显 / 校验温和提醒 */
const NEW_ENERGY_RE = /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z](([0-9]{5}[DF])|([DF][A-HJ-NP-Z0-9][0-9]{4}))$/

/**
 * 车身固定 7 格：前 6 格为普通车牌，第 7 格为「新能源位」。
 * 普通车牌车身 6 位（蓝牌），新能源车身 7 位（绿牌）。
 * 是否新能源完全由「第 7 格是否为空」决定，无需手动切换按钮。
 */
const BODY_LEN = 7

Page({
  data: {
    isEdit: false,
    // 空白码绑定模式：码已存在但还没归属任何人
    isBind: false,
    codeId: '',
    plate: '',
    province: '',
    body: '',
    phone: '',
    carModel: '',
    isNewEnergy: false,
    maxBodyLen: BODY_LEN,
    bodySlots: [0, 1, 2, 3, 4, 5, 6],
    showProvincePicker: false,
    bodyFocus: false,
    bodyIndex: 0,
    submitting: false,
    provinces: PROVINCES,
    safeAreaBottom: 0
  },

  onLoad(options) {
    // 安全区高度，供省份面板底部留白
    const sys = wx.getSystemInfoSync()
    this.setData({ safeAreaBottom: sys.safeArea ? sys.screenHeight - sys.safeArea.bottom : 0 })

    if (options.codeId) {
      this.setData({ isEdit: true, codeId: options.codeId })

      // 空白码绑定：这张码还不归当前用户，detail 接口会因 openid 不匹配返回 403，
      // 所以绑定模式不去拉详情，直接让用户从头填写。
      if (options.bind === '1') {
        this.setData({ isBind: true, province: PROVINCES[15] }) // 默认「浙」
        wx.setNavigationBarTitle({ title: '绑定车辆' })
      } else {
        wx.setNavigationBarTitle({ title: '编辑车辆' })
        this.loadDetail(options.codeId)
      }
    } else {
      wx.setNavigationBarTitle({ title: '添加车辆' })
      // 默认选中第一个，方便用户直接输入
      this.setData({ province: PROVINCES[15] }) // 浙
    }
  },

  async loadDetail(codeId) {
    try {
      const detail = await app.call('detail', { codeId })
      const plate = String(detail.plate || '')
      const province = plate.slice(0, 1) || ''
      const body = plate.slice(1) || ''
      // 车身 7 位必为新能源（绿牌），6 位及以下为普通（蓝牌）
      const isNewEnergy = body.length >= BODY_LEN
      this.setData({
        plate,
        province,
        body: body.slice(0, BODY_LEN),
        phone: detail.phone,
        carModel: detail.carModel || '',
        isNewEnergy
      })
    } catch (err) {
      util.toast(err.message || '加载失败')
      setTimeout(() => wx.navigateBack(), 1500)
    }
  },

  /** 点击车身区域，拉起系统键盘 */
  focusBodyInput() {
    if (this.data.showProvincePicker) return
    const { body } = this.data
    const bodyIndex = body.length < BODY_LEN ? body.length : BODY_LEN - 1
    this.setData({ bodyFocus: true, bodyIndex })
  },

  /** 打开省份选择面板 */
  openProvincePicker() {
    // 收起车身输入，避免键盘和面板冲突
    this.setData({ showProvincePicker: true, bodyFocus: false, bodyIndex: -1 })
  },

  /** 关闭省份选择面板 */
  closeProvincePicker() {
    this.setData({ showProvincePicker: false })
  },

  /** 选择省份 */
  selectProvince(e) {
    const province = e.currentTarget.dataset.province
    const plate = province + this.data.body
    this.setData({ province, plate, showProvincePicker: false })
  },

  onBodyFocus() {
    const { body } = this.data
    const bodyIndex = body.length < BODY_LEN ? body.length : BODY_LEN - 1
    this.setData({ bodyFocus: true, bodyIndex })
  },

  onBodyBlur() {
    this.setData({ bodyFocus: false, bodyIndex: -1 })
  },

  onBodyInput(e) {
    const raw = e.detail.value || ''
    const filtered = raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, BODY_LEN)
    // 车身填到第 7 位即自动判定为新能源（绿牌）；6 位及以下为普通（蓝牌）
    const isNewEnergy = filtered.length >= BODY_LEN
    const bodyIndex = filtered.length < BODY_LEN ? filtered.length : BODY_LEN - 1
    this.setData({
      body: filtered,
      bodyIndex,
      isNewEnergy,
      plate: this.data.province + filtered
    })
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value.replace(/\D/g, '') })
  },

  onModelInput(e) {
    this.setData({ carModel: e.detail.value })
  },

  /** 阻止冒泡：点击省份面板内部不关闭 */
  preventBubble() {},

  /** 隐私政策 */
  goPolicy() {
    wx.navigateTo({ url: '/pages/policy/policy' })
  },

  async validate() {
    const { province, body, plate } = this.data
    if (!province) {
      util.toast('请选择车牌归属地')
      return false
    }
    if (!body) {
      util.toast('请填写车牌号')
      return false
    }
    if (!util.isPlate(plate)) {
      wx.showModal({
        title: '车牌号格式不对',
        content: `「${plate}」看起来不是有效的车牌。\n\n普通：浙A12345\n新能源：浙AD12345 或 浙A12345D`,
        showCancel: false
      })
      return false
    }

    // 新能源（绿牌）按规则第 3 位或最后一位应为 D/F。
    // 这里只做温和提醒，不阻断提交（混动 F 牌、纯电 D 牌均为新能源）。
    const isNewEnergyByRe = NEW_ENERGY_RE.test(plate.toUpperCase())
    if (this.data.isNewEnergy && !isNewEnergyByRe) {
      const goOn = await new Promise((resolve) => {
        wx.showModal({
          title: '请核对车牌',
          content: `新能源车牌（绿牌）共 8 位，第 3 位或最后一位应为 D / F。\n\n您填写的「${plate}」格式不太常见，请核对后继续提交。`,
          confirmText: '继续提交',
          cancelText: '返回修改',
          success: (r) => resolve(!!r.confirm)
        })
      })
      if (!goOn) return false
    }

    const p = String(this.data.phone || '').trim()
    if (p && !util.isPhone(p)) {
      util.toast('手机号格式不对，或留空不填')
      return false
    }
    return true
  },

  /**
   * 车主没填手机号时的知情确认
   * 不填会损失「电话联系」这条通道，必须先讲清楚再让他决定。
   */
  confirmNoPhone() {
    return new Promise((resolve) => {
      wx.showModal({
        title: '不填手机号？',
        content:
          '手机号是选填的，留空也能生成挪车码。\n\n' +
          '但不填的话，他人扫码时无法拨打电话，只能通过「微信通知」联系你 —— ' +
          '如果那时你的通知额度刚好用完，对方就联系不上你了。\n\n' +
          '生成后我们会请你开启微信通知。',
        confirmText: '仍不填写',
        cancelText: '去填写',
        success: (r) => resolve(!!r.confirm)
      })
    })
  },

  async onSubmit() {
    if (this.data.submitting) return
    if (!(await this.validate())) return

    if (!String(this.data.phone || '').trim()) {
      const goOn = await this.confirmNoPhone()
      if (!goOn) return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: this.data.isBind ? '绑定中…' : '生成中…', mask: true })

    try {
      const { plate, phone, carModel, codeId } = this.data
      const res = await app.call('save', {
        codeId: codeId || '',
        plate,
        phone,
        carModel
      })
      wx.hideLoading()
      this.setData({ submitting: false })

      // 绑定场景：扫码那张贴纸就是本人的挪车码，无需再生成 / 展示新码
      if (this.data.isBind) {
        util.toast('绑定成功，这张挪车码已归您所有', 'success')
        // 直接回到首页：此时本人已是车主，首页会自动刷新并展示这张码，
        // 通知额度也在进入首页时自动累积，不再单独弹授权框。
        setTimeout(() => wx.reLaunch({ url: '/pages/home/home' }), 900)
        return
      }

      util.toast(this.data.isEdit ? '已保存' : '创建成功', 'success')

      // 首次建码时顺手要一次微信通知授权，让车主从第一次起就能收到通知
      if (!this.data.isEdit) {
        app.requestNotifyQuota()
      }

      // 跳到挪车码页，替换当前页避免返回时重复提交
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/code/code?codeId=${res.codeId}` })
      }, 800)
    } catch (err) {
      wx.hideLoading()
      this.setData({ submitting: false })
      util.toast(err.message || '保存失败')
    }
  }
})
