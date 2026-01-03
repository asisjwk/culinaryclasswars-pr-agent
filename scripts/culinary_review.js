const fs = require('fs');
const path = require('path');

module.exports = async ({ github, context }) => {
  const { execSync } = require('child_process');
  const scriptsPath = path.join(process.cwd(), '.github/scripts');

  // 1. 코드 Diff 및 프롬프트 로드
  const baseRef = context.payload.pull_request.base.ref;
  const diff = execSync(`git diff origin/${baseRef} HEAD`).toString();
  if (!diff) return;

  const loadPrompt = (file) => fs.readFileSync(path.join(scriptsPath, file), 'utf8');

  async function askGemini(prompt, content) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: `${prompt}\n\n[도전자의 코드 설명서(PR 본문)]:\n${description}\n\n[심사 대상 코드(Diff)]:\n${content}` }] }] })
    });
    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
  }

  // 2. 심사 진행
  console.log("백종원 심사위원 심사 중...");
  const paikReview = await askGemini(loadPrompt('prompt_paik.md'), diff);

  console.log("안성재 심사위원 심사 중...");
  const ahnReview = await askGemini(loadPrompt('prompt_ahn.md'), diff);

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
