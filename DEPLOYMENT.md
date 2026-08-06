---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'ac05f12a-83ef-4cc0-9ac0-da476f7a675a'
  PropagateID: 'ac05f12a-83ef-4cc0-9ac0-da476f7a675a'
  ReservedCode1: 'c7296a8c-8668-42ef-b66a-9ee321300a40'
  ReservedCode2: 'c7296a8c-8668-42ef-b66a-9ee321300a40'
---

# 多账户容灾部署指南

## 架构概览

本项目支持同时部署到多个 Cloudflare 账户，实现容灾互备：

```
构建(build) ──┬── 账户1 部署 ── books.07170501.xyz / books.1189.dpdns.org
              ├── 账户2 部署 ── (域名待配置)
              ├── GitHub Pages ── books.07170501.xyz
              └── Artifacts 上传
```

- **构建阶段**只执行一次，产物共享给所有部署任务
- **Cloudflare 部署**通过 matrix 并行，`fail-fast: false` 确保一个账户失败不影响其他
- **GitHub Pages** 作为独立兜底

## GitHub Secrets 配置

| Secret | 说明 | 状态 |
|--------|------|------|
| `CLOUDFLARE_ACCOUNT_ID` | 账户1 Account ID | ✅ 已配置 |
| `CLOUDFLARE_API_TOKEN` | 账户1 API Token | ✅ 已配置 |
| `CLOUDFLARE_ACCOUNT_ID_2` | 账户2 Account ID | ✅ 已配置 |
| `CLOUDFLARE_API_TOKEN_2` | 账户2 API Token | ✅ 已配置 |

## 添加新账户

以添加账户3为例：

### 1. 设置 GitHub Secrets

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID_3 --body "你的AccountID"
gh secret set CLOUDFLARE_API_TOKEN_3 --body "你的APIToken"
```

### 2. deploy.yml 添加 matrix 项

在 `deploy-cloudflare` job 的 `matrix.include` 中添加：

```yaml
- account_label: "账户3"
  account_id_secret: CLOUDFLARE_ACCOUNT_ID_3
  api_token_secret: CLOUDFLARE_API_TOKEN_3
  project_name: "books"
  domains: "books3.example.com"
```

### 3. config.yaml 添加域名

在 `remote_servers.cloudflare` 中添加账户3的域名。

### 4. worker.js 添加镜像源

在 `FALLBACK_BASES` 中添加账户3的域名。

## 添加账户2域名

当前账户2域名待配置，配置步骤：

1. 在 Cloudflare 账户2中添加域名 DNS 解析
2. 编辑 `deploy.yml`，在账户2的 matrix 项中填写 `domains`
3. 编辑 `config.yaml`，取消注释并填写账户2域名
4. 编辑 `worker.js`，取消注释并填写 `FALLBACK_BASES`

## 文件清单

| 文件 | 作用 |
|------|------|
| `.github/workflows/deploy.yml` | 构建部署流程，matrix 多账户并行 |
| `.github/workflows/test-cloudflare.yml` | 测试各账户 API 连通性 |
| `config.yaml` | 前端镜像源域名配置 |
| `worker-get/worker.js` | Worker 多源重定向 |

## 测试方法

手动触发 `test-cloudflare.yml` 工作流，会并行测试所有账户的 API 连通性和项目状态。