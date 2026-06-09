# Aliy Agent

上传到 GitHub 的阿里云本地优先运维 Agent 项目。

Aliy Agent 是一个基于 Electron、React、TypeScript 和 OpenAI Agents SDK 的桌面端运维助手。项目目标是在本地完成工作空间索引、阿里云 OpenAPI 元数据检索、Profile 凭证隔离、人工核签、安全网关调用和审计记录，帮助运维人员以可追溯、可确认的方式执行云资源操作。

## 功能概览

- 本地优先的 Electron 桌面应用，业务文档、会话、审计和凭证状态保存在本机。
- 支持多 Workspace、多 Profile、多 Session 的运维上下文隔离。
- 使用 OpenAI Agents SDK 编排对话、工具调用和人工审批流程。
- 内置阿里云 OpenAPI Catalog 元数据，用于接口发现、参数校验、危险等级判断和别名纠偏。
- 统一 OpenAPI Gateway 负责调用前校验、人工核签、执行结果归档和失败回灌。
- 支持全局技能、会话技能、长效记忆候选、定时任务和本地审计日志。

## 技术栈

- Electron + electron-vite
- React + TypeScript
- OpenAI Agents SDK
- better-sqlite3 / SQLite FTS5
- Alibaba Cloud OpenAPI SDK
- Vitest

## 快速开始

```bash
npm install
npm run dev
```

## 常用命令

```bash
npm run dev          # 启动桌面端开发环境
npm run build        # TypeScript 检查并构建 Electron 应用
npm run test         # 运行测试
npm run typecheck    # 仅执行类型检查
```

## 项目结构

```text
src/main/           Electron 主进程、数据库、Agent 服务和 OpenAPI 网关
src/preload/        Renderer 与主进程之间的安全 IPC 桥
src/renderer/       React 桌面界面
src/shared/         前后端共享类型
catalog-meta/       阿里云 OpenAPI Catalog 元数据
docs/               产品说明、系统设计和安全网关文档
scripts/            元数据抓取和调试脚本
```

## 本地数据与安全

本项目默认不提交运行时数据。`.gitignore` 已排除 `node_modules/`、构建产物、本地数据库、`.aliy-agent/`、`.claude/` 和一次性输出目录。阿里云 AK、OpenAI API Key、会话数据库和本地工作空间内容应只保存在本机环境中，不应提交到仓库。

更多设计细节见：

- [docs/system-design.md](docs/system-design.md)
- [docs/main.md](docs/main.md)
- [docs/Security.md](docs/Security.md)
