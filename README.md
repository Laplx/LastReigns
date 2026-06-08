# 最后的统治者 · The Last Reigns

一款基于《独裁者手册》的讽刺向政治模拟网页游戏。你是中非虚构小国**恩加拉共和国**刚刚政变上台的独裁者，目标是：**统治得久、捞得多、死在自己的床上**——分数越高越好。

> 核心讽刺不仅是该书"维系最小关键联盟"的冷酷逻辑，更是两难与平衡的政治艺术。
> 所有数字全程隐藏，只有氛围词；积分只在你死后揭晓。

设计全文见 [`SPEC.md`](./SPEC.md)。

---

## 运行

需要 Node ≥ 18。

```bash
# 1. 配置密钥（已为你生成 .env.local；换 key 改这里）
#    LLM_API_KEY / LLM_BASE_URL / LLM_MODEL

# 2. 启动
npm start

# 3. 打开
#    http://localhost:5173
```

启动脚本是一个**零依赖 Node dev server**（`server.js`）：
- 托管前端静态文件（ES modules + JSON，无需构建）。
- 反向代理 `POST /api/llm` 到 DeepSeek（OpenAI 兼容），**API key 只留在服务端**，不进浏览器。

> 没有 key 也能玩：游戏会进入**离线模式**，用预设叙事与规则版顾问兜底，流程完整。

---

## 玩法

每年三个阶段：**预算分配 → 1–3 张事件卡 → 年终述职**。其间：

- **六个核心指标**（军队/精英/民心/国际/财政/健康）只以氛围词呈现，没有数字、没有进度条；其中军队、精英、民心、国际都是两端危险。
- **关键人物**（每局随机 4 人）只显示忠诚信号色。点击可**私下接触**并选择行动——他**未必照办**：忠诚越低，越可能打折、阳奉阴违、乃至背刺（背刺前必有可回味的线索）。
- **事件链**共 20 条、每条 4–8 个节点，平均约 5–6 个事件；最多同时激活 2 条，每年最多推进 2 条链节点，连续拖延会自动恶化。
- **事件分层**按在位年份抽取：早期 1–7 年、中期 4–24 年、晚期 15 年后；危机或健康恶化会提前唤起晚期事件，也有低概率越期抽取。
- **主题冷却**会避免 NGO、矿区、宫廷举报、观察团、雕像、医院剪彩等相近主题几年内反复出现。
- **装饰通知卡**扩展为 30 张，只做讽刺、氛围与装饰/历史暗示，不直接改核心指标。
- 健康逐年衰减，决策会加速或减缓。撑到自然死亡是最高荣誉结局。
- 死后由 LLM 生成"维基式"身后评价（生前出资设立传记委员会，可解锁一份溢美的"官方认可版"），积分在此揭晓。

---

## 结构

```
index.html  styles.css  server.js  package.json  .env.local(gitignored)
src/   game.js engine.js events.js chains.js llm.js ui.js atmosphere.js state.js portraits.js
data/  events.json people.json portraits.json portraits-art.json chains.json atmosphere.json decorative.json
scripts/validate-data.mjs
```

- `engine.js` 是状态的**唯一真相来源**：所有数值变动都在此钳制。
- `llm.js` **永不直接写状态**，只返回受约束结构，交给 engine 校验+钳制后落账。
- `scripts/validate-data.mjs` 校验事件数量、主题、阶段、通知卡核心效果、事件链深度与跳转可达性。

### 人物画像

运行时只读 `data/portraits-art.json`（22 个 Open Peeps 半身像 + 22 个 Lucide 职业 icon 打包，离线可用）。要重建或更换画像/icon：

```
node scripts/fetch-peeps.mjs   # 按角色配置拉取 Open Peeps 半身像 → data/portraits-op/
node scripts/fetch-icons.mjs   # 按角色映射拉取 Lucide 职业 icon → data/icons/
node scripts/pack-art.mjs      # 打包上述源文件 → data/portraits-art.json
```

改角色的部件（发型/表情/胡子/眼镜）在 `fetch-peeps.mjs`、换职业 icon 在 `fetch-icons.mjs`，改后重新 `fetch` + `pack` 即可。素材许可：Open Peeps（CC0）、Lucide（ISC）。

### 发版流程

每次发布新版本，按顺序：

1. 改 `package.json` 的 `version`，并同步 `src/game.js` 里 `VERSION_TAG` 显示的版本号。
2. 在 `CHANGELOG.md` 顶部新增该版本条目（遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/)）。
3. `node scripts/stamp-version.mjs` —— 给 `index.html` 入口引用与 `src/*.js` 的相对 import 统一打上 `?v=<版本>`，破除浏览器对旧模块/样式的缓存。**漏掉这步用户会卡在旧缓存。**
4. `node scripts/validate-data.mjs` 校验数据。
5. 提交、推送、发布。

### 部署到 GitHub Pages（无后端）

纯静态托管即可（无需 `server.js`）。注意：

- 发布版**不内置任何 API**。玩家需在「设置」里填自己的 LLM 密钥；有密钥时浏览器**直连服务商**，密钥只存在玩家本机的 localStorage，不上传。无密钥则进入离线模式，游戏完整可玩。
- 部分服务商（如 OpenAI 官方端点）会因浏览器 CORS 限制无法直连；DeepSeek 等兼容接口通常可用。
- `.env.local`（本地开发用的密钥）已被 `.gitignore` 排除，不会进仓库。

---

## 安全提示

`.env.local` 已被 `.gitignore` 排除。若要分享项目或部署"分享版后端"，请先在 DeepSeek 后台**轮换 key**。
