const fs = require('fs');
const path = require('path');

module.exports = async ({ github, context }) => {
  const { execSync } = require('child_process');
  const scriptsPath = path.join(process.cwd(), 'scripts');
  const prDescription = context.payload.pull_request.body || "설명이 작성되지 않았습니다.";

  // 1. 코드 Diff 및 프롬프트 로드
  const baseRef = context.payload.pull_request.base.ref;
  const diff = execSync(`git diff origin/${baseRef} HEAD`).toString();
  if (!diff) return;

  const loadPrompt = (file) => fs.readFileSync(path.join(scriptsPath, file), 'utf8');

  async function askGemini(prompt, content, description) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `
              ${prompt}

              심사 지침:
              아래 제공된 '도전자의 요리 설명서(PR 본문)'를 먼저 분석한 뒤,
              그 내용이 '심사 대상 코드(Diff)'에 어떻게 반영되었는지 대조하여 심사평을 남기십시오.

              [도전자의 요리 설명서(PR 본문)]:
              ${description}

              [심사 대상 코드(Diff)]:
              ${content}
            `
          }]
        }]
      })
    });
    const data = await response.json();

    if (data.error) {
      console.error("Gemini API Error Detail:", JSON.stringify(data.error, null, 2));
      throw new Error(`Gemini API Error: ${data.error.message}`);
    }

    if (!data.candidates || data.candidates.length === 0) {
      if (data.promptFeedback) {
        console.error("Prompt was blocked by safety settings:", JSON.stringify(data.promptFeedback, null, 2));
      }
      console.error("Full API Response:", JSON.stringify(data, null, 2));
      throw new Error("No candidates returned from Gemini. Check safety settings or API quota.");
    }

    return data.candidates[0].content.parts[0].text;
  }

  // 2. 심사 진행
  console.log("백종원 심사위원 심사 중...");
  const paikReview = await askGemini(loadPrompt('prompt_paik.md'), diff, prDescription);

  console.log("안성재 심사위원 심사 중...");
  const ahnReview = await askGemini(loadPrompt('prompt_ahn.md'), diff, prDescription);

  // 3. 토론 진행
  console.log("심사위원 토론 중...");
  const debateResult = await askGemini(
    loadPrompt('prompt_debate.md'),
    `[백종원 의견]: ${paikReview}\n\n[안성재 의견]: ${ahnReview}`
  );

  // 4. 결과 포스팅
  const commentBody = `## 🍳 흑백리뷰어 AI 코드 심사\n\n### 👨‍🍳 백종원 심사위원\n> ${paikReview}\n\n### 👓 안성재 심사위원\n> ${ahnReview}\n\n---\n### 🤝 심사위원 끝장 토론\n${debateResult}`;

  await github.rest.issues.createComment({
    issue_number: context.issue.number,
    owner: context.repo.owner,
    repo: context.repo.repo,
    body: commentBody
  });
};
