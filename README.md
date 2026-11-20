# Claude Desktop CN

Windows 端 Claude Desktop 汉化与增强工具：界面中文化、反风控守护、升级后自动恢复汉化。

> ⚠️ 本工具通过修改 Claude Desktop 本地安装文件实现汉化，仅供个人学习研究使用。请遵守 Anthropic 服务条款。不修改任何网络请求内容，不上传任何数据。

## 功能

- **界面汉化**：32,000+ 词条（设置页、Claude Code 设置、模型描述、推理供应商提示等全覆盖）
- **原生菜单汉化**：主菜单与右键菜单 681 条词典
- **反风控守护**：四档限流（分钟/小时/日/会话轮数）、429/403/5xx 中文提示、大文本粘贴提醒
- **MSIX 注入支持**：完整支持新版 Claude Desktop（WindowsApps 打包），追加式改写绕过完整性校验（不修改 fuse）
- **自动守护**：计划任务（每小时+登录时）检测 Claude 升级并自动重注入，无常驻进程
- **下载自动识别**：新版本安装包自动下载到旧版安装包所在目录，所有版本集中存放
- **三重回滚保障**：备份逐字节校验 + rollback.json 元数据 + 回滚双校验，一键恢复官方原包

## 系统要求

- Windows 10/11（x64）
- Node.js >= 16
- 已安装 Claude Desktop（MSIX 或 Squirrel 直装版均可自动识别）

## 使用

```bash
cd installer
npm install
node index.js status        # 查看检测状态
node index.js install-msix  # MSIX 版注入（需管理员，自动备份可回滚）
# Squirrel 直装版：
node index.js install
```

GUI 启动器见 `launcher/`（构建产物为单文件 ClaudeDesktopCN.exe）。

## 平台支持

当前版本仅支持 Windows。其他平台可参考本项目的词典资源（payload/src/i18n.js，32,000+ 条）自行适配。
## 自动守护说明

Claude 自动升级会替换整个安装包（MSIX 由系统 AppXSvc 处理），注入内容随旧包消失——这是所有本地注入方案的共同边界。本工具通过计划任务（每小时+登录时）自动检测升级并重注入，升级后最迟 1 小时内自动恢复汉化，无常驻进程。

## 卸载

```bash
node index.js uninstall-msix   # 或 uninstall
```

一键还原官方原包（自动校验）。

## 免责声明

本工具与 Anthropic 无关。使用本工具产生的任何账号风险由使用者自行承担。