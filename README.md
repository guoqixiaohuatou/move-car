# 🚗 挪车助手小程序

扫码 → 微信通知车主 / 一键拨号。基于**微信云开发 + 原生小程序**，个人主体可跑，自用场景零成本。

## 二次开发先改这 3 处

1. `project.config.json` → `appid`：换成你自己的小程序 AppID
2. `miniprogram/config.js` → `CLOUD_ENV`：换成你的云开发环境 ID
3. 云函数 `car` →「配置 → 环境变量」填 `MP_APPID` / `MP_APPSECRET`

AppSecret 一律走云函数环境变量，**不写在代码里**，仓库无任何密钥泄露风险。

## 四条硬约束

| 约束 | 本项目的处理 |
|---|---|
| 体验版路人扫不开 | 挪车码必须走**正式发布版** |
| 上线必须先 ICP 备案（个人免费） | 注册完立刻提交，它是流程里最慢的一步 |
| 个人主体拿不到手机号 | 车主**手输**手机号，不做一键授权 |
| 订阅消息是「一次性」的 | 做**额度累积**：每次进小程序补授权并累加 |

## 项目结构

```
move-car/
├── project.config.json          # 项目配置（需填 appid）
├── miniprogram/
│   ├── config.js                # ★ 需填：云环境 ID（模板 ID 可留空，自动发现）
│   ├── app.js / app.json / app.wxss
│   ├── utils/util.js            # 脱敏、时间、校验
│   └── pages/
│       ├── home/                # 车主端：我的挪车码列表
│       ├── admin/               # ★ 管理后台：全量码管理（仅管理员）
│       ├── edit/                # 添加 / 编辑车辆
│       ├── code/                # 展示 + 保存小程序码（含「发测试通知」自助排查）
│       ├── notify/              # ★ 扫码方落地页（核心）
│       ├── logs/                # 通知记录
│       └── policy/              # 隐私政策（合规必备）
└── cloudfunctions/
    └── car/                     # 单一云函数，按 action 路由
        ├── index.js             # 模板自动发现；MANUAL 可手动指定
        │                        # RETENTION = 数据保留期；cleanExpired = 定时清理
        ├── package.json
        └── config.json          # openapi 权限声明 + 定时触发器
```

## 部署要点

1. 微信开发者工具导入项目（填自己的 AppID），开通云开发并复制**环境 ID** 填进 `miniprogram/config.js`
2. 云开发控制台创建两个集合：`car_codes`（车辆与挪车码）、`notify_logs`（通知 + 被扫码记录），权限都设「仅管理端可读写」
3. 右键 `cloudfunctions/car` →「上传并部署：云端安装依赖」
4. 给云函数 `car` 配置环境变量 `MP_APPID` / `MP_APPSECRET`，保存后**重新部署一次**
5. `cloudfunctions/car/config.json` 已声明定时触发器（每天凌晨清理过期数据），随部署自动创建
6. 公众平台 →「功能」→「订阅消息」→ 公共模板库搜索「挪车」选用一个模板（字段建议：车牌号 + 内容 + 时间），云函数会自动发现
7. 公众平台 →「设置」→「服务内容声明」→ 配置隐私保护指引（手机号 / 相册写入 / 剪切板），否则真机保存图片会静默失败

> 云函数已用 **AppID + AppSecret 直连微信标准 HTTP 接口**，不再依赖 `cloud.openapi`（避免坏链路 `INVALID_WX_ACCESS_TOKEN`）。

## 配置速查

| 文件 | 配置项 | 必填 |
|---|---|---|
| `project.config.json` | `appid` | ✅ |
| `miniprogram/config.js` | `CLOUD_ENV` | ✅（仅一个环境可留空） |
| `miniprogram/config.js` | `TEMPLATE_ID` | 选填，留空＝自动发现 |
| `miniprogram/config.js` | `SHOW_PLAIN_PHONE` | 选填，默认 `true`（**公开上线务必改 `false`**） |
| `pages/policy/policy.js` | `logRetentionDays` | ✅ 须与云函数 `RETENTION` 一致 |
| `cloudfunctions/car/index.js` | `MANUAL.templateId` | 选填，留空＝自动发现 |
| `cloudfunctions/car/index.js` | `RETENTION` | ✅ 与 policy.js 一致 |

运行模式（trial / release）由云端 `sys_config/global.runMode` 控制，无需改代码重部署；切换后云函数自动刷新缓存。

## 常见问题排查

| 现象 | 原因 / 解决 |
|---|---|
| 首页提示「未找到可用的通知模板」 | 公众平台还没选用模板 |
| `47003` 参数错误 | 字段值不合法（如 `car_number` 收到脱敏车牌 `京A****5`）。代码已内置双保险：给模板传**完整**车牌/手机号，且 `sanitizeValue()` 按字段类型剔除非法字符。仍报错跑 `{"action":"templateInspect"}` 看 `valueAudit` |
| `43101` 用户拒收 | 额度耗尽或车主取消授权，车主重新进小程序补授权 |
| `48001` | 未开通订阅消息能力 |
| 自己扫得开、别人扫「无权限访问」 | 扫的是体验版码。发布正式版并切 `release` |
| 发布后码仍扫不开 | ①「线上版本」有版本号；②运行模式切 `release`；③删旧车重新生成码 |
| 云端测试 `{"action":"getRunMode"}` 报 401 | 云函数还是旧版，重新部署 `car` |
| 保存图片点了没反应 | 隐私保护指引未配或未生效 |

> 控制台可直调的免登录 action：`health` / `cleanExpired` / `getRunMode` / `setRunMode` / `dryrun` / `templateInspect` / `notifyLogs`。其余 action 必须由小程序端 `wx.cloud.callFunction` 调用。

## 合规红线（个人主体）

1. 禁止虚拟号 / 中转呼叫 / 短信通知 —— 只用订阅消息 + `wx.makePhoneCall`
2. 手机号不强制必填（最小必要）
3. 必须配置隐私政策
4. 禁用交警 / 交管 / 官方挪车等政务词
5. 不得售卖挪车码、不得付费会员
