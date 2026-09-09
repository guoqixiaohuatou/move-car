const cloud = require('wx-server-sdk')
const https = require('https')
const { URL } = require('url')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const COL_CARS = 'car_codes'
const COL_LOGS = 'notify_logs'

/* ============================================================
 * 【通知模板配置】—— 默认自动发现，一般无需改动
 * ------------------------------------------------------------
 * 全站统一只用「一个」挪车通知模板。工作方式是：
 *
 *   1) 自动发现（默认）
 *      调用微信接口读取你账号下已选用的模板，优先挑标题含「挪车 / 移车 /
 *      车辆 / 停车」的那一个，再按字段中文名自动映射内容：
 *          车牌 / 牌照     → 车牌号
 *          时间 / 日期     → 通知时间
 *          车型 / 车辆     → 车辆备注
 *          内容 / 留言/ 说明 → 扫码方留言
 *      所以在公众平台随便选用一个挪车类模板即可，不用回来改代码。
 *
 *   2) 手动指定（可选）
 *      若账号下有多个模板、自动挑的不对，把模板 ID 填到 MANUAL.templateId；
 *      MANUAL.data 里左边写模板字段名、右边写数据源，可覆盖自动映射。
 *
 * RUN_MODE（运行模式）
 *   'trial'    体验版 —— 仅体验成员能扫开挪车码，用于调试
 *   'release'  正式版 —— 任何微信用户都能扫开，需先完成 ICP 备案并通过审核发布
 *
 *   这个值会同时驱动两处：
 *     订阅消息 miniprogramState : trial → trial   /  release → formal
 *     小程序码 envVersion       : trial → trial   /  release → release
 *
 *   ⚠️ 只有 release 模式下，路人才扫得开你的挪车码。
 *
 *   切换方式（均无需改代码、无需重部署，见下方 getRunMode）：
 *     1) 控制台改数据库：云开发控制台 → 数据库 → 新建集合 sys_config →
 *        新增文档 _id="global"，字段 runMode="trial" 或 "release"
 *     2) 云端测试调用：{"action":"setRunMode","payload":{"runMode":"release"}}
 *        （仅车主本人可调用，防止陌生人改动）
 * ============================================================ */
const COL_SYS = 'sys_config'

/**
 * 数据库里没有合法的 runMode 时使用的兜底值
 * ------------------------------------------------------------
 * ⚠️ 已由 trial 改为 release。
 * 小程序正式发布后，绝大多数问题的表现都是「码扫不开、提示体验版」，
 * 而根因往往是 sys_config/global 里压根没有 runMode 字段（或填了非法值），
 * 此时回退成 trial 就会静默地一直出体验版码 —— 极难排查。
 * 发布上线后 release 才是正确默认：数据库没配置 = 按正式版跑。
 * 需要调试时显式切回 trial（开关 / 控制台改库 / setRunMode 均可，优先级更高）。
 */
const DEFAULT_RUN_MODE = 'release'

/* 运行模式缓存（进程内复用 60 秒；setRunMode 会立即失效，确保切换即时生效） */
let runModeCache = { at: 0, value: null }
// ⚠️ 刻意设为 0：运行模式**不做进程内缓存**，每次都读库。
// 云函数是多实例（多容器）并发运行的，setRunMode 只能清掉「处理写入的那个实例」的缓存，
// 其他实例仍会把旧值吐出来 —— 表现就是「开关切到正式版，重新进小程序又变回体验版」。
// 运行模式直接决定码是正式版还是体验版，读到旧值 = 印一批废纸。宁可多一次读库也要拿最新值。
const RUNMODE_TTL = 0

/** 读取当前生效的运行模式；数据库优先，读取失败回退默认值，绝不阻断业务 */
async function getRunMode() {
  const now = Date.now()
  if (runModeCache.value && now - runModeCache.at < RUNMODE_TTL) {
    return runModeCache.value
  }
  let mode = DEFAULT_RUN_MODE
  try {
    const doc = await db.collection(COL_SYS).doc('global').get()
    const raw = doc && doc.data ? doc.data : null
    if (raw && (raw.runMode === 'release' || raw.runMode === 'trial')) {
      mode = raw.runMode
    }
  } catch (e) {
    /* 集合不存在 / 读取失败 → 用默认值 */
  }
    runModeCache = { at: now, value: mode }
    return mode
  }

  /**
   * 读取空白码管理员 openid（云端配置，免重部署）
   * ------------------------------------------------------------
   * 空白挪车码只有管理员本人能生成。管理员 openid 存在
   *   sys_config/global.adminOpenid
   * 配置方式二选一：① 首页点「认领管理员身份」一键写入（推荐，无需查 openid）；
   *   ② 云开发控制台手动填自己的 openid（先用 getProfile/whoami 拿）。
   * 注意：微信号（如 liilillilllililli）≠ openid，不能直接写库。
   * 带进程内缓存，避免每次生成都读库。
   */
  let adminOpenidCache = { at: 0, value: undefined }
  // 同样受多实例缓存影响（认领管理员后别的实例可能仍是旧值），
  // 但管理员极少变动，30s 足够短，也避免每次进首页都读库。
  const ADMIN_TTL = 30 * 1000
  async function getAdminOpenid() {
    const now = Date.now()
    if (adminOpenidCache.at && now - adminOpenidCache.at < ADMIN_TTL) {
      return adminOpenidCache.value
    }
    let admin = ''
    try {
      const doc = await db.collection(COL_SYS).doc('global').get()
      const raw = doc && doc.data ? doc.data : null
      if (raw && raw.adminOpenid) admin = raw.adminOpenid
    } catch (e) {
      /* 集合不存在 / 读取失败 → 视为未配置 */
    }
    adminOpenidCache = { at: now, value: admin }
    return admin
  }

  /** 运行模式 → 小程序码与订阅消息的目标版本 */
function runModeConfig(runMode) {
  const release = runMode === 'release'
  return {
    miniprogramState: release ? 'formal' : 'trial',
    envVersion: release ? 'release' : 'trial'
  }
}

const TEMPLATE = {
  page: 'pages/logs/logs',
  lang: 'zh_CN'
}

/* 小程序码参数
 * checkPath: false —— 必填。默认 true 会校验 page 是否存在于「已发布的正式版」，
 *   未发布的小程序调用会报 41030 invalid page，导致挪车码完全生成不出来。
 * envVersion —— 由 getRunMode() 在运行时决定（trial → trial / release → release）。 */
const WXACODE = {
  checkPath: false
}

const MANUAL = {
  // 留空 = 自动发现；填了则固定使用该订阅消息模板（按 priTmplId 匹配）
  templateId: 'yeifiMbUM_NDnKvICWt1oabyP2trWhTYfG3ve4TMdYU',
  // 留 null = 根据该模板在账号模板库里的字段结构自动映射（推荐）；
  // 如需覆盖映射，填 { thing1: '${plate}', thing2: '${message}', time3: '${time}' } 这种形式
  data: null
}

/* 模板内容可选的填充数据：
 *   plate     车牌（脱敏，如 京A***5）
 *   message   扫码方留言，默认「有人在找您挪车，请尽快处理」
 *   time      通知时间，格式 2026-09-02 16:41
 *   carModel  车辆备注（如 白色 SUV）
 *   phoneMask 车主脱敏手机号（如 138****8888）
 */
const DATA_SOURCE = {
  plate: '',
  plateMask: '',
  message: '',
  time: '',
  carModel: '',
  phoneMask: ''
}

const DEFAULT_MESSAGE = '有人在找您挪车，请尽快处理'

/* ============================================================
 * 【数据保留期】—— 合规关键项
 * ------------------------------------------------------------
 * 隐私政策里向用户承诺了留存天数，这里必须真的执行清理，
 * 否则「声明 90 天自动清理、实际永久保存」= 虚假声明，
 * 审核被抽查到会直接驳回。
 *
 * 天数必须与 miniprogram/pages/policy/policy.js 的
 * logRetentionDays 保持一致。
 *
 * 执行方式：云开发控制台给本函数加一个定时触发器，
 * Payload 填 {"action":"cleanExpired","payload":{}}，
 * Cron 填 0 0 3 * * * *（每天凌晨 3 点）。
 * ============================================================ */
const RETENTION = {
  logDays: 90
}

/* ============================================================
 * 【微信 HTTP API 直连】—— 绕开 cloud.openapi 鉴权链路
 * ------------------------------------------------------------
 * 现象：本云环境的 cloud.openapi.* 调用持续报
 *   INVALID_WX_ACCESS_TOKEN / -501001，但数据库、云存储正常。
 *   这是环境「微信开放能力」鉴权链路在平台层异常（非配置问题，
 *   控制台里没有任何开关可修）。
 *
 * 解法：改用微信标准服务端 HTTP 接口（appid + appsecret 取 token），
 *   完全不依赖 cloud.openapi，因此不受该环境链路损坏影响。
 *   个人主体小程序用 appid/appsecret 调用订阅消息发送是官方标准做法，
 *   不属于「虚拟号 / 中转呼叫」等红线范围。
 *
 * 前置：云函数 car 的「配置 → 环境变量」里设置
 *   MP_APPID     = 小程序 AppID（wxYOUR_APPID_0000）
 *   MP_APPSECRET = 小程序 AppSecret（公众平台 → 开发 → 开发设置 获取）
 * ============================================================ */
const MP_APPID = process.env.MP_APPID || ''
const MP_APPSECRET = process.env.MP_APPSECRET || ''

/** 进程内 token 缓存（冷启动自动重取，无需落库） */
let tokenCache = { token: '', expireAt: 0 }

/** 极简 HTTPS 请求（JSON / 二进制） */
function httpReq(method, urlStr, body, opts) {
  opts = opts || {}
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'move-car' }
    }
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data)
    const req = https.request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (opts.binary) {
          resolve({
            statusCode: res.statusCode,
            contentType: res.headers['content-type'] || '',
            buffer: buf
          })
          return
        }
        const text = buf.toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch (e) {
          json = null
        }
        resolve({ statusCode: res.statusCode, json: json, text: text })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

/**
 * 取 access_token（稳定版接口调用凭据，缓存约 2 小时，提前 5 分钟刷新）
 * 使用 getStableAccessToken（cgi-bin/stable_token，POST）替代老的 cgi-bin/token（GET）。
 * 老接口拿到的 token 在「稳定版凭据」开启时会被判定为 "invalid or not latest"，
 * 表现为 40001；切到稳定版接口后该问题消失。
 */
async function getAccessToken() {
  if (!MP_APPID || !MP_APPSECRET) {
    throw new Error(
      '云函数环境变量未配置 MP_APPID / MP_APPSECRET。' +
      '请到云函数 car 的「配置 → 环境变量」填写：MP_APPID=小程序AppID，' +
      'MP_APPSECRET=公众平台 → 开发 → 开发设置 获取的 AppSecret。'
    )
  }
  const now = Date.now()
  if (tokenCache.token && tokenCache.expireAt > now + 5 * 60 * 1000) {
    return tokenCache.token
  }
  const res = await httpReq('POST', 'https://api.weixin.qq.com/cgi-bin/stable_token', {
    grant_type: 'client_credential',
    appid: MP_APPID,
    secret: MP_APPSECRET,
    force_refresh: false
  })
  const j = res.json
  if (!j || j.errcode) {
    const code = j ? j.errcode : ''
    let tip = ''
    if (code === 40001 || code === 40013 || code === 40125) {
      tip =
        '（AppID 或 AppSecret 错误 / 已失效。请到公众平台 → 开发 → 开发设置 确认 AppSecret 为当前有效值；' +
        '若重置过 AppSecret，请同步更新云函数环境变量 MP_APPSECRET 后重新部署。）'
    }
    throw new Error(
      `获取 access_token 失败：${code ? code + ' ' + (j.errmsg || '') : res.text || '空响应'} ${tip}`
    )
  }
  tokenCache = { token: j.access_token, expireAt: now + (j.expires_in || 7200) * 1000 }
  return j.access_token
}

/** 读取已选用的订阅模板（对应 cloud.openapi.subscribeMessage.getTemplateList） */
async function mpGetTemplateList() {
  const token = await getAccessToken()
  const res = await httpReq('GET', `https://api.weixin.qq.com/wxaapi/newtmpl/gettemplate?access_token=${token}`)
  const j = res.json
  if (!j || j.errcode) {
    throw new Error(`读取订阅模板失败：${j ? j.errcode + ' ' + j.errmsg : res.text || '空响应'}`)
  }
  return j.data || []
}

/** 发送订阅消息（对应 cloud.openapi.subscribeMessage.send） */
async function mpSendSubscribe(opts) {
  const token = await getAccessToken()
  const res = await httpReq(
    'POST',
    `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
    {
      touser: opts.touser,
      template_id: opts.templateId,
      page: opts.page,
      data: opts.data,
      miniprogram_state: opts.miniprogramState,
      lang: 'zh_CN'
    }
  )
  const j = res.json
  if (!j || j.errcode) {
    const err = new Error(`订阅消息发送失败：${j ? j.errcode + ' ' + j.errmsg : res.text || '空响应'}`)
    err.errCode = j ? j.errcode : -1
    throw err
  }
  return j
}

/** 生成小程序码（对应 cloud.openapi.wxacode.getUnlimited） */
async function mpGetWxacodeUnlimit(opts) {
  const token = await getAccessToken()
  const res = await httpReq(
    'POST',
    `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`,
    {
      scene: opts.scene,
      page: opts.page,
      width: opts.width || 430,
      auto_color: false,
      line_color: opts.lineColor,
      is_hyaline: opts.isHyaline,
      check_path: opts.checkPath,
      env_version: opts.envVersion
    },
    { binary: true }
  )
  if (res.contentType.indexOf('image') >= 0) {
    return res.buffer
  }
  const text = res.buffer.toString('utf8')
  let j = null
  try {
    j = JSON.parse(text)
  } catch (e) {}
  throw new Error(`生成小程序码失败：${j ? j.errcode + ' ' + j.errmsg : text}`)
}

/* 模板发现结果缓存（云函数实例内复用，10 分钟） */
let tplCache = { at: 0, value: null }
const TPL_TTL = 10 * 60 * 1000

/* ============================================================
 * 工具函数
 * ============================================================ */
function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/** 北京时间字符串 2026-09-02 16:41 */
function cnTime(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000)
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  )
}

/** 生成不可遍历的码 ID（16 位，去掉易混淆字符） */
function genCodeId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'
  let s = ''
  for (let i = 0; i < 16; i++) {
    s += chars[Math.floor(Math.random() * chars.length)]
  }
  return s
}

/**
 * 文本安全检测（微信 security.msgSecCheck 云调用）
 * ------------------------------------------------------------
 * 审核要求：小程序内用户可自由输入、且会被展示或传播的内容
 *（本项目 = 扫码方的「留言」，会被推送给车主并存入通知记录）
 * 必须接入内容安全检测，否则会被以「未对用户发布内容进行审核」为由驳回上架。
 *
 * 容错策略：仅当接口明确判定违规（errCode 87014）时才拦截；
 * 其余异常（权限未开、接口抖动等）一律放行并打日志，
 * 避免检测接口故障把正常的挪车请求误伤掉。
 */
async function checkTextSafe(content, openid) {
  try {
    await cloud.openapi.security.msgSecCheck({
      content: String(content || '').slice(0, 500),
      version: 2,
      scene: 2, // 2 = 评论 / 留言类场景
      openid: openid || ''
    })
    return { ok: true }
  } catch (e) {
    const msg = e.errMsg || e.message || String(e)
    // 87014 = 内容含违规信息
    if (e.errCode === 87014 || msg.indexOf('87014') >= 0 || msg.indexOf('risky') >= 0) {
      return { ok: false, reason: '留言包含不当内容，请修改后重试' }
    }
    console.warn('[msgSecCheck] 检测失败，按放行处理：', msg)
    return { ok: true, skipped: true }
  }
}

function maskPlate(plate) {
  if (!plate) return ''
  const s = String(plate)
  if (s.length <= 3) return s
  return s.slice(0, 2) + '*'.repeat(s.length - 3) + s.slice(-1)
}

function maskPhone(phone) {
  if (!phone) return ''
  const s = String(phone)
  if (s.length < 7) return s
  return s.slice(0, 3) + '****' + s.slice(-4)
}

/**
 * 生成（或重新生成）某个 codeId 的小程序码并上传到云存储
 * ------------------------------------------------------------
 * 抽成公共函数，供「新建车辆后取码」和「创建空白码时立即出码」两处复用。
 *
 * 云存储路径带 envVersion + 时间戳（wxacode/{codeId}-{env}-{ts}.png）：
 * 固定路径会让重生成变成「覆盖同一文件」，fileID 不变 → CDN 继续吐旧图，
 * 于是出现「切了正式版、也重新生成了，扫出来还是体验版」的假象。
 *
 * @param {string} [envOverride] 指定 'release' | 'trial'，不给则跟随当前运行模式。
 * @param {string} [oldFileID] 旧图 fileID，出图成功后删除，避免堆积垃圾文件。
 *   典型用途：小程序还在审核、正式版未发布时，管理员想「先把贴纸印出来」，
 *   此时要强制出 release 码——trial 码在正式发布后路人扫不开，印了等于废纸。
 *   因为 checkPath 恒为 false，未发布的小程序也能成功生成 release 码。
 *
 * @returns {Promise<{fileID: string, envVersion: string}>}
 */
async function buildWxacode(codeId, envOverride, oldFileID) {
  let envVersion = envOverride
  if (envVersion !== 'release' && envVersion !== 'trial') {
    envVersion = runModeConfig(await getRunMode()).envVersion
  }

  const wxacodeBuf = await mpGetWxacodeUnlimit({
    scene: codeId, // 最长 32 字符
    page: 'pages/notify/notify',
    width: 430,
    lineColor: { r: 22, g: 119, b: 255 },
    isHyaline: false,
    checkPath: WXACODE.checkPath,
    envVersion
  })

  // ⚠️ 路径必须带 envVersion + 时间戳，不能固定为 wxacode/{codeId}.png。
  // 固定路径下「重生成」是覆盖同一文件：fileID 不变，微信云存储/CDN 很可能
  // 继续吐旧图 —— 表现就是「明明切了正式版、也重新生成了，扫出来还是体验版」。
  // 换成新路径 = 新 fileID，彻底绕开缓存。
  const up = await cloud.uploadFile({
    cloudPath: `wxacode/${codeId}-${envVersion}-${Date.now()}.png`,
    fileContent: wxacodeBuf
  })

  // 旧图已无人引用，顺手删掉省空间（失败无所谓，不影响本次出码）
  if (oldFileID && oldFileID !== up.fileID) {
    try {
      await cloud.deleteFile({ fileList: [oldFileID] })
    } catch (e) {
      /* 旧文件可能已被删，忽略 */
    }
  }

  return { fileID: up.fileID, envVersion }
}

/**
 * 规范化「出码版本」入参
 * ------------------------------------------------------------
 * 只认 'release' / 'trial'，其余一律返回 undefined（= 跟随当前运行模式）。
 * 集中在这里校验，避免调用方直接引用未声明变量导致 ReferenceError
 * ——曾出现过 return 语句里用到未定义的 envOverride，码已入库却整段报错的情况。
 */
function normalizeEnv(v) {
  return v === 'release' || v === 'trial' ? v : undefined
}

/** 按微信订阅消息字段类型截断，避免 47003 */
function clip(value, fieldKey) {
  let v = String(value === undefined || value === null ? '' : value)
  const type = (fieldKey.match(/^[a-z_]+/) || [''])[0]
  const limits = {
    thing: 20,
    character_string: 32,
    phone_number: 17,
    car_number: 20,
    name: 10,
    phrase: 5,
    date: 10,
    time: 20,
    amount: 10,
    number: 10
  }
  const max = limits[type] || 20
  return v.length > max ? v.slice(0, max) : v
}

/* ============================================================
 * 模板自动发现
 * ============================================================ */

/** 解析模板 content，形如 "车牌号:{{car_number1.DATA}}\n提醒内容:{{thing2.DATA}}" */
function parseFields(content) {
  const fields = []
  String(content || '')
    .split('\n')
    .forEach((line) => {
      const m = line.match(/\{\{([a-z_]+)(\d*)\.DATA\}\}/)
      if (!m) return
      fields.push({
        key: m[1] + m[2], // 完整字段 key，如 thing2
        type: m[1], // 字段类型，如 thing
        label: line.slice(0, m.index).replace(/[:：\s]/g, '') // 中文名，如 车牌号
      })
    })
  return fields
}

/** 按中文名 → 数据源 */
const LABEL_RULES = [
  { re: /车牌|牌照|车号/, src: 'plate' },
  { re: /时间|日期|时刻/, src: 'time' },
  { re: /车型|车辆|品牌|颜色/, src: 'carModel' },
  { re: /地点|位置|地址/, src: 'carModel' },
  { re: /电话|手机|联系/, src: 'phoneMask' },
  { re: /内容|留言|说明|备注|事由|详情|描述|原因|信息/, src: 'message' }
]

/** 按字段类型 → 数据源（中文名没命中时的兜底） */
const TYPE_RULES = {
  time: 'time',
  date: 'time',
  car_number: 'plate',
  phone_number: 'phoneMask',
  thing: 'message',
  character_string: 'plate',
  name: 'carModel'
}

/**
 * 建立「模板字段 key → 数据源」映射
 * 微信要求 data 里模板的每个字段都传值且不能多传，所以最后会给剩余字段兜底赋值。
 */
function buildDataMap(fields) {
  const used = {}
  const map = {}
  const assign = (key, src) => {
    if (used[src]) return false
    used[src] = true
    map[key] = src
    return true
  }

  // 第一轮：按中文名匹配，最准
  fields.forEach((f) => {
    const rule = LABEL_RULES.find((r) => r.re.test(f.label))
    if (rule) assign(f.key, rule.src)
  })

  // 第二轮：按字段类型匹配
  fields.forEach((f) => {
    if (map[f.key]) return
    const src = TYPE_RULES[f.type]
    if (src) assign(f.key, src)
  })

  // 第三轮：剩余字段兜底，保证每个字段都有值
  const fallback = ['message', 'carModel', 'plate', 'time', 'phoneMask']
  fields.forEach((f) => {
    if (map[f.key]) return
    const src = fallback.find((s) => !used[s]) || 'message'
    assign(f.key, src)
  })

  return map
}

/** 从账号模板列表里挑一个挪车类模板 */
function pickTemplate(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  const keywords = ['挪车', '移车', '挪車', '移車', '车辆', '停车', '挪车提醒']
  for (let i = 0; i < keywords.length; i++) {
    const hit = list.find((t) => (t.title || '').indexOf(keywords[i]) >= 0)
    if (hit) return hit
  }
  return list[0]
}

/**
 * 解析出当前生效的模板配置
 * @returns {Promise<{templateId, title, content, dataMap, source, fields}|null>}
 */
async function resolveTemplate() {
  // 手动指定的优先
  if (MANUAL.templateId) {
    // 1) 用户手写了字段映射，直接用（最高优先级）
    if (MANUAL.data) {
      const dataMap = {}
      Object.keys(MANUAL.data).forEach((key) => {
        const m = String(MANUAL.data[key]).match(/\$\{(\w+)\}/)
        dataMap[key] = m ? m[1] : 'message'
      })
      return {
        templateId: MANUAL.templateId,
        title: '（手动指定）',
        content: '',
        fields: Object.keys(MANUAL.data).map((key) => ({ key, label: key })),
        dataMap,
        source: 'manual'
      }
    }
    // 2) 只给了模板 ID：去账号模板库里找到它，自动提取字段与映射
    const list = await mpGetTemplateList()
    const tpl = (list || []).find((t) => t.priTmplId === MANUAL.templateId)
    if (!tpl) {
      return null
    }
    const fields = parseFields(tpl.content)
    return {
      templateId: MANUAL.templateId,
      title: tpl.title || '（手动指定）',
      content: tpl.content || '',
      fields: fields.map((f) => ({ key: f.key, label: f.label })),
      dataMap: buildDataMap(fields),
      source: 'manual'
    }
  }

  // 缓存命中
  if (tplCache.value && Date.now() - tplCache.at < TPL_TTL) {
    return tplCache.value
  }

  const list = await mpGetTemplateList()
  const tpl = pickTemplate(list)
  if (!tpl || !tpl.priTmplId) {
    return null
  }

  const fields = parseFields(tpl.content)
  const value = {
    templateId: tpl.priTmplId,
    title: tpl.title || '',
    content: tpl.content || '',
    fields: fields.map((f) => ({ key: f.key, label: f.label })),
    dataMap: buildDataMap(fields),
    source: 'auto'
  }

  tplCache = { at: Date.now(), value }
  return value
}

/** 渲染模板 data：按映射把真实内容填进模板字段 */
function renderTemplateData(dataMap, ctx) {
  const out = {}
  Object.keys(dataMap || {}).forEach((key) => {
    const src = dataMap[key]
    const value = ctx[src] === undefined ? '' : ctx[src]
    out[key] = { value: clip(value, key) }
  })
  return out
}

/** 统一返回 */
function ok(data) {
  return { code: 0, data: data || {}, message: 'ok' }
}

function fail(message, code = -1, detail = null) {
  return { code, message, detail }
}

/* ============================================================
 * 管理后台（仅管理员）
 * ------------------------------------------------------------
 * 前端页面 pages/admin/admin 统一承载：统计总览 + 全部挪车码管理
 * （搜索 / 筛选 / 启停 / 编辑 / 解绑 / 重出码图 / 删除）。
 *
 * ⚠️ 前端隐藏入口只是体验，真正的边界必须在服务端：
 *    每个 admin* action 都在开头独立校验一次管理员身份。
 * ============================================================ */
async function requireAdmin(openid) {
  const adminOpenid = await getAdminOpenid()
  if (!adminOpenid) {
    return { ok: false, res: fail('系统尚未配置管理员，请先在首页认领管理员身份', 403) }
  }
  if (!openid || openid !== adminOpenid) {
    return { ok: false, res: fail('仅管理员可操作', 403) }
  }
  return { ok: true, adminOpenid }
}

/** 手机号脱敏：138****8888（管理后台列表默认不展示完整号码） */
function maskPhone(p) {
  const s = String(p || '')
  if (!s) return ''
  if (s.length < 7) return s
  return s.slice(0, 3) + '****' + s.slice(-4)
}

/** openid 脱敏：oXKsUxhE…IOy8 —— 管理后台要能区分不同车主，但不必暴露完整值 */
function maskOpenid(id) {
  const s = String(id || '')
  if (!s) return ''
  if (s.length <= 12) return s.slice(0, 4) + '…'
  return s.slice(0, 8) + '…' + s.slice(-4)
}

/** 管理后台一次性最多扫描多少条码。个人项目通常几百张，够用且逻辑简单 */
const ADMIN_SCAN_MAX = 500

/** 按 createTime 倒序扫描 car_codes（云函数单次 get 上限 100 条） */
async function scanCars(limit = ADMIN_SCAN_MAX) {
  const out = []
  const PAGE = 100
  for (let skip = 0; skip < limit; skip += PAGE) {
    const res = await db
      .collection(COL_CARS)
      .orderBy('createTime', 'desc')
      .skip(skip)
      .limit(PAGE)
      .get()
    out.push(...res.data)
    if (!res.data || res.data.length < PAGE) break
  }
  return out
}

/** 码记录 → 管理后台列表项（手机号 / openid 默认脱敏，完整值走 adminDetail） */
function toAdminItem(car, adminOpenid) {
  // bound === false = 空白码；老数据没有 bound 字段，只要填了车牌就视为已绑定
  const bound = car.bound !== false && !!car.plate
  return {
    _id: car._id,
    codeId: car.codeId,
    plate: car.plate || '',
    carModel: car.carModel || '',
    phoneMask: maskPhone(car.phone),
    phoneSet: !!car.phone,
    enabled: car.enabled !== false,
    bound,
    isBlank: !bound,
    quota: car.quota || 0,
    ownerOpenidMask: maskOpenid(car._openid),
    // 管理员自己的码标出来，避免误删自己车上那张
    isMine: !!(adminOpenid && car._openid === adminOpenid),
    wxacodeEnv: car.wxacodeEnv || '',
    hasImage: !!car.wxacodeFileID,
    createTime: car.createTime || 0,
    updateTime: car.updateTime || 0,
    lastNotifyTime: car.lastNotifyTime || 0
  }
}

/* ============================================================
 * 业务 Action
 * ============================================================ */
const actions = {
  /** 创建 / 更新车辆 */
  async save({ openid, payload }) {
    const { codeId, plate, phone, carModel } = payload

    if (!plate) {
      return fail('车牌号不能为空', 400)
    }

    // 手机号【选填】：留空表示车主只接受微信通知，不提供电话联系。
    // 传了就必须是合法号码，避免脏数据导致扫码页展示错号。
    const phoneValue = String(phone || '').trim()
    if (phoneValue && !/^1[3-9]\d{9}$/.test(phoneValue)) {
      return fail('手机号格式不正确', 400)
    }

    // 更新已有车辆 / 绑定空白码
    if (codeId) {
      // 注意：这里刻意不按 openid 过滤 —— 空白码还没归属任何人，
      // 必须能查到才能走下面的「先到先得」绑定分支。
      const exist = await db.collection(COL_CARS).where({ codeId }).limit(1).get()

      if (exist.data.length === 0) {
        return fail('车辆不存在或无权修改', 403)
      }

      const car = exist.data[0]

      // ---- 空白码绑定：先到先得 ----
      // bound === false 表示这张码尚未绑定车辆，任何扫码人都能绑定。
      // 用「条件更新」保证原子性：where 里带 bound:false，
      // 若两人同时抢绑，只有第一个的 updated === 1，第二个拿到 409。
      if (car.bound === false) {
        const upd = await db
          .collection(COL_CARS)
          .where({ codeId, bound: false })
          .update({
            data: {
              plate,
              phone: phoneValue,
              carModel: carModel || '',
              bound: true,
              _openid: openid, // 所有权转移给绑定者
              enabled: true,
              updateTime: Date.now()
            }
          })

        if (!upd.stats || upd.stats.updated === 0) {
          return fail('这个挪车码刚被别人绑定了，请确认贴纸是否归你所有', 409)
        }
        return ok({ codeId, bound: true })
      }

      // ---- 已绑定：仅车主本人可改 ----
      if (car._openid !== openid) {
        return fail('车辆不存在或无权修改', 403)
      }

      await db.collection(COL_CARS).doc(car._id).update({
        data: { plate, phone: phoneValue, carModel: carModel || '', updateTime: Date.now() }
      })
      return ok({ codeId })
    }

    // 新建：生成唯一 codeId
    let newId = genCodeId()
    for (let i = 0; i < 5; i++) {
      const dup = await db.collection(COL_CARS).where({ codeId: newId }).count()
      if (dup.total === 0) break
      newId = genCodeId()
    }

    await db.collection(COL_CARS).add({
      data: {
        codeId: newId,
        _openid: openid,
        plate,
        phone: phoneValue,
        carModel: carModel || '',
        bound: true, // 直接建车 = 已绑定；空白码才会是 false
        enabled: true,
        quota: 0, // 订阅消息可推送次数
        wxacodeFileID: '',
        createTime: Date.now(),
        updateTime: Date.now(),
        lastNotifyTime: 0
      }
    })

    return ok({ codeId: newId })
  },

  /**
   * 生成一张「空白挪车码」
   * ------------------------------------------------------------
   * 空白码 = 小程序码已生成、但尚未绑定车辆的记录（bound:false，plate 为空）。
   * 任何人扫到它都能填写车牌完成绑定，**先到先得**：绑定后所有权（_openid）
   * 立即转移给绑定者，创建者不再持有这张码。
   *
   * 典型用法：生成码 → 打印成贴纸 → 贴到车上（或转送他人）→ 扫码绑定车辆。
   * 这样一张贴纸可以先印刷、后绑定，不必提前知道车牌号。
   */
  async createBlank({ openid, payload }) {
    const envOverride = normalizeEnv(payload && payload.envVersion)
    let newId = genCodeId()
    for (let i = 0; i < 5; i++) {
      const dup = await db.collection(COL_CARS).where({ codeId: newId }).count()
      if (dup.total === 0) break
      newId = genCodeId()
    }

    // 立即出码：空白码的意义就是「先拿到图去打印」，不能等绑定后才有。
    // 生成失败也不阻断建记录，用户可在挪车码页重试生成。
    let wxacodeFileID = ''
    let wxacodeEnv = ''
    try {
      const built = await buildWxacode(newId, envOverride)
      wxacodeFileID = built.fileID
      wxacodeEnv = built.envVersion
    } catch (e) {
      /* 留空，稍后重试 */
    }

    await db.collection(COL_CARS).add({
      data: {
        codeId: newId,
        _openid: openid,
        plate: '',
        phone: '',
        carModel: '',
        bound: false,
        enabled: true,
        quota: 0, // 订阅消息可推送次数
        wxacodeFileID,
        wxacodeEnv,
        createTime: Date.now(),
        updateTime: Date.now(),
        lastNotifyTime: 0
      }
    })

    return ok({ codeId: newId, fileID: wxacodeFileID, bound: false })
  },

  /**
   * 批量生成空白挪车码
   * ------------------------------------------------------------
   * 用于「管理员一次印一批贴纸，分发给亲友扫码绑定」的场景。
   *
   * - count 由前端传入，服务端做上限校验（防绕过前端的恶意请求）。
   * - 每张码都跑一遍 createBlank 的写入 + 出码逻辑；任何一张失败不影响其他张。
   * - 返回 items 里只保留「写入成功」的码（失败的在 failed 字段计数），
   *   前端展示时直接用返回的 items 数组。
   *
   * envVersion（可选）：'release' | 'trial'
   *   正式版未发布时也能强制出 release 码（checkPath 恒 false），
   *   供管理员「先印贴纸、发布后扫码绑定」。trial 码发布后会作废。
   */
  async createBlanks({ openid, payload }) {
    // ---- 权限：只有管理员本人能生成空白挪车码 ----
    const adminOpenid = await getAdminOpenid()
    if (!adminOpenid || openid !== adminOpenid) {
      return fail('仅管理员可生成空白挪车码', 403)
    }

    const count = Math.max(1, parseInt(payload && payload.count, 10) || 1)
    const MAX_BLANK_BATCH = 5 // 与前端选数上限对齐；改这里同步改前端
    const N = Math.min(count, MAX_BLANK_BATCH)
    // 出码版本：前端弹窗选的「正式版（打印）/ 体验版（自测）」，不传则跟随运行模式
    const envOverride = normalizeEnv(payload && payload.envVersion)

    const items = []
    let failed = 0

    // 串行生成，避免瞬时并发调用微信 getwxacodeunlimit 接口触发限流
    for (let i = 0; i < N; i++) {
      let newId = genCodeId()
      for (let t = 0; t < 5; t++) {
        const dup = await db.collection(COL_CARS).where({ codeId: newId }).count()
        if (dup.total === 0) break
        newId = genCodeId()
      }

      // 出码（失败也不阻断，fileID 留空让前端用 getWxacode 重试）
      let wxacodeFileID = ''
      let wxacodeEnv = ''
      try {
        const built = await buildWxacode(newId, envOverride)
        wxacodeFileID = built.fileID
        wxacodeEnv = built.envVersion
      } catch (e) {
        /* 留空 */
      }

      try {
        await db.collection(COL_CARS).add({
          data: {
            codeId: newId,
            _openid: openid,
            plate: '',
            phone: '',
            carModel: '',
            bound: false,
            enabled: true,
            quota: 0,
            wxacodeFileID,
            wxacodeEnv,
            createTime: Date.now(),
            updateTime: Date.now(),
            lastNotifyTime: 0
          }
        })
        items.push({ codeId: newId, fileID: wxacodeFileID, bound: false, env: wxacodeEnv })
      } catch (e) {
        failed++
      }
    }

    return ok({ items, failed, requested: N, env: envOverride || 'auto' })
  },

  /**
   * 当前用户身份快照
   * 前端用它决定是否显示「生成空白挪车码」入口，顺便把 openid 暴露出来
   * 供管理员复制到 sys_config/global.adminOpenid 完成权限配置。
   */
  async getProfile({ openid }) {
    const adminOpenid = await getAdminOpenid()
    const isAdmin = !!(adminOpenid && openid && openid === adminOpenid)
    // hasAdmin = 系统里是否已有管理员。前端据此决定是否还显示「认领」入口：
    // 一旦有人认领过，认领按钮对所有人永久隐藏，避免后来的陌生人抢认管理员。
    return ok({ openid: openid || '', isAdmin, hasAdmin: !!adminOpenid })
  },

  /** 返回调用者自己的 openid（只读自己，任何登录用户可调用，安全） */
  async whoami({ openid }) {
    return ok({ openid: openid || '' })
  },

  /**
   * 认领管理员身份（自助配置空白码权限）
   * ------------------------------------------------------------
   * 调用者把自己的 openid 写入 sys_config/global.adminOpenid：
   *   - 未配置过 → 直接认领（首个进入首页并点击的人成为管理员）
   *   - 已配置且是本人 → 幂等成功（提示已认领）
   *   - 已配置且是别人 → 拒绝（保留 force=1 留给真正主人找回）
   * 这样管理员无需去控制台查/粘 openid，首页点一下即可解锁空白码生成。
   * 注意：微信号（如 liilillilllililli）≠ openid，不能直接写库；
   *       本接口写入的是微信系统下发的真实 openid。
   *
   * 另外支持 payload.openid 显式指定（用于云开发控制台「云端测试」）：
   *   云端测试没有登录态，wxCtx.OPENID 为空，此时可手工传入 openid 完成配置，
   *   省去"手机复制 → 电脑粘贴"这个跨设备根本走不通的步骤。
   *   安全级别与前端认领完全相同——仅在系统尚无管理员时允许，已被认领则拒绝。
   */
  async claimAdmin({ openid, payload }) {
    let target = openid
    if (!target && payload && typeof payload.openid === 'string') {
      target = payload.openid.trim()
    }
    if (!target) {
      return fail('未获取到用户身份', 401)
    }
    // 格式校验：openid 是 o 开头的 28 位字符串。挡住误把「微信号」当 openid 填进来
    // （微信号 ≠ openid，填错会导致校验永远不通过，连本人也生成不了空白码）
    if (!/^o[A-Za-z0-9_-]{27}$/.test(target)) {
      return fail(
        'openid 格式不正确（应为 o 开头、共 28 位字符）。注意：微信号不等于 openid，请用小程序首页显示的真实 openid。',
        400
      )
    }
    const adminOpenid = await getAdminOpenid()
    if (adminOpenid && adminOpenid !== target) {
      const force = payload && payload.force === true
      if (!force) {
        return fail('管理员已认领，无需重复操作', 409)
      }
    }
    // sys_config 集合可能还不存在（首次用到时才会建），先尝试创建；已存在则忽略
    try {
      await db.createCollection(COL_SYS)
    } catch (e) {
      /* 已存在则忽略 */
    }
    // 优先 update（保留文档其他字段如 runMode），文档不存在时退而 set 新建
    try {
      const upd = await db.collection(COL_SYS).doc('global').update({
        data: { adminOpenid: target }
      })
      if (!upd || !upd.stats || upd.stats.updated === 0) {
        await db.collection(COL_SYS).doc('global').set({
          data: { adminOpenid: target }
        })
      }
    } catch (e) {
      try {
        await db.collection(COL_SYS).doc('global').set({
          data: { adminOpenid: target }
        })
      } catch (e2) {
        return fail('写入管理员配置失败：' + (e2.errMsg || e2.message || String(e2)), 500)
      }
    }
    // 立即清缓存，让 getAdminOpenid 下次读到最新值
    adminOpenidCache = { at: 0, value: undefined }
    return ok({ openid: target, isAdmin: true, claimed: true })
  },

  /** 我的车辆列表 */
  async list({ openid }) {
    const res = await db
      .collection(COL_CARS)
      .where({ _openid: openid })
      .orderBy('createTime', 'desc')
      .limit(50)
      .get()

    return ok(res.data)
  },

  /** 车辆详情（仅车主本人） */
  async detail({ openid, payload }) {
    const { codeId } = payload
    const res = await db
      .collection(COL_CARS)
      .where({ codeId, _openid: openid })
      .limit(1)
      .get()

    if (res.data.length === 0) {
      return fail('车辆不存在或无权查看', 403)
    }
    return ok(res.data[0])
  },

  /**
   * 扫码方获取车辆信息
   * 注意：这里会返回完整 phone —— 因为 wx.makePhoneCall 必须拿到真实号码，
   * 前端默认不渲染该字段（由 config.SHOW_PLAIN_PHONE 控制）。
   */
  async getByCode({ openid, payload }) {
    const { codeId } = payload
    if (!codeId) return fail('缺少码 ID', 400)

    // ---- 防拖库频控 ----
    // 该接口不校验身份（任何人扫码都要能调用），因此必须限制单用户查询频率，
    // 否则可被脚本遍历 codeId 批量拉取车主手机号。
    const recentViews = await db
      .collection(COL_LOGS)
      .where({
        fromOpenid: openid,
        type: 'view',
        createTime: _.gt(Date.now() - 10 * 60 * 1000)
      })
      .count()

    if (recentViews.total > 50) {
      return fail('操作过于频繁，请稍后再试', 429)
    }

    const res = await db.collection(COL_CARS).where({ codeId }).limit(1).get()
    if (res.data.length === 0) {
      return fail('挪车码无效，请确认贴纸是否完整', 404)
    }

    const car = res.data[0]

    // ---- 空白码：尚未绑定车辆，引导扫码方去绑定 ----
    // 未绑定的码不含任何车主信息，不存在拖库风险，因此直接返回，
    // 也不写 view 日志（否则会污染绑定后车主的通知记录）。
    if (car.bound === false || !car.plate) {
      return ok({ bound: false, codeId })
    }

    if (!car.enabled) {
      return fail('车主已暂停该挪车码的通知功能', 403)
    }

    // 记录一次「被扫码」（车主可在通知记录里看到；同时用于频控统计）
    writeLog({
      codeId,
      fromOpenid: openid,
      type: 'view',
      status: 'ok',
      message: ''
    })

    return ok({
      plateFull: car.plate,
      plateMask: maskPlate(car.plate),
      carModel: car.carModel || '',
      phone: car.phone,
      phoneMask: maskPhone(car.phone),
      enabled: car.enabled
    })
  },

  /** 累积订阅消息额度（车主每次授权 +1，作用于其名下所有车辆） */
  async addQuota({ openid, payload }) {
    const { codeId } = payload || {}

    await db
      .collection(COL_CARS)
      .where({ _openid: openid })
      .update({ data: { quota: _.inc(1) } })

    // 传了 codeId 就回读这辆车的额度，否则回读第一辆（调用方只关心是否成功）
    const where = codeId ? { codeId, _openid: openid } : { _openid: openid }
    const one = await db.collection(COL_CARS).where(where).limit(1).get()
    const quota = one.data.length ? one.data[0].quota : 0
    return ok({ quota })
  },

  /** 启用 / 停用 */
  async toggle({ openid, payload }) {
    const { codeId, enabled } = payload
    await db
      .collection(COL_CARS)
      .where({ codeId, _openid: openid })
      .update({ data: { enabled: !!enabled, updateTime: Date.now() } })
    return ok({ enabled: !!enabled })
  },

  /** 删除 */
  async remove({ openid, payload }) {
    const { codeId } = payload
    const res = await db
      .collection(COL_CARS)
      .where({ codeId, _openid: openid })
      .limit(1)
      .get()

    if (res.data.length === 0) return fail('车辆不存在', 403)

    await db.collection(COL_CARS).doc(res.data[0]._id).remove()
    return ok({ removed: true })
  },

  /**
   * 【管理后台】总览统计
   * 一次拿齐后台首页要显示的所有数字，避免前端多次请求。
   */
  async adminStats({ openid }) {
    const gate = await requireAdmin(openid)
    if (!gate.ok) return gate.res

    const d = new Date()
    d.setHours(0, 0, 0, 0)
    const todayTs = d.getTime()
    const weekTs = todayTs - 6 * 24 * 3600 * 1000

    const [total, blank, disabled, today, week, notifyAll, notifySent] = await Promise.all([
      db.collection(COL_CARS).count(),
      db.collection(COL_CARS).where({ bound: false }).count(),
      db.collection(COL_CARS).where({ enabled: false }).count(),
      db.collection(COL_CARS).where({ createTime: _.gt(todayTs) }).count(),
      db.collection(COL_CARS).where({ createTime: _.gt(weekTs) }).count(),
      db.collection(COL_LOGS).where({ type: 'notify' }).count(),
      db.collection(COL_LOGS).where({ type: 'notify', status: 'sent' }).count()
    ])

    return ok({
      total: total.total || 0,
      blank: blank.total || 0,
      // 老数据没有 bound 字段，用 total - blank 才准确（不能用 _.neq(false) 查，会漏掉老数据）
      bound: (total.total || 0) - (blank.total || 0),
      disabled: disabled.total || 0,
      today: today.total || 0,
      week: week.total || 0,
      notifyTotal: notifyAll.total || 0,
      notifySent: notifySent.total || 0
    })
  },

  /**
   * 【管理后台】全部挪车码列表（搜索 / 筛选 / 分页）
   * ------------------------------------------------------------
   * payload:
   *   keyword   码 ID / 车牌 / 车辆备注 / 车主 openid 模糊匹配
   *   filter    all | bound | blank | disabled
   *   page      页码，从 1 开始
   *   pageSize  每页条数，默认 20，上限 50
   *
   * 数据量小（个人项目通常几百张），直接全量扫描后在内存里过滤排序：
   * 这样「已绑定」这种需要兼容老数据（无 bound 字段）的判断才准确，
   * 也不会被数据库 where 的字段存在性语义坑到。
   */
  async adminList({ openid, payload }) {
    const gate = await requireAdmin(openid)
    if (!gate.ok) return gate.res

    const p = payload || {}
    const keyword = String(p.keyword || '').trim().toLowerCase()
    const filter = p.filter || 'all'
    const page = Math.max(1, parseInt(p.page, 10) || 1)
    const pageSize = Math.min(50, Math.max(1, parseInt(p.pageSize, 10) || 20))

    let rows = await scanCars()
    rows = rows.map((c) => toAdminItem(c, gate.adminOpenid))

    if (filter === 'blank') rows = rows.filter((r) => r.isBlank)
    else if (filter === 'bound') rows = rows.filter((r) => r.bound)
    else if (filter === 'disabled') rows = rows.filter((r) => !r.enabled)

    if (keyword) {
      rows = rows.filter((r) => {
        const hay = [r.codeId, r.plate, r.carModel, r.ownerOpenidMask, r._openid]
          .join(' ')
          .toLowerCase()
        return hay.indexOf(keyword) !== -1
      })
    }

    const total = rows.length
    const items = rows.slice((page - 1) * pageSize, page * pageSize)

    // 顺带回传「当前运行模式要求的出码版本」，前端据此把版本不匹配的码标红
    // —— 这类码正是「扫码打不开」的重灾区，必须在列表里一眼可见。
    const runMode = await getRunMode()

    return ok({
      items,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      runMode,
      expectEnv: runModeConfig(runMode).envVersion,
      scannedCapped: rows.length >= ADMIN_SCAN_MAX
    })
  },

  /**
   * 【管理后台】单张码详情（含完整手机号 / 车主 openid / 健康诊断）
   * ------------------------------------------------------------
   * 列表默认脱敏；管理员需要联系车主或排查问题时才点开这一条，
   * 完整号码不随列表批量下发，避免一次性泄露全部车主信息。
   */
  async adminDetail({ openid, payload }) {
    const gate = await requireAdmin(openid)
    if (!gate.ok) return gate.res

    const { codeId } = payload || {}
    if (!codeId) return fail('缺少码 ID', 400)

    const res = await db.collection(COL_CARS).where({ codeId }).limit(1).get()
    if (res.data.length === 0) return fail('这张码不存在', 404)

    const car = res.data[0]
    const runMode = await getRunMode()
    const cfg = runModeConfig(runMode)

    // 复用 dryrun 的判断口径，管理员不用切到控制台就能看出这张码扫了会怎样
    const imgEnv = car.wxacodeEnv || ''
    const envMatch = imgEnv === cfg.envVersion
    const bound = car.bound !== false && !!car.plate

    let verdict
    if (!car.wxacodeFileID) verdict = '⚠️ 还没有生成过码图，扫码会失败 → 需要重新出图'
    else if (!bound) verdict = '空白码（尚未绑定车辆）→ 扫码后引导绑定'
    else if (car.enabled === false) verdict = '已停用 → 扫码会提示车主已关闭通知'
    else if ((car.quota || 0) <= 0) verdict = '能打开，但通知额度为 0 → 点「通知车主」会失败'
    else if (!envMatch)
      verdict =
        `⚠️ 这张图是 ${imgEnv || '未知'} 版，当前运行模式要求 ${cfg.envVersion} → 扫不开，需重新出图`
    else verdict = '正常：扫码可通知车主'

    return ok({
      ...toAdminItem(car, gate.adminOpenid),
      phone: car.phone || '',
      ownerOpenid: car._openid || '',
      wxacodeFileID: car.wxacodeFileID || '',
      runMode,
      expectEnv: cfg.envVersion,
      envMatch,
      verdict
    })
  },

  /**
   * 【管理后台】修改任意一张码
   * ------------------------------------------------------------
   * 可改：plate / phone / carModel / enabled
   * 与 save 的区别：save 按 _openid 鉴权（车主改自己的），这里按管理员身份改任何人的。
   * 典型场景：车主把车牌填错了、手机号换了、需要后台替他停用通知。
   */
  async adminUpdate({ openid, payload }) {
    const gate = await requireAdmin(openid)
    if (!gate.ok) return gate.res

    const { codeId, plate, phone, carModel, enabled } = payload || {}
    if (!codeId) return fail('缺少码 ID', 400)

    const res = await db.collection(COL_CARS).where({ codeId }).limit(1).get()
    if (res.data.length === 0) return fail('这张码不存在', 404)

    const car = res.data[0]
    const data = { updateTime: Date.now() }
    let ownerSet = ''

    if (plate !== undefined) {
      if (!String(plate).trim()) return fail('车牌号不能为空', 400)
      data.plate = String(plate).trim().toUpperCase()
      // 改回车牌 = 这张码重新可用（从空白码变成已绑定）
      data.bound = true
      // ⚠️ 空白码的 _openid 是空的。若管理员在这里直接给它填车牌，
      // 不补归属的话这张码会变成「无主码」—— 谁的首页都看不到它，
      // 只能靠后台管理。所以兜底挂到管理员名下，并把结果回传给前端提示。
      if (!car._openid) {
        data._openid = gate.adminOpenid
        ownerSet = 'admin'
      }
    }
    if (phone !== undefined) {
      const v = String(phone || '').trim()
      // 手机号选填：留空表示车主不接受电话联系；填了必须合法
      if (v && !/^1[3-9]\d{9}$/.test(v)) return fail('手机号格式不正确', 400)
      data.phone = v
    }
    if (carModel !== undefined) data.carModel = String(carModel || '')
    if (enabled !== undefined) data.enabled = !!enabled

    await db.collection(COL_CARS).doc(res.data[0]._id).update({ data })
    return ok({ codeId, updated: true, ownerSet })
  },

  /**
   * 【管理后台】解绑（把已绑定的码还原成空白码，贴纸可重复利用）
   * ------------------------------------------------------------
   * 场景：车主换车 / 贴纸回收 / 误绑。解绑后清空车牌与联系方式，
   * 并把归属 openid 置空 —— 否则原车主首页仍能看到它，且别人绑不上。
   * 码 ID 与码图不变，已印出去的贴纸不用重印。
   */
  async adminUnbind({ openid, payload }) {
    const gate = await requireAdmin(openid)
    if (!gate.ok) return gate.res

    const { codeId } = payload || {}
    if (!codeId) return fail('缺少码 ID', 400)

    const res = await db.collection(COL_CARS).where({ codeId }).limit(1).get()
    if (res.data.length === 0) return fail('这张码不存在', 404)

    await db.collection(COL_CARS).doc(res.data[0]._id).update({
      data: {
        plate: '',
        phone: '',
        carModel: '',
        bound: false,
        enabled: true,
        quota: 0,
        _openid: '', // 清空归属，让下一个扫码的人能重新绑定
        lastNotifyTime: 0,
        updateTime: Date.now()
      }
    })
    return ok({ codeId, bound: false })
  },

  /**
   * 【管理后台】强制重新出码图（可指定版本）
   * ------------------------------------------------------------
   * 版本（体验版 / 正式版）是烧死在图片里的。「切了运行模式码还是扫不开」
   * 就是因为旧图没跟着换。这里给管理员一个明确的重出按钮：
   *   envVersion 不传 → 跟随当前运行模式；传 release / trial → 强制指定。
   */
  async adminRebuild({ openid, payload }) {
    const gate = await requireAdmin(openid)
    if (!gate.ok) return gate.res

    const { codeId, envVersion: envOverride } = payload || {}
    if (!codeId) return fail('缺少码 ID', 400)

    const res = await db.collection(COL_CARS).where({ codeId }).limit(1).get()
    if (res.data.length === 0) return fail('这张码不存在', 404)

    const car = res.data[0]
    try {
      const built = await buildWxacode(codeId, envOverride, car.wxacodeFileID)
      await db.collection(COL_CARS).doc(car._id).update({
        data: {
          wxacodeFileID: built.fileID,
          wxacodeEnv: built.envVersion,
          updateTime: Date.now()
        }
      })
      return ok({ codeId, fileID: built.fileID, envVersion: built.envVersion, rebuilt: true })
    } catch (err) {
      return fail(
        '重新出图失败：' + (err.errMsg || err.message || String(err)),
        500,
        err.errCode
      )
    }
  },

  /**
   * 【管理后台】删除任意一张码
   * ------------------------------------------------------------
   * 与 remove 的区别：remove 只能删自己的，这里管理员可清理任何一张
   * （用户注销、误生成、测试残留等）。同时删掉云存储里的码图，避免留垃圾文件。
   */
  async adminRemove({ openid, payload }) {
    const gate = await requireAdmin(openid)
    if (!gate.ok) return gate.res

    const { codeId } = payload || {}
    if (!codeId) return fail('缺少码 ID', 400)

    const res = await db.collection(COL_CARS).where({ codeId }).limit(1).get()
    if (res.data.length === 0) return fail('这张码不存在', 404)

    const car = res.data[0]
    await db.collection(COL_CARS).doc(car._id).remove()

    // 码图是废文件，一并清掉；失败不影响主流程（删记录已经成功）
    if (car.wxacodeFileID) {
      try {
        await cloud.deleteFile({ fileList: [car.wxacodeFileID] })
      } catch (e) {
        /* 图删不掉无所谓 */
      }
    }

    return ok({ codeId, removed: true, fileRemoved: !!car.wxacodeFileID })
  },

  /**
   * 切换运行模式（云端配置，免改代码 / 免重部署）
   * ------------------------------------------------------------
   * 仅车主本人可调用（名下必须已有车辆），防止陌生人改动全局开关。
   * 用法（云端测试）：{"action":"setRunMode","payload":{"runMode":"release"}}
   * 切换后立即失效运行模式缓存，下一次生成挪车码 / 发通知即生效。
   */
  async setRunMode({ openid, payload }) {
    const { runMode } = payload || {}
    if (runMode !== 'trial' && runMode !== 'release') {
      return fail('runMode 只能是 trial 或 release', 400)
    }
    // 权限：管理员（可直接切）或名下有车的车主。防止陌生人改动全局开关。
    // openid 为空说明来自云开发控制台/定时触发器，调用方本身就是管理员，直接放行
    // （不能带着 undefined 去查 _openid，会抛错）。
    if (openid) {
      // 管理员优先：管理后台的运行模式开关必须始终可用，
      // 即便管理员自己没添加过车辆（旧逻辑要求「名下有车」，会让后台开关直接 403）
      let isAdmin = false
      try {
        const adminOpenid = await getAdminOpenid()
        isAdmin = !!(adminOpenid && adminOpenid === openid)
      } catch (e) {
        /* 读不到按非管理员处理 */
      }

      if (!isAdmin) {
        const mine = await db.collection(COL_CARS).where({ _openid: openid }).limit(1).get()
        if (!mine.data || mine.data.length === 0) {
          return fail('仅管理员或车主本人可切换运行模式', 403)
        }
      }
    }
    // steps：把每一步的真实结果都带回去。云端测试里一眼就能定位
    // 「到底卡在写集合 / 写文档 / 还是回读」，不用靠猜。
    const steps = []
    const note = (name, okv, extra) => {
      steps.push(Object.assign({ step: name, ok: okv }, extra || {}))
    }

    try {
      await db.createCollection(COL_SYS)
      note('createCollection', true)
    } catch (e) {
      // 集合已存在也会走这里，属正常
      note('createCollection', false, { err: (e && (e.errCode || e.message)) || String(e) })
    }

    // 必须用 update 而不是 set：set 会覆盖整个 global 文档，
    // 把同一文档里的 adminOpenid（空白码管理员配置）一并清掉。
    try {
      const upd = await db
        .collection(COL_SYS)
        .doc('global')
        .update({ data: { runMode, updatedAt: Date.now() } })
      const updated = upd && upd.stats ? upd.stats.updated : -1
      note('update', updated > 0, { updated })
      if (updated === 0) {
        // 文档不存在 → 建一个
        await db.collection(COL_SYS).doc('global').set({ data: { runMode, updatedAt: Date.now() } })
        note('set(fallback)', true, { reason: 'update 影响 0 条，文档可能不存在' })
      }
    } catch (e) {
      note('update', false, { err: (e && (e.errCode || e.message)) || String(e) })
      try {
        await db.collection(COL_SYS).doc('global').set({ data: { runMode, updatedAt: Date.now() } })
        note('set(catch)', true)
      } catch (e2) {
        note('set(catch)', false, { err: (e2 && (e2.errCode || e2.message)) || String(e2) })
      }
    }

    runModeCache = { at: 0, value: null } // 立即失效缓存

    // 回读校验：返回「真正落库的值」，而不是我们以为写进去的值。
    // 万一写入因权限/环境异常没生效，开关会立刻回弹成真实状态，而不是假装成功。
    let stored = runMode
    let readback = 'skipped'
    try {
      const doc = await db.collection(COL_SYS).doc('global').get()
      const raw = doc && doc.data ? doc.data : null
      if (!raw) {
        readback = 'doc-missing'
      } else if (raw.runMode === 'release' || raw.runMode === 'trial') {
        stored = raw.runMode
        readback = 'ok'
      } else {
        readback = 'invalid:' + String(raw.runMode)
      }
    } catch (e) {
      readback = 'error:' + ((e && (e.errCode || e.message)) || 'unknown')
    }
    note('readback', readback === 'ok', { readback, stored })

    return ok({
      runMode: stored,
      isRelease: stored === 'release',
      persisted: stored === runMode,
      readback,
      steps,
      hint:
        stored === 'release'
          ? '已切到正式版：新生成的码路人可扫开。旧码无需手动删除，下次打开挪车码页会自动重生成。'
          : '已切回体验版：仅体验成员能扫开挪车码'
    })
  },

  /**
   * 读取当前运行模式（供小程序端展示开关状态）
   * ------------------------------------------------------------
   * 读取无需 owner 权限，任何已登录用户都能查；写（setRunMode）才需要车主身份。
   */
  /**
   * 读取运行模式（带自诊断）
   * ------------------------------------------------------------
   * 除了 mode 本身，还回传 source 说明这个值是从哪来的 —— 排查
   * 「明明切了正式版，读回来还是体验版」时，一眼就能分清是
   * 库里没写进去、写进去但字段不合法、还是压根读不到这个集合。
   */
  async getRunMode() {
    const runMode = await getRunMode()

    // 独立再读一次原始文档，只为诊断，不复用上面的缓存/回退逻辑
    let source = 'unknown'
    let rawRunMode = null
    try {
      const doc = await db.collection(COL_SYS).doc('global').get()
      const raw = (doc && doc.data) || null
      if (!raw) {
        source = 'doc-missing' // 集合在，但 global 文档不存在
      } else if (raw.runMode === 'release' || raw.runMode === 'trial') {
        source = 'db'
        rawRunMode = raw.runMode
      } else {
        source = 'db-invalid' // 字段存在但值不合法 → 代码回退成默认 trial
        rawRunMode = raw.runMode === undefined ? null : String(raw.runMode)
      }
    } catch (e) {
      source = 'read-error:' + ((e && (e.errCode || e.message)) || 'unknown')
    }

    // 顺带回传管理员是否已配置，方便在控制台一眼确认（不回传 openid 本身）
    let adminConfigured = false
    try {
      adminConfigured = !!(await getAdminOpenid())
    } catch (e) {
      /* 读不到就当未配置 */
    }

    return ok({
      runMode,
      isRelease: runMode === 'release',
      adminConfigured,
      envVersion: runModeConfig(runMode).envVersion,
      source,
      rawRunMode,
      expect: { collection: COL_SYS, docId: 'global', field: 'runMode' }
    })
  },

  /** 通知记录 */
  async logs({ openid, payload }) {
    const { codeId } = payload
    const carRes = await db
      .collection(COL_CARS)
      .where({ codeId, _openid: openid })
      .limit(1)
      .get()

    if (carRes.data.length === 0) return fail('车辆不存在或无权查看', 403)

    const logs = await db
      .collection(COL_LOGS)
      .where({ codeId })
      .orderBy('createTime', 'desc')
      .limit(50)
      .get()

    return ok({ plate: carRes.data[0].plate, logs: logs.data })
  },

  /** 生成小程序码（已生成过则直接复用） */
  async getWxacode({ openid, payload }) {
    const { codeId } = payload
    const res = await db
      .collection(COL_CARS)
      .where({ codeId, _openid: openid })
      .limit(1)
      .get()

    if (res.data.length === 0) return fail('车辆不存在或无权查看', 403)

    const car = res.data[0]
    // 版本切换（体验版 ↔ 正式版）后旧码扫不开，必须重新生成
    const envVersion = runModeConfig(await getRunMode()).envVersion
    if (car.wxacodeFileID && car.wxacodeEnv === envVersion) {
      return ok({ fileID: car.wxacodeFileID, cached: true })
    }

    // 保护：已经是正式版码，就不再因为运行模式仍是 trial 而降级重生成。
    // 典型场景——审核期间管理员强制出了 release 空白码并已打印贴出，
    // 此时打开码页若重生成 trial 码，会覆盖云存储里同一张图，已贴出的贴纸全部作废。
    if (car.wxacodeFileID && car.wxacodeEnv === 'release' && envVersion === 'trial') {
      return ok({ fileID: car.wxacodeFileID, cached: true, locked: true })
    }

    try {
      // 传旧 fileID：出图成功后删掉旧图，避免同路径覆盖导致 CDN 吐旧版本
      const built = await buildWxacode(codeId, undefined, car.wxacodeFileID)

      await db.collection(COL_CARS).doc(car._id).update({
        data: {
          wxacodeFileID: built.fileID,
          wxacodeEnv: built.envVersion,
          updateTime: Date.now()
        }
      })

      return ok({ fileID: built.fileID, cached: false })
    } catch (err) {
      const code = err.errCode
      let tip = `生成小程序码失败：${err.errMsg || err.message || '未知错误'}`
      if (code === 41030) {
        tip =
          '生成小程序码失败（41030 页面不存在）。请确认云函数里 checkPath 已设为 false；' +
          '若小程序已发布，请把运行模式改成 release（改数据库 sys_config/global.runMode 或调用 setRunMode，无需重部署）。'
      }
      return fail(tip, 500, code)
    }
  },

  /**
   * 干跑自检：不扫码就知道「这张码现在扫了会发生什么」
   * ------------------------------------------------------------
   * 小程序一旦提审，改一个字都要再走一遍审核；而真正的问题（码是体验版、
   * 没绑定、额度为 0、码图版本和运行模式不一致）在扫码前就能全部算出来。
   *
   * 云端测试用法：
   *   {"action":"dryrun","payload":{}}                      → 只做全局环境自检
   *   {"action":"dryrun","payload":{"codeId":"xxxxxxxx"}}   → 单张码完整诊断
   *
   * 返回 verdict 是一句人话结论，直接照做即可，不用解读原始字段。
   */
  async dryrun({ payload }) {
    const { codeId } = payload || {}
    const runMode = await getRunMode()
    const cfg = runModeConfig(runMode)

    let templateReady = false
    let templateTitle = ''
    let templateHint = ''
    try {
      const tpl = await resolveTemplate()
      templateReady = !!tpl
      templateTitle = (tpl && tpl.title) || ''
    } catch (e) {
      templateHint = e.errMsg || e.message || String(e)
    }

    let adminConfigured = false
    try {
      adminConfigured = !!(await getAdminOpenid())
    } catch (e) {
      /* 读不到当未配置 */
    }

    const out = {
      runMode,
      envVersion: cfg.envVersion,
      miniprogramState: cfg.miniprogramState,
      adminConfigured,
      templateReady,
      templateTitle,
      templateHint,
      code: null,
      envMatch: null,
      verdict: ''
    }

    if (!codeId) {
      out.verdict =
        `当前出码版本=${cfg.envVersion}。` +
        (cfg.envVersion === 'release'
          ? '新生成的码是正式版，任何微信用户可扫（前提是小程序已发布）。'
          : '新生成的码是体验版，只有体验成员能扫开 —— 想让路人扫开请切 release。') +
        '带上 codeId 可单独诊断某张码。'
      return ok(out)
    }

    const res = await db.collection(COL_CARS).where({ codeId }).limit(1).get()
    if (res.data.length === 0) {
      out.verdict = `codeId ${codeId} 在数据库里不存在 → 扫码会提示「挪车码无效」。`
      return ok(out)
    }

    const car = res.data[0]
    const bound = car.bound !== false && !!car.plate
    out.code = {
      codeId: car.codeId,
      bound,
      plate: car.plate || '',
      phoneSet: !!car.phone,
      enabled: car.enabled !== false,
      quota: car.quota || 0,
      wxacodeEnv: car.wxacodeEnv || '(未记录)',
      wxacodeFileID: car.wxacodeFileID || ''
    }

    const imgEnv = car.wxacodeEnv || ''
    out.envMatch = imgEnv === cfg.envVersion

    let verdict
    if (!bound) {
      verdict = '空白码（尚未绑定车辆）→ 扫码后引导绑定车辆。'
    } else if (out.code.enabled === false) {
      verdict = '该码已停用 → 扫码会提示车主已关闭通知。'
    } else if (out.code.quota <= 0) {
      verdict =
        '能打开，但通知额度为 0 → 点「通知车主」会失败。请车主进小程序首页授权订阅消息累积额度。'
    } else if (!templateReady) {
      verdict = '能打开，但订阅消息模板未就绪 → 通知发不出去。'
    } else {
      verdict = `正常：绑定了 ${out.code.plate}，剩余额度 ${out.code.quota} 次，扫码可通知车主。`
    }

    if (imgEnv && imgEnv !== cfg.envVersion) {
      verdict +=
        ` ⚠️ 但这张图是「${imgEnv}」版本，当前运行模式要求「${cfg.envVersion}」 → ` +
        '版本不一致，扫出来的不是你期望的那个版本，需要重新生成这张码。'
    }
    if (!car.wxacodeFileID) {
      verdict += ' ⚠️ 这张码还没出过图（wxacodeFileID 为空），需要重新生成。'
    }

    out.verdict = verdict
    return ok(out)
  },

  /**
   * 清理过期数据（由定时触发器调用，不需要前端调用）
   * ------------------------------------------------------------
   * 删除超过保留期的通知记录，兑现隐私政策里的留存承诺。
   *
   * 配置路径：云开发控制台 → 云函数 car → 定时触发器 → 新增
   *   触发周期：自定义 Cron   0 0 3 * * * *（每天凌晨 3 点）
   *   Payload： {"action":"cleanExpired","payload":{}}
   *
   * 单次最多处理 500 条，历史数据多的话首次要连跑几天才追平。
   */
  async cleanExpired() {
    const now = Date.now()
    const logBefore = now - RETENTION.logDays * 86400000
    const result = { logs: 0, rounds: 0 }

    // 删除超过保留期的通知记录
    for (let i = 0; i < 5; i++) {
      const rm = await db
        .collection(COL_LOGS)
        .where({ createTime: _.lt(logBefore) })
        .limit(100)
        .get()

      if (rm.data.length === 0) break
      const ids = rm.data.map((d) => d._id)
      const del = await db
        .collection(COL_LOGS)
        .where({ _id: _.in(ids) })
        .remove()
      result.logs += del.stats ? del.stats.removed : ids.length
      result.rounds++
      if (rm.data.length < 100) break
    }

    return ok(result)
  },

  /**
   * 查看当前生效的通知模板（排查用）
   * 返回模板标题、字段列表和自动映射结果，
   * 可在开发者工具 > 云开发 > 云函数 里用 action=templateInfo 直接调用验证。
   */
  async templateInfo() {
    let tpl = null
    let error = ''
    try {
      tpl = await resolveTemplate()
    } catch (e) {
      error = e.errMsg || e.message || String(e)
    }

    if (!tpl) {
      return ok({
        ready: false,
        templateId: '',
        title: '',
        fields: [],
        dataMap: {},
        source: 'none',
        hint: error
          ? `读取模板失败：${error}。请确认云函数 car 已设置环境变量 MP_APPID / MP_APPSECRET。`
          : '账号下还没有选用的模板。请到公众平台 > 功能 > 订阅消息 > 公共模板库，搜索「挪车」选用一个。'
      })
    }

    return ok({
      ready: true,
      templateId: tpl.templateId,
      title: tpl.title,
      fields: tpl.fields || Object.keys(tpl.dataMap || {}),
      dataMap: tpl.dataMap,
      source: tpl.source
    })
  },

  /**
   * 部署自检（排查用）
   * 不需要打开小程序，在云开发控制台 > 云函数 > car > 云端测试里
   * 填 {"action":"health","payload":{}} 直接运行，一次验完以下事项：
   *   1. 云函数是否部署成功（能返回结果即成功）
   *   2. 两个数据库集合是否存在（不存在会尝试自动创建）
   *   3. openapi 权限是否生效（能否读到订阅消息模板）
   *   4. 当前 RUN_MODE（决定生成的码扫开的是体验版还是正式版）
   *   5. 空白码管理员是否已配置（决定谁能生成空白码）
   */
  async health() {
    const checks = []

    // ---- 1. 数据库集合 ----
    for (const name of [COL_CARS, COL_LOGS]) {
      try {
        await db.collection(name).limit(1).get()
        checks.push({ item: `集合 ${name}`, ok: true, detail: '已存在' })
      } catch (e) {
        // 集合不存在时尝试自动创建，省去手动去控制台新建
        let created = false
        let err = ''
        try {
          await db.createCollection(name)
          created = true
        } catch (e2) {
          err = e2.errMsg || e2.message || String(e2)
        }
        checks.push({
          item: `集合 ${name}`,
          ok: created,
          detail: created
            ? '原本不存在，已自动创建（请到控制台把权限改成「仅管理端可读写」）'
            : `不存在且自动创建失败：${err}。请到云开发控制台 > 数据库 手动新建，名字要一字不差。`
        })
      }
    }

    // ---- 2. 订阅消息模板 + openapi 权限 ----
    let tplReady = false
    let tplDetail = ''
    try {
      const tpl = await resolveTemplate()
      if (tpl) {
        tplReady = true
        tplDetail = `已发现模板「${tpl.title}」(${tpl.source === 'manual' ? '手动指定' : '自动发现'})`
      } else {
        tplDetail =
          '账号下还没有选用的模板。公众平台 > 功能 > 订阅消息 > 公共模板库，搜「挪车」选用一个。'
      }
    } catch (e) {
      tplDetail = `读取失败：${e.errMsg || e.message || String(e)}。请确认云函数 car 的「配置 → 环境变量」已设置 MP_APPID / MP_APPSECRET（AppSecret 在公众平台 → 开发 → 开发设置 获取）。`
    }
    checks.push({ item: '订阅消息模板', ok: tplReady, detail: tplDetail })

    // ---- 3. 运行模式（云端配置项，免重部署） ----
    const runMode = await getRunMode()
    checks.push({
      item: '运行模式',
      ok: true,
      detail:
        runMode === 'release'
          ? 'release：生成的码指向正式版，订阅消息发往正式版'
          : 'trial：生成的码指向体验版（仅体验成员能扫开）。正式发布后请把运行模式改成 release——无需重部署，改数据库 sys_config/global.runMode 或调用 setRunMode 即可。'
    })

    // ---- 4. 空白码管理员配置 ----
    const adminOpenid = await getAdminOpenid()
    checks.push({
      item: '空白码管理员',
      ok: !!adminOpenid,
      detail: adminOpenid
        ? `已配置（${adminOpenid.slice(0, 6)}…），空白码仅该账号可生成`
        : '未配置 sys_config/global.adminOpenid：空白码生成接口未设防，任何人都可调用。请先用 getProfile 拿到你的 openid，填进该字段。'
    })

    const passed = checks.filter((c) => c.ok).length
    return ok({
      allPass: passed === checks.length,
      passed,
      total: checks.length,
      env: cloud.DYNAMIC_CURRENT_ENV ? 'current' : 'unknown',
      runMode: runMode,
      checks
    })
  },

  /**
   * 通知车主（核心）
   */
  async notify({ openid, payload }) {
    const { codeId, message } = payload
    if (!codeId) return fail('缺少码 ID', 400)

    const res = await db.collection(COL_CARS).where({ codeId }).limit(1).get()
    if (res.data.length === 0) return fail('挪车码无效', 404)

    const car = res.data[0]
    const now = Date.now()

    if (!car.enabled) {
      return fail('车主已暂停通知功能，请直接拨打电话', 403)
    }

    // ---- 防骚扰限流 ----
    // 注意：必须限定 type='notify'。日志集合里还有 type='view'（被扫码记录），
    // 若不过滤，用户刚扫完码就会被判定为「已通知过」而无法发送。
    // 1) 同一个扫码人 60 秒内只能通知同一辆车 1 次
    const recent = await db
      .collection(COL_LOGS)
      .where({
        codeId,
        fromOpenid: openid,
        type: 'notify',
        createTime: _.gt(now - 60 * 1000)
      })
      .count()

    if (recent.total > 0) {
      return fail('刚刚已经通知过车主了，请稍等一分钟', 'COOLDOWN', 60)
    }

    // 2) 同一辆车 10 秒内全局只允许 1 次（防并发刷）
    const recentGlobal = await db
      .collection(COL_LOGS)
      .where({
        codeId,
        type: 'notify',
        createTime: _.gt(now - 10 * 1000)
      })
      .count()

    if (recentGlobal.total > 0) {
      return fail('车主刚收到通知，请稍后再试', 'COOLDOWN', 10)
    }

    const text = (message && String(message).trim()) || DEFAULT_MESSAGE

    // ---- 内容安全检测（UGC 必做，审核硬性要求）----
    // 扫码方可自由输入留言 = 用户生成内容，必须先过检再落库 / 推送给车主。
    // 只拦截接口明确判定为违规的内容；检测接口异常时放行，不影响正常挪车。
    if (text && text !== DEFAULT_MESSAGE) {
      const safe = await checkTextSafe(text, openid)
      if (!safe.ok) {
        return fail(safe.reason || '留言包含不当内容，请修改后重试', 'RISKY_CONTENT')
      }
    }

    // ---- 解析统一通知模板 ----
    let tpl = null
    try {
      tpl = await resolveTemplate()
    } catch (e) {
      tpl = null
    }

    if (!tpl || !tpl.templateId) {
      await writeLog({
        codeId,
        fromOpenid: openid,
        type: 'notify',
        status: 'no_template',
        message: text,
      })
      updateLastNotify(car._id, now)
      return ok({
        delivered: false,
        reason: 'no_template',
        message:
          '未找到可用的通知模板。请到公众平台 > 功能 > 订阅消息 > 公共模板库，搜索「挪车」选用任意一个模板后重试。在此之前可直接拨打电话联系车主。'
      })
    }

    if (!car.quota || car.quota <= 0) {
      await writeLog({
        codeId,
        fromOpenid: openid,
        type: 'notify',
        status: 'no_quota',
        message: text,
      })
      updateLastNotify(car._id, now)
      return ok({
        delivered: false,
        reason: 'no_quota',
        message: '车主的微信通知次数已用完，建议直接拨打电话。'
      })
    }

    // ---- 发送订阅消息 ----
    const plateMask = maskPlate(car.plate)
    const data = renderTemplateData(tpl.dataMap, {
      plate: plateMask,
      plateMask,
      message: text,
      time: cnTime(now),
      carModel: car.carModel || '车辆',
      phoneMask: maskPhone(car.phone)
    })

    try {
      const cfg = runModeConfig(await getRunMode())
      await mpSendSubscribe({
        touser: car._openid,
        page: TEMPLATE.page,
        data,
        templateId: tpl.templateId,
        miniprogramState: cfg.miniprogramState
      })

      // 发送成功，扣减额度
      await db.collection(COL_CARS).doc(car._id).update({
        data: { quota: _.inc(-1) }
      })

      await writeLog({
        codeId,
        fromOpenid: openid,
        type: 'notify',
        status: 'sent',
        message: text,
      })
      updateLastNotify(car._id, now)

      return ok({ delivered: true })
    } catch (err) {
      const errCode = err.errCode
      let reason = 'send_failed'
      let tip = '通知发送失败，建议直接拨打电话。'

      if (errCode === 43101) {
        // 用户拒收：通常是额度已耗尽，把额度清零避免持续报错
        reason = 'refused'
        tip = '车主已取消接收该类通知，请直接拨打电话。'
        await db.collection(COL_CARS).doc(car._id).update({ data: { quota: 0 } })
      } else if (errCode === 47003) {
        reason = 'bad_template'
        tip =
          '模板字段有误（47003）。自动模式一般不会出现；若你填了 MANUAL.data，请核对左边字段名是否与所选模板完全一致。'
        // 清缓存，下次重新拉取模板
        tplCache = { at: 0, value: null }
      } else if (errCode === 40037 || errCode === 40036) {
        reason = 'bad_template_id'
        tip = '订阅消息模板 ID 无效，请到公众平台重新选用模板。'
        tplCache = { at: 0, value: null }
      } else if (errCode === 48001) {
        reason = 'api_forbidden'
        tip = '小程序未开通订阅消息能力，请到公众平台检查。'
      }

      await writeLog({
        codeId,
        fromOpenid: openid,
        type: 'notify',
        status: reason,
        message: text,
      })
      updateLastNotify(car._id, now)

      return ok({
        delivered: false,
        reason,
        message: tip,
        detail: err.errMsg || err.message
      })
    }
  }
}

/* 写通知日志（不阻断主流程） */
async function writeLog(row) {
  try {
    await db.collection(COL_LOGS).add({
      data: Object.assign({ createTime: Date.now() }, row)
    })
  } catch (e) {
    /* 日志写失败不影响通知 */
  }
}

function updateLastNotify(docId, ts) {
  db.collection(COL_CARS)
    .doc(docId)
    .update({ data: { lastNotifyTime: ts } })
    .catch(() => {})
}

/* ============================================================
 * 入口
 * ============================================================ */
/**
 * 不需要用户身份（OPENID）的 action 白名单
 * ------------------------------------------------------------
 * 这些调用方拿不到 OPENID，如果被统一鉴权拦掉会直接 401：
 *   health        云开发控制台「云端测试」手动运行
 *   cleanExpired  定时触发器（Cron）自动运行 —— 被拦则过期数据永远清不掉
 *   getRunMode    只读取全局配置，不含任何用户数据
 *   setRunMode    只写全局配置；控制台调用方本身就是管理员，
 *                 比小程序里的「名下有车」校验更强，放行是安全的
 *   dryrun        只读诊断：不扫码就预判某张码扫了会发生什么，
 *                 返回的是结论性文案，不额外暴露车主手机号
 *
 * 放行后即可在云开发控制台 > 云函数 car > 云端测试里直接切运行模式：
 *   {"action":"getRunMode","payload":{}}
 *   {"action":"setRunMode","payload":{"runMode":"release"}}
 * 小程序发布后不用打开 App 就能切成正式版，也不受多实例缓存影响。
 *
 * 除白名单外，其余 action 都必须由小程序端通过 wx.cloud.callFunction 调用。
 */
const NO_AUTH_ACTIONS = ['health', 'cleanExpired', 'getRunMode', 'setRunMode', 'dryrun']

/**
 * 入参容错解析
 * ------------------------------------------------------------
 * 云开发控制台的「云端测试」输入框对 JSON 极其敏感，稍微多一个空格、
 * 引号被输入法/聊天窗口转成中文引号「" "」，就会在发送前直接报
 * 「内容不是合法的json」——此时云函数压根没被调用。
 *
 * 所以这里做三层兜底，让你能尽量少打字：
 *   1) event 是字符串（可能被二次序列化过）→ 尝试 JSON.parse，
 *      失败就把它本身当成 action 名（`health` 也能直接跑）
 *   2) action 缺失 / 空 / 非字符串 → 默认 health（自检）
 *   3) 定时触发器（Type === 'Timer'）→ 未显式指定时默认 cleanExpired
 *
 * 结果：测试框里填 `{}` 、留空、甚至手写 `health`，都能跑出自检结果。
 */
function normalizeEvent(event) {
  let raw = event

  if (typeof raw === 'string') {
    const text = raw.trim()
    try {
      raw = JSON.parse(text)
    } catch (e) {
      // 不是 JSON，就当它是 action 名；空串走默认
      raw = text ? { action: text } : {}
    }
  }

  if (!raw || typeof raw !== 'object') raw = {}

  let action = raw.action
  if (typeof action === 'string') action = action.trim()

  // 定时触发器：{ Type: 'Timer', TriggerName, Time }
  const isTimer = raw.Type === 'Timer' || raw.type === 'Timer'

  if (!action) action = isTimer ? 'cleanExpired' : 'health'

  let payload = raw.payload
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch (e) {
      payload = {}
    }
  }
  if (!payload || typeof payload !== 'object') payload = {}

  return { action, payload, isTimer }
}

exports.main = async (event) => {
  const { action, payload } = normalizeEvent(event)
  const wxCtx = cloud.getWXContext()
  const openid = wxCtx.OPENID

  const handler = actions[action]
  if (!handler) {
    return fail(`未知的 action：${action}。可用：${Object.keys(actions).join(', ')}`, 404)
  }

  if (!openid && NO_AUTH_ACTIONS.indexOf(action) === -1) {
    return fail(
      `action「${action}」需要用户身份，请用小程序端的 wx.cloud.callFunction 调用；` +
      `控制台可直调的只有：${NO_AUTH_ACTIONS.join(', ')}`,
      401
    )
  }

  try {
    return await handler({ openid, payload })
  } catch (err) {
    return fail(err.errMsg || err.message || '服务端异常', 500, err.errCode)
  }
}
