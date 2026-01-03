const fs = require('fs');
const path = require('path');

module.exports = async ({ github, context }) => {
  const { execSync } = require('child_process');
  const scriptsPath = path.join(process.cwd(), 'scripts');

  const baseRef = context.payload.pull_request.base.ref;
  const headRef = context.payload.pull_request.head.sha;
  const diff = execSync(`git diff origin/${baseRef} HEAD`).toString();
  const prBody = context.payload.pull_request.body || "No description provided.";

  if (!diff) return;

  const loadPrompt = (file) => fs.readFileSync(path.join(scriptsPath, file), 'utf8');

  async function askGemini(prompt, content, description, isLineReview = false) {
    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    // 라인 리뷰 시 JSON 형식을 강제하는 가이드 추가
    const formatInstruction = isLineReview
      ? "\nOutput MUST be a valid JSON array of objects: [{\"line\": number, \"comment\": \"string\"}]"
      : "";

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: `${prompt}${formatInstruction}\n\n[PR Description]:\n${description}\n\n[Diff Content]:\n${content}` }]
        }],
        generationConfig: { temperature: 0.2 } // 일관된 JSON 출력을 위해 온도를 낮춤
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates[0].content.parts[0].text;
  }

  try {
    // --- STEP 1: 백종원의 직관적 코드 리뷰 ---
    console.log("Step 1: Paik is checking the 'Intuitive Taste' of your code...");
    const paikRaw = await askGemini(loadPrompt('prompt_paik.md'), diff, prBody, true);
    const paikReviews = JSON.parse(paikRaw.replace(/```json|```/g, ''));

    await github.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.issue.number,
      commit_id: headRef,
      body: "### 👨‍🍳 백종원의 실시간 미감 체크\n\"자, 코드가 입에 착착 감기는지 한번 봅시다!\"",
      event: 'COMMENT',
      comments: paikReviews.map(r => ({ path: 'transaction_orchestrator.py', line: r.line, body: `**백종원**: ${r.comment}` }))
    });

    // --- STEP 2: 안성재의 기술적 익힘 리뷰 ---
    console.log("Step 2: Ahn is inspecting the 'Runtime Doneness'...");
    const ahnRaw = await askGemini(loadPrompt('prompt_ahn.md'), diff, prBody, true);
    const ahnReviews = JSON.parse(ahnRaw.replace(/```json|```/g, ''));

    await github.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.issue.number,
      commit_id: headRef,
      body: "### 👓 안성재의 로직 익힘 심사\n\"의도가 구현에 얼마나 반영되었는지 보죠.\"",
      event: 'COMMENT',
      comments: ahnReviews.map(r => ({ path: 'transaction_orchestrator.py', line: r.line, body: `**안성재**: ${r.comment}` }))
    });

    // --- STEP 3: 최종 끝장 토론 ---
    const debateResult = await askGemini(
      loadPrompt('prompt_debate.md'),
      `[Paik's Review]: ${paikRaw}\n\n[Ahn's Review]: ${ahnRaw}`,
      prBody
    );

    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      body: `## 🤝 심사위원 끝장 토론 결과\n\n${debateResult}`
    });

  } catch (error) {
    console.error("Evaluation Error:", error);
  }
};