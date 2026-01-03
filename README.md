# culinaryclasswars-pr-agent (⚫⚪🍳 Black & White Reviewer)

> "The readability of this code is quite appetizing." vs. "I cannot read any 'intent' behind this logic."

Black & White Reviewer is an AI-powered code review automation system that transforms your GitHub Pull Request into a high-stakes survival cooking competition. Korea's top judge personas will fiercely evaluate your code from the perspectives of 'Readability' and 'Intent.'

## Screenshots

<img width="1626" height="1079" alt="CleanShot 2026-01-04 at 04 46 54" src="https://github.com/user-attachments/assets/9440491d-e3f4-43a1-a26f-8c8a8eb441d1" />
<img width="854" height="554" alt="CleanShot 2026-01-04 at 04 17 21" src="https://github.com/user-attachments/assets/58fbe67c-158e-426a-b0cb-6739b6e734c2" />

## 🚀 Quick Start
### 1. Use GitHub Actions
Create a workflow file in your repository to summon the judges.

```md
# .github/workflows/call-culinaryclasswars-pr-agent.yml
name: "AI Code Review"

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      
      - name: culinaryclasswars-pr-agent Step
        uses: asisjinwookim/culinaryclasswars-pr-agent@main
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

### 2. API Key Setup
1. Issue a Gemini API Key at [Google AI Studio](https://aistudio.google.com/).
2. Register it as a secret in your repository: Settings > Secrets and variables > Actions under the name GEMINI_API_KEY.

## ⚖️ License
This project is licensed under the MIT License.
