const fs = require('fs');
const path = require('path');

module.exports = async ({ github, context }) => {
  const { execSync } = require('child_process');
  const actionRoot = process.env.ACTION_PATH || process.cwd();
  const scriptsPath = path.join(actionRoot, 'scripts');

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

    const languageInstruction = `
      [LANGUAGE INSTRUCTION]
      1. Detect the primary language used in the '[PR Description]' provided below.
      2. Respond in that SAME language.
      3. Even when translating, keep the specific persona's tone:
        - Paik: Friendly, intuitive, using local professional slang.
        - Ahn: Formal, strict, emphasizing 'intent' and 'perfection'.
    `;

    // AI에게 '현재 받은 Diff 텍스트에 존재하는 + 기호가 붙은 라인 번호'만 쓰라고 강조
    const formatInstruction = `\nCRITICAL: Use ONLY line numbers that appear in the provided Diff content.
                               DO NOT hallucinate line numbers. Output format: [{"line": number, "comment": "string"}]`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `
              ${languageInstruction}
              ${prompt}
              ${formatInstruction}

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
      // 1. JSON 추출 및 파싱
      const cleanedData = rawData.replace(/```json|```/g, '').trim();
      let parsed = JSON.parse(cleanedData);

      // 2. 데이터 정규화 (배열이든 객체 내 배열이든 처리 가능하게)
      let reviews = [];
      if (Array.isArray(parsed)) {
        reviews = parsed;
      } else if (parsed.reviews && Array.isArray(parsed.reviews)) {
        reviews = parsed.reviews;
      } else {
        console.error(`${judgeName} 응답 형식이 유효하지 않음:`, parsed);
        return;
      }

      // 3. 필터링 및 댓글 생성
      const validComments = reviews
        .filter(r => r && typeof r === 'object' && r.line && !isNaN(r.line))
        .map(r => ({
          path: targetFile,
          line: parseInt(r.line),
          body: `**${judgeName}**: ${r.comment}`
        }));

      if (validComments.length > 0) {
        await github.rest.pulls.createReview({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: pr.number,
          commit_id: headSha,
          body: title,
          event: 'COMMENT',
          comments: validComments
        });
      }
    } catch (e) {
      console.error(`${judgeName} 데이터 처리 중 예상치 못한 에러:`, e.message);
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