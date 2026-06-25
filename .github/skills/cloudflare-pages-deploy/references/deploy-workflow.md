# Deploy Workflow Template

Complete GitHub Actions workflow for deploying to Cloudflare Pages + GitHub Pages.

## `.github/workflows/deploy.yml`

```yaml
name: Build and Deploy

on:
  push:
    branches: [main]
    paths:
      - 'output/**'
      - 'src/**'
      - 'main.py'
      - 'config.yaml'
  workflow_dispatch:

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.9'
          cache: 'pip'

      - name: Install dependencies
        run: pip install -r requirements.txt

      # ===== YOUR BUILD STEP =====
      # - name: Generate static site
      #   run: python main.py

      - name: Generate version info
        run: python generate_version.py

      - name: Remove APK-only files (web deploy)
        run: |
          # app-update.js is only needed in APK, not web
          rm -f output/js/app-update.js

      - name: Download APK from GitHub Release
        run: |
          # CUSTOMIZE: Change repo owner/name
          RELEASE_INFO=$(curl -sf "https://api.github.com/repos/${{ github.repository }}/releases/latest" || echo "{}")

          if [ "$RELEASE_INFO" = "{}" ]; then
            echo "No Release found, skipping APK download"
            exit 0
          fi

          APK_URL=$(echo "$RELEASE_INFO" | jq -r '.assets[] | select(.name | endswith(".apk")) | .browser_download_url // empty')
          APK_NAME=$(echo "$RELEASE_INFO" | jq -r '.assets[] | select(.name | endswith(".apk")) | .name // empty')
          APK_SIZE=$(echo "$RELEASE_INFO" | jq -r '.assets[] | select(.name | endswith(".apk")) | .size // empty')
          APK_VERSION=$(echo "$RELEASE_INFO" | jq -r '.tag_name // empty' | sed 's/^v//')

          if [ -n "$APK_URL" ] && [ "$APK_URL" != "null" ]; then
            echo "Downloading APK: $APK_NAME"
            if curl -sfL -o "output/$APK_NAME" "$APK_URL"; then
              DOWNLOADED_SIZE=$(stat -c%s "output/$APK_NAME" 2>/dev/null || echo "0")
              echo "APK downloaded: $APK_NAME ($DOWNLOADED_SIZE bytes)"

              # Update version.json with APK info
              if [ -f output/version.json ]; then
                python3 << PYEOF
          import json
          with open('output/version.json', 'r+', encoding='utf-8') as f:
              data = json.load(f)
              data['apk_file'] = '$APK_NAME'
              data['apk_version'] = '$APK_VERSION'
              data['apk_size'] = $DOWNLOADED_SIZE
              f.seek(0); json.dump(data, f, ensure_ascii=False, indent=2); f.truncate()
          PYEOF
              fi
            fi
          fi

      - name: Auto-create Cloudflare Pages project
        run: |
          # CUSTOMIZE: Change project name
          PROJECT_NAME="my-app"

          response=$(curl -s -X GET \
            "https://api.cloudflare.com/client/v4/accounts/${{ secrets.CLOUDFLARE_ACCOUNT_ID }}/pages/projects/$PROJECT_NAME" \
            -H "Authorization: Bearer ${{ secrets.CLOUDFLARE_API_TOKEN }}")

          success=$(echo "$response" | jq -r '.success')

          if [ "$success" != "true" ]; then
            curl -s -X POST \
              "https://api.cloudflare.com/client/v4/accounts/${{ secrets.CLOUDFLARE_ACCOUNT_ID }}/pages/projects" \
              -H "Authorization: Bearer ${{ secrets.CLOUDFLARE_API_TOKEN }}" \
              -H "Content-Type: application/json" \
              -d "{\"name\": \"$PROJECT_NAME\", \"production_branch\": \"main\"}"
          fi

      - name: Deploy to Cloudflare Pages
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          npm install -g wrangler

          # CUSTOMIZE: Change project name and output directory
          PROJECT_NAME="my-app"
          OUTPUT_DIR="output"

          COMMIT_HASH=$(git rev-parse --short HEAD)
          COMMIT_MSG="Deploy $COMMIT_HASH"

          # Deploy with retry
          MAX_RETRIES=3
          for i in $(seq 1 $MAX_RETRIES); do
            if wrangler pages deploy "$OUTPUT_DIR" \
              --project-name="$PROJECT_NAME" \
              --branch=main \
              --commit-hash="$COMMIT_HASH" \
              --commit-message="$COMMIT_MSG"; then
              echo "Cloudflare Pages deploy succeeded"
              break
            fi
            if [ $i -lt $MAX_RETRIES ]; then
              echo "Deploy failed, retrying in 30s..."
              sleep 30
            else
              echo "Deploy failed after $MAX_RETRIES attempts"
              exit 1
            fi
          done

      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./output
          publish_branch: gh-pages
          force_orphan: true
          user_name: 'github-actions[bot]'
          user_email: 'github-actions[bot]@users.noreply.github.com'
          commit_message: 'Deploy to GitHub Pages'
          # CUSTOMIZE: Set your custom domain (optional)
          # cname: app.example.com
```

## Customization Points

| Item | Description |
|------|-------------|
| `PROJECT_NAME` | Your Cloudflare Pages project name |
| `OUTPUT_DIR` | Directory of static files to deploy |
| Build step | Add your site generation command |
| `paths` trigger | Adjust which file changes trigger deploy |
| `cname` | Custom domain for GitHub Pages |
| APK download | Change repo URL / remove if not needed |

## GitHub Secrets Required

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Pages:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions |
