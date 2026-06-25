# Test Cloudflare Configuration

Workflow to verify Cloudflare API connectivity and project setup.

## `.github/workflows/test-cloudflare.yml`

```yaml
name: Test Cloudflare Config

on:
  workflow_dispatch:

jobs:
  test-config:
    runs-on: ubuntu-latest

    steps:
      - name: Check Secrets
        run: |
          if [ -z "${{ secrets.CLOUDFLARE_API_TOKEN }}" ]; then
            echo "CLOUDFLARE_API_TOKEN not configured"
            exit 1
          fi
          echo "CLOUDFLARE_API_TOKEN: configured"

          if [ -z "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}" ]; then
            echo "CLOUDFLARE_ACCOUNT_ID not configured"
            exit 1
          fi
          echo "CLOUDFLARE_ACCOUNT_ID: configured"

      - name: Test API Connection
        run: |
          response=$(curl -s -X GET \
            "https://api.cloudflare.com/client/v4/accounts/${{ secrets.CLOUDFLARE_ACCOUNT_ID }}/pages/projects" \
            -H "Authorization: Bearer ${{ secrets.CLOUDFLARE_API_TOKEN }}" \
            -H "Content-Type: application/json")

          success=$(echo "$response" | jq -r '.success')

          if [ "$success" = "true" ]; then
            echo "API connection successful"
            echo "Projects:"
            echo "$response" | jq -r '.result[].name'
          else
            echo "API connection failed"
            echo "$response" | jq '.'
            exit 1
          fi
```

## Usage

1. Go to GitHub Actions tab
2. Select "Test Cloudflare Config" workflow
3. Click "Run workflow"
4. Check output for connection status and project list
