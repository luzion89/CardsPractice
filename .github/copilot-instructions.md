- [x] Verify that the copilot-instructions.md file in the .github directory is created.

- [x] Clarify Project Requirements
  已按用户要求明确：React + TypeScript + Vite PWA，主题为掼蛋记牌训练，包含完整牌局回放、challenge、随机新局与 GitHub Actions 部署。

- [x] Scaffold the Project
  已创建并安装 Vite React TypeScript 工程。

- [x] Customize the Project
  已实现掼蛋规则引擎、四家 AI 出牌、逐手回放、题库挑战、训练统计、PWA 配置与视觉界面。

- [x] Install Required Extensions
  无需额外扩展。

- [x] Compile the Project
  `npm run build` 通过，`npm run lint` 通过。

- [x] Create and Run Task
  已创建并运行 VS Code 任务：`构建 PWA 应用`。

- [x] Launch the Project
  跳过。用户未要求进入调试启动流程。

- [x] Ensure Documentation is Complete
  README.md 与本文件已更新，HTML 注释已清理。

- [x] Establish Update Validation Workflow
  已建立 `docs/post-update-checklist.md` 作为每次改动后的人工检查清单，并新增 `npm run check:update` 用于执行 `test + build + lint`。

- 后续新增需求、交互改动、AI 逻辑修订时，必须同步更新 `docs/post-update-checklist.md`。
- 每次实际代码改动后，必须先执行 `npm run check:update`，再按 `docs/post-update-checklist.md` 完成人工检查。
- 若检查中发现问题，必须修复后重新执行完整检查流程。
- 每次对话收尾时，如本轮产生了仓库文件改动，必须先完整走完 `npm run check:update` 与 `docs/post-update-checklist.md`，确认通过后再提交并 push 到 `main`，让 GitHub Actions 自动部署。
- 若本轮没有任何文件改动，则无需 push，但仍需明确说明本轮无变更可同步。
- 若 push 失败，必须继续排查认证或网络问题；只有在确认无法继续自动处理时，才向用户说明阻塞原因。

- 当前构建命令：`npm run build`
- 当前更新校验命令：`npm run check:update`
- 当前部署方式：push 到 `main` 后由 GitHub Actions 自动部署到 GitHub Pages
- 当前项目根目录：`.`