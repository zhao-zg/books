---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '76adc568-13c2-47f3-97d2-4d1e91cf8c67'
  PropagateID: '76adc568-13c2-47f3-97d2-4d1e91cf8c67'
  ReservedCode1: '3b5a9e91-d57c-4297-99e0-a97a9753dc59'
  ReservedCode2: '3b5a9e91-d57c-4297-99e0-a97a9753dc59'
---

# 多账户容灾部署指南

## 架构概览

本项目支持同时部署到多个 Cloudflare 账户（最多 20 个），实现容灾互备：

```
prepare ──→ 扫描 Secrets → 生成部署 matrix
构建(build) ──┬── 账户1 部署
              ├── 账户2 部署
              ├── 账户3..N 部署
              ├── GitHub Pages
              └── Artifacts 上传
```

- **prepare 阶段**：扫描 GitHub Secrets 自动发现账户，动态生成 matrix
- **构建阶段**只执行一次，产物共享给所有部署任务
- **Cloudflare 部署**通过动态 matrix 并行，`fail-fast: false`
- **域名绑定**在 Cloudflare 控制台手动操作，不在 CI 中自动绑定

## 添加新账户（只需设 Secrets）

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID_3 --body "你的AccountID"
gh secret set CLOUDFLARE_API_TOKEN_3 --body "你的APIToken"
```

完成。deploy.yml 零改动，prepare job 自动发现新账户。

添加域名后，同步更新：
- `config.yaml` → `remote_servers.cloudflare`：添加前端镜像源
- `worker-get/worker.js` → `FALLBACK_BASES`：添加 Worker 备用源

## GitHub Secrets 命名规范

| 账户 | Account ID | API Token |
|------|-----------|-----------|
| 账户1 | `CLOUDFLARE_ACCOUNT_ID` | `CLOUDFLARE_API_TOKEN` |
| 账户N | `CLOUDFLARE_ACCOUNT_ID_N` | `CLOUDFLARE_API_TOKEN_N` |

- 账户1 无数字后缀（向后兼容）
- 账户2..20 带数字后缀
- prepare job 自动扫描 1..20 槽位，只对已设置的 Secrets 生成部署任务

## 文件清单

| 文件 | 作用 |
|------|------|
| `.github/workflows/deploy.yml` | 构建部署流程，自动扫描 Secrets 生成 matrix |
| `.github/workflows/test-cloudflare.yml` | 测试各账户 API 连通性 |
| `config.yaml` | 前端镜像源域名配置 |
| `worker-get/worker.js` | Worker 多源重定向 |

## 测试方法

手动触发 `test-cloudflare.yml` 工作流，自动扫描所有账户并并行测试 API 连通性。