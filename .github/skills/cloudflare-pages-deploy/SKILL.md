---
name: cloudflare-pages-deploy
description: 'Deploy static HTML site to Cloudflare Pages via GitHub Actions with GitHub Pages fallback. Use when: Cloudflare Pages deploy, GitHub Actions deploy, static site hosting, wrangler deploy, GitHub Pages, CDN deployment, automatic deployment, CI/CD deploy website.'
argument-hint: 'Describe your Cloudflare project name and static output directory'
---

# Deploy to Cloudflare Pages via GitHub Actions

## When to Use
- Setting up automatic deployment of static HTML to Cloudflare Pages
- Deploying via GitHub Actions (not Cloudflare's built-in Git integration)
- Dual deployment to Cloudflare Pages + GitHub Pages
- Downloading APK from GitHub Release and including in deployment

## Overview

This skill creates a CI/CD pipeline that:
1. Generates static site (customizable build step)
2. Downloads latest APK from GitHub Releases
3. Deploys to Cloudflare Pages via wrangler
4. Deploys to GitHub Pages as fallback
5. Handles Cloudflare project auto-creation

## Prerequisites

- Cloudflare account with Pages enabled
- GitHub repository with Actions enabled
- GitHub Secrets configured:
  - `CLOUDFLARE_API_TOKEN` (Cloudflare API token with Pages:Edit permission)
  - `CLOUDFLARE_ACCOUNT_ID` (Cloudflare account ID)

## Procedure

### Step 0: Use Starter Template Pack (Recommended)

This skill includes a deploy starter workflow in:

`./assets/starter/.github/workflows/deploy.yml`

Copy it to your repository `.github/workflows/deploy.yml`, then replace:
- `__CF_PROJECT_NAME__`

Also confirm your build command produces static files into `output/`.

### Step 1: Create Cloudflare API Token

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → My Profile → API Tokens
2. Create Token → Custom Token
3. Permissions:
   - Account > Cloudflare Pages > Edit
4. Account Resources: Include your account
5. Save the token as `CLOUDFLARE_API_TOKEN` in GitHub Secrets

### Step 2: Get Account ID

1. Cloudflare Dashboard → Overview
2. Copy Account ID from the right sidebar
3. Save as `CLOUDFLARE_ACCOUNT_ID` in GitHub Secrets

### Step 3: Create Deploy Workflow

Create `.github/workflows/deploy.yml` following the [deploy workflow template](./references/deploy-workflow.md).

Key features:
- Triggers on push to main (with path filters)
- Triggers on workflow_dispatch (manual / from other workflows)
- Auto-creates Cloudflare Pages project if not exists
- Downloads latest APK from GitHub Release and includes in output
- Deploys to both Cloudflare Pages and GitHub Pages
- Retry mechanism for Cloudflare deployment

### Step 4: Create _headers File

Create `output/_headers` for proper caching:

```
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY

/sw.js
  Cache-Control: no-cache, no-store, must-revalidate

/version.json
  Cache-Control: no-cache, no-store, must-revalidate
  Access-Control-Allow-Origin: *

/*.apk
  Access-Control-Allow-Origin: *
  Content-Type: application/vnd.android.package-archive
```

### Step 5: Configure Custom Domain (Optional)

1. Cloudflare Pages project → Custom domains
2. Add your domain
3. DNS records are auto-configured if domain is on Cloudflare

### Step 6: Test Deployment

Use the test workflow to verify Cloudflare configuration:

```yaml
# .github/workflows/test-cloudflare.yml
name: Test Cloudflare Config
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
    - name: Test API
      run: |
        response=$(curl -s -X GET \
          "https://api.cloudflare.com/client/v4/accounts/${{ secrets.CLOUDFLARE_ACCOUNT_ID }}/pages/projects" \
          -H "Authorization: Bearer ${{ secrets.CLOUDFLARE_API_TOKEN }}")
        echo "$response" | jq '.result[].name'
```

## Workflow Trigger Chain

```
Code push to main
  → deploy.yml: Build + Deploy to Cloudflare & GitHub Pages

Git tag v*.*.* push
  → android-release.yml: Build APK + Create Release
  → (after release) trigger deploy.yml via workflow_dispatch
  → deploy.yml: Re-deploy with APK included
```

## References

- [Deploy Workflow Template](./references/deploy-workflow.md)
- [Cloudflare Headers Config](./references/cloudflare-headers.md)
- [Test Cloudflare Workflow](./references/test-cloudflare.md)

## Assets

- [Deploy Starter Workflow](./assets/starter/.github/workflows/deploy.yml)
