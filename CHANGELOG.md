# 更新日志

本项目的所有重要变更都会记录在此。

格式基于 [Keep a Changelog](https://keepachangelog.com/)。

## [1.0.0] - 2026-09-01

### 新增
- DNS 服务器（UDP 53）拦截指定域名
- HTTPS 反向代理（TCP 443）+ TLS 终止
- WebSocket 升级代理
- 看门狗自动崩溃恢复
- 热点状态监控与自动重启
- 静默后台模式（计划任务）
- 每分钟恢复任务作为备用看门狗
- 开机自启动安装/卸载脚本
- 可配置拦截域名
- 防火墙规则自动管理
- 优雅停止与完整清理

## [Unreleased]

### 新增
- 9110 静态阅读器页面服务（`web-server.js`，PM2 `captive-web` 托管）
- 全屏 iframe 隐形跳转：`t<端口>-<主机>` 跳转子域按 SNI 反代回原站，并剥掉
  `X-Frame-Options` / CSP `frame-ancestors`，解决 https 页面嵌 http 目标的混合内容拦截
- 跳转 HTML 中注入的 `window.__WS_PORT__` 改写为 `443`，WebSocket 升级经 443 反代、
  端口回退 `+1000`（ClassIntra 9001 → 10001），iframe 内实时功能可用

### 修复
- 阅读器跳转在切网后失效：点击时先探测是否仍在热点内——在则走跳转子域全屏 iframe，
  已切网则全屏 iframe 直接内嵌原始地址，并把 nip.io 域名就地换成字面 IP（不再依赖公网 DNS）。
  原先切网后跳转子域被公网 DNS 解析到真实服务器返回 403，整页直接跳转在 WebView 里
  报「网络异常」；iframe 直嵌要求目标站允许被嵌（ClassIntra 服务端已关闭 X-Frame-Options）
- 改为单一常驻看门狗，避免恢复任务重复启动多个实例
- 增加启动冷却和项目进程精确匹配，避免进程风暴
- 移除隐藏任务中对 `timeout /t` 的依赖
- 启动热点失败时不再继续启动代理
- 保留 `SharedAccess` 的恢复逻辑，降低热点异常风险
