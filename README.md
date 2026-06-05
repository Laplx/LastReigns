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

> 没有 key 也能玩：游戏会进入**离线模式**，用预设叙事兜底，流程完整。

---

## 玩法

每年三个阶段：**预算分配 → 1–3 张事件卡 → 年终述职**。其间：

- **五条核心指标**（军队/精英/国际/民众/健康）只以氛围词呈现，没有数字、没有进度条。
- **关键人物**（每局随机 4 人）只显示忠诚信号色。点击可**私下交谈**——你能向他下达自然语言命令，但他**未必照办**：忠诚越低，越可能打折、阳奉阴违、乃至背刺（背刺前必有可回味的线索）。
- **事件链**最多同时激活 2 条（继承人 / 北方叛乱 / 边境危机 / 民主压力 / 宫廷内斗），连续拖延会自动恶化。
- **装饰指标**（经济/医疗/教育/市政/国家队/舆论）只是干扰与讽刺，不进结算。
- 健康逐年衰减，决策会加速或减缓。撑到自然死亡是最高荣誉结局。
- 死后由 LLM 生成"维基式"身后评价（生前出资设立传记委员会，可解锁一份溢美的"官方认可版"），积分在此揭晓。

---

## 结构

```
index.html  styles.css  server.js  package.json  .env.local(gitignored)
src/   game.js engine.js events.js chains.js llm.js ui.js atmosphere.js state.js
data/  events.json people.json chains.json atmosphere.json decorative.json
```

- `engine.js` 是状态的**唯一真相来源**：所有数值变动都在此钳制。
- `llm.js` **永不直接写状态**，只返回受约束结构，交给 engine 校验+钳制后落账。

---

## 安全提示

`.env.local` 已被 `.gitignore` 排除。若要分享项目或部署"分享版后端"，请先在 DeepSeek 后台**轮换 key**。
