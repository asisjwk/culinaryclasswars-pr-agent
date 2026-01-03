const fs = require('fs');
const path = require('path');

module.exports = async ({ github, context }) => {
  const { execSync } = require('child_process');

  // 1. 경로 설정
  const scriptsPath = path.join(process.cwd(), 'scripts');

  // 2. 데이터 추출 (Diff 및 PR Description)
  const baseRef = context.payload.pull_request.base.ref;
  const diff = execSync(`git diff origin/${baseRef} HEAD`).toString();
  const prDescription = context.payload.pull_request.body || "설명이 작성되지 않았습니다.";

  if (!diff) {
    console.log("변경 사항이 없어 심사를 종료합니다.");
    return;
  }

  const loadPrompt = (file) => fs.readFileSync(path.join(scriptsPath, file), 'utf8');

  // 3. Gemini API 호출 함수 (변수명 response 통일)
  async function askGemini(prompt, content, description) {
    // fetch 결과를 'response' 변수에 담습니다.
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `${prompt}\n\n[도전자의 요리 설명서(PR 본문)]:\n${description}\n\n[심사 대상 코드(Diff)]:\n${content}`
          }]
        }],
        generationConfig: { temperature: 0.7 }
      })
    });

    const data = await response.json(); // 여기서 'response'를 참조합니다.

    if (data.error) {
      throw new Error(`Gemini API Error: ${data.error.message}`);
    }

    if (!data.candidates || data.candidates.length === 0) {
      throw new Error("Gemini 응답이 비어있습니다. 안전 정책에 의해 차단되었을 가능성이 있습니다.");
    }

    return data.candidates[0].content.parts[0].text;
  }

  try {
    // 4. 심사 진행
    console.log("백종원 심사위원 시식 중...");
    const paikReview = await askGemini(loadPrompt('prompt_paik.md'), diff, prDescription);

    console.log("안성재 심사위원 의도 파악 중...");
    const ahnReview = await askGemini(loadPrompt('prompt_ahn.md'), diff, prDescription);

    console.log("심사위원 끝장 토론 중...");
    const debateResult = await askGemini(
      loadPrompt('prompt_debate.md'),
      `[백종원 심사평]: ${paikReview}\n\n[안성재 심사평]: ${ahnReview}`,
      prDescription
    );

    // 5. 결과 포스팅
    const commentBody = `## 🍳 흑백요리사 AI 코드 심사 결과\n\n### 👨‍🍳 백종원 심사위원\n> ${paikReview}\n\n### 👓 안성재 심사위원\n> ${ahnReview}\n\n---\n### 🤝 심사위원 끝장 토론\n${debateResult}`;

    await github.rest.issues.createComment({
      issue_number: context.issue.number,
      owner: context.repo.owner,
      repo: context.repo.repo,
      body: commentBody
    });

  } catch (error) {
    console.error("심사 중 오류 발생:", error.message);
    // 에러 발생 시 사용자에게 알림 댓글을 남길 수도 있습니다.
  }
};