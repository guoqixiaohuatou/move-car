/**
 * 通用工具
 */

/** 补零 */
function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/**
 * 时间戳格式化
 * @param {number} ts 毫秒时间戳
 * @param {boolean} withTime 是否带时分
 */
function formatTime(ts, withTime = true) {
  if (!ts) return '--'
  const d = new Date(ts)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (!withTime) return date
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对时间：刚刚 / 5 分钟前 / 昨天 14:30 */
function fromNow(ts) {
  if (!ts) return '--'
  const diff = Date.now() - ts
  if (diff < 0) return formatTime(ts)
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day === 1) return `昨天 ${formatTime(ts).slice(11)}`
  if (day < 7) return `${day} 天前`
  return formatTime(ts)
}

/**
 * 手机号脱敏：138****8888
 */
function maskPhone(phone) {
  if (!phone) return ''
  const s = String(phone)
  if (s.length < 7) return s
  return s.slice(0, 3) + '****' + s.slice(-4)
}

/**
 * 车牌脱敏：京A12345 -> 京A***5
 */
function maskPlate(plate) {
  if (!plate) return ''
  const s = String(plate)
  if (s.length <= 3) return s
  return s.slice(0, 2) + '*'.repeat(s.length - 3) + s.slice(-1)
}

/** 轻提示 */
function toast(title, icon = 'none') {
  wx.showToast({ title, icon, duration: 2000 })
}

/** 复制文本 */
function copy(text) {
  return new Promise((resolve) => {
    wx.setClipboardData({
      data: String(text),
      success: () => resolve(true),
      fail: () => resolve(false)
    })
  })
}

/**
 * 校验手机号
 */
function isPhone(v) {
  return /^1[3-9]\d{9}$/.test(String(v || '').trim())
}

/**
 * 校验车牌（民用 + 新能源 + 常见特殊车牌）
 */
function isPlate(v) {
  const s = String(v || '').trim().toUpperCase()
  // 普通：京A12345  新能源：京AD12345 / 京A12345D
  const civil = /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领A-Z]{1}[A-Z]{1}[A-Z0-9]{4,6}[A-Z0-9挂学警港澳领]{1}$/
  // 新能源 8 位
  const newEnergy = /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼]{1}[A-Z]{1}(([0-9]{5}[DF])|([DF][A-HJ-NP-Z0-9][0-9]{4}))$/
  return civil.test(s) || newEnergy.test(s)
}

module.exports = {
  pad,
  formatTime,
  fromNow,
  maskPhone,
  maskPlate,
  toast,
  copy,
  isPhone,
  isPlate
}
