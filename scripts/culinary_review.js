const fs = require('fs');
const path = require('path');

module.exports = async ({ github, context }) => {
  const { execSync } = require('child_process');
  const scriptsPath = path.join(process.cwd(), 'scripts');

  const pr = context.payload.pull_request;
  const baseRef = pr.base.ref;
  const headSha = pr.head.sha;

  const changedFiles = execSync(`git diff --name-only origin/${baseRef} HEAD`).toString().trim().split('\n');
  const targetFile = changedFiles[0]; // 테스트를 위해 첫 번째 변경 파일 선택
  // 파일의 전체 내용을 읽어 라인 번호를 완벽히 파악하게 함
  const fileContent = fs.readFileSync(path.join(process.cwd(), targetFile), 'utf8');
  const fileContentWithLineNumbers = fileContent.split('\n')
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n');

  const diff = execSync(`git diff origin/${baseRef} HEAD ${targetFile}`).toString();
  const prBody = pr.body || "No description provided.";

  if (!diff) return;

  const loadPrompt = (file) => fs.readFileSync(path.join(scriptsPath, file), 'utf8');

  async function askGemini(prompt, diffContent, fullCode, description) {
    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    // AI에게 '현재 받은 Diff 텍스트에 존재하는 + 기호가 붙은 라인 번호'만 쓰라고 강조
    const formatInstruction = isLineReview
    ? `\nCRITICAL: Use ONLY line numbers that appear in the provided Diff content.
      DO NOT hallucinate line numbers. Output format: [{"line": number, "comment": "string"}]`
    : "";

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `
              ${prompt}

              [TASK]
              제공된 '전체 소스 코드'의 라인 번호를 기준으로 리뷰하십시오.
              'Diff' 내용은 어떤 부분이 수정되었는지 참고하는 용도로만 사용하십시오.
              절대로 존재하지 않는 라인이나 엉뚱한 라인을 언급하지 마십시오.

              [전체 소스 코드 (라인 번호 포함)]:
              ${fullCode}

              [수정된 Diff 내용]:
              ${diffContent}

              [PR 설명서]:
              ${description}

              [OUTPUT FORMAT]
              {"reviews": [{"line": 정확한_라인_번호, "comment": "소프트웨어 용어를 사용한 심사평"}]}
            `
          }]
        }],
        // 일관된 JSON 출력을 위해 온도를 낮춤
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates[0].content.parts[0].text;
  }

  async function createSafeReview(judgeName, rawData, title) {
    try {
      const reviews = JSON.parse(rawData.replace(/```json|```/g, ''));
      const validComments = reviews
        .filter(r => r.line && r.line > 0)
        .map(r => ({
          path: targetFile,
          line: parseInt(r.line),
          body: `**${judgeName}**: ${r.comment}`
        }));

      if (validComments.length > 0) {
        await github.rest.pulls.createReview({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: pr.number, // 정의된 pr 변수 사용
          commit_id: headSha,
          body: title,
          event: 'COMMENT',
          comments: validComments
        });
      }
    } catch (e) {
      console.error(`${judgeName} 리뷰 생성 실패:`, e.message);
    }
  }

  try {
    // --- STEP 1: 백종원의 직관적 코드 리뷰 ---
    console.log("Step 1: Paik is checking the 'Intuitive Taste' of your code...");
    const paikRaw = await askGemini(loadPrompt('prompt_paik.md'), diff, fileContentWithLineNumbers, prBody);
    await createSafeReview("백종원", paikRaw, "### 👨‍🍳 백종원의 실시간 코드 미감 체크");

    // --- STEP 2: 안성재의 기술적 익힘 리뷰 ---
    console.log("Step 2: Ahn is inspecting the 'Runtime Doneness'...");
    const ahnRaw = await askGemini(loadPrompt('prompt_ahn.md'), diff, fileContentWithLineNumbers, prBody);
    await createSafeReview("안성재", ahnRaw, "### 👓 안성재의 로직 익힘 심사");

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