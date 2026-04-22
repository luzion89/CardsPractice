# 掼蛋记牌实验室

一个面向掼蛋记牌训练的 PWA 应用。支持三种模式：

- **AI 实时对局模式**：通过 OpenRouter API 驱动四个独立 AI 代理逐手出牌，生成更接近真人风格的牌谱。
- **本地策略对局模式**：由本地策略会话逐手决策，实时推进完整牌局，方便直接在 app 里验证策略效果。
- **本地预生成模式**：使用启发式引擎一次性生成完整合法牌局。

用户通过逐手回放和按轮检索 challenge 训练以下能力：

- 记住上一轮各家出了什么牌型
- 判断 A、K、级牌、大小王与逢人配的剩余数量
- 在更高难度下复述最近三轮具体内容，并回答任意点数牌剩余数量

## 当前实现

- 两副牌、四家、27 张/家
- 随机级牌、随机先手
- AI 模式：OpenRouter API（默认 minimax/minimax-m2.7）逐手生成策略决策，由本地枚举合法动作后交给 AI 选择
- AI prompt 现在会提交绝对座位 seatId、team、relationToYou 等结构化轮次信息，并把当前全部合法动作编码成 actionId 选项，减少误判敌我、误压搭档和自造非法牌组
- AI 请求优先使用 structured output + response-healing 约束 JSON 返回；请求失败会后台自动重试 3 次
- 本地模式：完整预生成回放，启发式策略出牌
- 逢人配、顺子、三连对、钢板、三带二、同点炸、同花顺、天王炸
- 上一步 / 下一步回看、每轮必答 challenge、答题统计
- 入门难度在开局发牌后会给出“牌面引导”，直接高亮场外大小王、级牌、逢人配、A、K 的余量
- 入门难度题目已收紧为大牌计数题，不再混入“谁收轮 / 上轮牌型”类问题
- 本家手牌按展示规则固定排序：大小王 -> 级牌 -> 其余牌（从大到小）
- 本家手牌保留重叠铺开显示，并按容器宽度自动压缩间距，默认无需横向拖动即可查看整手牌
- 级牌信息固定显示在牌桌左上角；本家 AI 出牌理由仅在本家出牌后显示于手牌栏
- 设置中新增调试模式；开启后可查看四家最近一次可见 AI 出牌理由，方便排查 prompt 与座位理解
- AI 设置区支持“检测连通性”按钮（校验 API Key 与模型可达性）
- 本地策略模式已接入 GameManager，可像 AI 模式一样逐手推进，并在本家与调试监视器中显示结构化策略理由
- 本地策略规则已整理成结构化策略文件，便于后续人工修改与持续迭代
- 本地策略研发已新增“手数估计 + 连续控场压力 + 结构化模拟诊断”闭环，审计报告会保存到本地忽略目录 `debug/strategy-audits/`
- 已补充“人工构造牌局”场景测试，用固定手牌验证不过冲、不抢搭档、不过早交控制牌等策略约束
- 本地持久化当前局面与训练数据
- manifest + service worker 构成可安装 PWA
- 增强版简约像素风：更高可读性字号、复古网格背景、块状控件与绿色牌桌界面，响应式适配不同屏幕

## AI 调用可见性说明

如果你在浏览器 F12 的 Network 面板里查看请求，AI 模式下每点击一次“下一步”，都会触发一次 OpenRouter 请求：

- 请求地址：`https://openrouter.ai/api/v1/chat/completions`
- 触发时机：牌局已在 AI 模式启动，且当前步骤推进时

另外，登录页与设置弹窗都提供了“检测连通性”按钮，会调用 OpenRouter 的模型列表接口进行连通性验证。

AI 模式的交互细节也做了两项修正：

- 开局时不会再因为“0 个动作”被错误判定为“本局已结束”。
- 如果用户点了“上一步”，再次点“下一步”会优先回放已生成但暂时隐藏的动作，而不是直接再请求一手新的 AI 出牌。
- AI 每次请求都会携带结构化轮次数据，标明绝对座位、队伍归属、领出方和敌我关系，并在 prompt 中强调“默认不要压搭档，除非是在送搭档、阻断对手或连续走牌”。
- AI 出牌请求会优先要求 strict JSON，并启用 response-healing；若模型或路由不支持，再自动回退到普通文本解析链路。
- AI 现在优先返回 actionId 而不是直接拼牌码；只要 actionId 合法，本地就能稳定落地对应动作。
- AI 看到的 legalActions 不再是“所有合法动作的平铺列表”，而是先经过本地稳健策略筛选与排序：会优先保留不拆天然炸弹、不随意拆顺子/连对/钢板的候选，再交给模型从中选 actionId。
- 若当前主模型连续不按 structured output 返回，或在上游 provider 上限流/失败，系统会自动切到 JSON 服从度更高的备用模型继续这一手，优先保证“由 AI 决策”而不是直接落本地兜底。
- “下一步”现在有同步锁保护，连续快点不会并发触发多次同手请求，减少重复请求导致的限流与状态错乱。
- AI 出牌信息获取失败时会后台自动重试 3 次；网络、鉴权、限流这类请求错误仍会向前端报错。
- AI 返回内容前即使夹带前置空行、说明文字、外层字符串、function_call.arguments 或 code fence，系统也会继续提取首个有效 JSON 对象。
- 若 AI 连续返回不可解析内容，系统会改用本地最小合法决策继续牌局，并把兜底原因写入本手理由。
- 当前 prompt 只保留最近两轮结构化牌史，且出牌回复只需返回 actionId + 简短理由，以降低截断率和响应时延。
- 调试模式下若发生格式兜底，理由会带上最近一次解析失败摘要，方便定位上游返回形态。
- 牌桌中心“正在思考”文案现在会跟随真实行动位，不再错误显示为当前压桌方。

## 界面方向与参考结论

本项目当前采用“俱乐部牌桌 + 训练台账”方向，而不是完全照搬商业掼蛋大厅。调研了腾讯大掼蛋、同城游掼蛋、微乐/多乐/单机掼蛋等公开截图后，可以归纳出几个稳定规律：

- 视觉焦点永远是中央牌桌，玩家信息贴在四边，功能按钮沿桌边分布。
- 商业产品大量使用金属边框、暖金按钮、绿色或蓝色台面，以及高对比的出牌提示字样。
- 真正的“易读性”不来自把所有信息都放在台面上，而是把统计、社交、任务之类信息收纳到边缘或弹层。

当前实现吸收了这些规律，但刻意不引入大厅、商城、任务、养成等噪音，只保留服务记牌训练的结构。

## 牌面资源结论

当前项目默认使用本地 SVG 组件实时绘制牌面，原因是：

- 不依赖第三方 CDN，PWA 离线更稳。
- 两副牌复用同一套矢量模板即可，不需要维护大批静态资源映射。
- 可以直接高亮级牌和逢人配，方便训练语义表达。

如果后续想升级为更接近商业产品的真实牌面资源，当前调研中较可用的一条路线是：

- hayeah/playing-cards-assets：仓库自身为 MIT，README 说明牌面源自 vector-playing-cards 公共领域素材，包含 SVG 与 PNG，适合映射 54 张标准牌面。

更完整的设计理念、引擎方案、策略逻辑与“启发式生成 vs 真实对局记录”的对比评估见 [docs/product-plan.md](docs/product-plan.md)。

## 开发命令

```bash
npm install
npm run test
npm run dev
npm run build
npm run lint
npm run audit:strategy
npm run audit:strategy:quick
npm run check:update
```

其中：

- `npm run test`：运行逻辑单元测试
- `npm run audit:strategy`：运行 60 局本地策略结构化审计，并写入 `debug/strategy-audits/latest.json`
- `npm run audit:strategy:quick`：运行较小样本的快速策略审计
- `npm run check:update`：执行项目 post-update 自动检查（test + build + lint）

完整测试策略与每次改动后必须执行的 checklist 见 [docs/post-update-checklist.md](docs/post-update-checklist.md)。

本地策略优先级、公开资料提炼结果、20 局模拟闭环以及书籍内容的推荐输入格式见 [docs/guandan-strategy-plan.md](docs/guandan-strategy-plan.md)。

## GitHub Actions 部署

仓库已预置 GitHub Pages 工作流：push 到 `main` 后会自动构建并部署 `dist`。

首次接线时需要完成以下动作：

1. 在 GitHub 上创建仓库并把本地仓库推上去。
2. 在仓库设置中启用 GitHub Pages，并选择 `GitHub Actions` 作为来源。
3. 后续每次 `git push origin main`，Actions 都会自动部署。

## 使用 Git Credential Manager 同步 GitHub

如果你使用 HTTPS 远端地址，建议用 Git Credential Manager（GCM）管理登录态，避免每次推送重复输密码。

首次配置（本机一次即可）：

1. `git config --global credential.helper manager-core`
2. `git credential-manager configure`

确认当前 helper：

- `git config --global credential.helper`

同步到 GitHub：

1. `git add -A`
2. `git commit -m "你的提交说明"`
3. `git push origin main`

说明：首次 push 时，GCM 会引导完成 GitHub 登录（浏览器或设备码流程），之后会复用本地凭据。

说明：本地代码“自动同步到 GitHub”这件事本身不能只靠仓库文件完成，因为它依赖你本机的 Git 凭据与远端仓库地址。当前项目已经把“推送后自动部署”配置好；一旦远端仓库绑定完成，部署链路就会自动运行。

## 规则说明

当前版本聚焦单局内的记牌训练，因此没有实现跨局升级、进贡和报牌交互；但单局内出牌合法性、炸弹层级和轮转规则已按掼蛋训练场景实现。

更详细的产品与实现描述见 [docs/product-plan.md](docs/product-plan.md)。
