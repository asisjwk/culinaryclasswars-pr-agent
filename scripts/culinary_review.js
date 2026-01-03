const fs = require('fs');
const path = require('path');

/**
 * Culinary Class Wars PR Review Engine
 * github-script 환경에서 호출됨
 */
module.exports = async ({ github, context }) => {
  const { execSync } = require('child_process');

  // [1] 데이터 추출
  const pr = context.payload.pull_request;
  if (!pr) {
    console.log("[System] Not a Pull Request event. Skipping.");
    return;
  }

  const repoOwner = context.repo.owner;
  const repoName = context.repo.repo;
  const prNumber = pr.number;
  const headSha = pr.head.sha;
  const baseRef = pr.base.ref;
  const prBody = pr.body || "No description provided.";

  // ACTION_PATH는 action.yml의 env에서 주입됩니다.
  const actionRoot = process.env.ACTION_PATH;
  const scriptsPath = path.join(actionRoot, 'scripts');

  console.log(`[System] Starting review for PR #${prNumber} in ${repoOwner}/${repoName}`);

  // [2] 변경 사항 파악
  let changedFiles;
  try {
    changedFiles = execSync(`git diff --name-only origin/${baseRef} HEAD`).toString().trim().split('\n');
  } catch (e) {
    console.error("[Error] Failed to get git diff. Ensure fetch-depth is 0 in checkout step.");
    return;
  }

  const targetFile = changedFiles[0];
  if (!targetFile) {
    console.log("No changed files to review.");
    return;
  }

  // 파일의 전체 내용 및 라인 번호 포함 텍스트 생성
  const fileContent = fs.readFileSync(path.join(process.cwd(), targetFile), 'utf8');
  const fileContentWithLineNumbers = fileContent.split('\n')
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n');

  const diff = execSync(`git diff origin/${baseRef} HEAD ${targetFile}`).toString();
  if (!diff) return;

  const loadPrompt = (file) => fs.readFileSync(path.join(scriptsPath, file), 'utf8');

  // [3] Gemini API 호출 함수
  async function askGemini(prompt, diffContent, fullCode, description) {
    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `
              ${prompt}
              [TASK] 전체 소스 코드의 라인 번호를 기준으로 리뷰하십시오.

              [전체 소스 코드]:
              ${fullCode}

              [수정된 Diff]:
              ${diffContent}

              [PR 설명]:
              ${description}
            `
          }]
        }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates[0].content.parts[0].text;
  }

  // [4] GitHub 리뷰 생성 함수
  async function createSafeReview(judgeName, rawData, title) {
    try {
      // 1. JSON 추출 및 파싱
      const cleanedData = rawData.replace(/```json|```/g, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(cleanedData);
      } catch (e) {
        console.error(`${judgeName} JSON 파싱 실패:`, cleanedData);
        return;
      }

      // 2. 데이터 정규화 (배열/객체 혼용 대응)
      let reviews = [];
      if (Array.isArray(parsed)) {
        reviews = parsed;
      } else if (parsed.reviews && Array.isArray(parsed.reviews)) {
        reviews = parsed.reviews;
      }

      // 3. 필터링 및 댓글 본문 생성 (undefined 방지)
      const validComments = reviews
        .filter(r => r && r.line) // 최소한 line 정보는 있어야 함
        .map(r => {
          // r.comment가 없으면 r.message나 객체 전체 문자열이라도 가져옴
          const commentText = r.comment || r.message || JSON.stringify(r);
          return {
            path: targetFile,
            line: parseInt(r.line),
            body: `**${judgeName}**: ${commentText}`
          };
        });

      if (validComments.length > 0) {
        await github.rest.pulls.createReview({
          owner: repoOwner,
          repo: repoName,
          pull_number: prNumber,
          commit_id: headSha,
          body: title,
          event: 'COMMENT',
          comments: validComments
        });
        console.log(`[System] ${judgeName}'s review posted.`);
      } else {
        console.log(`[System] No valid comments from ${judgeName}. Raw response: ${rawData}`);
      }
    } catch (e) {
      console.error(`${judgeName} 데이터 처리 중 에러:`, e.message);
    }
  }

  // [5] 메인 심사 프로세스 실행
  try {
    // 백종원 심사
    console.log("Step 1: Paik's Intuition...");
    const paikRaw = await askGemini(loadPrompt('prompt_paik.md'), diff, fileContentWithLineNumbers, prBody);
    await createSafeReview("백종원", paikRaw, "### 👨‍🍳 백종원의 실시간 코드 미감 체크");

    // 안성재 심사
    console.log("Step 2: Ahn's Perfection...");
    const ahnRaw = await askGemini(loadPrompt('prompt_ahn.md'), diff, fileContentWithLineNumbers, prBody);
    await createSafeReview("안성재", ahnRaw, "### 👓 안성재의 로직 익힘 심사");

    // 끝장 토론 (PR 본문에 댓글 작성)
    console.log("Step 3: Final Debate...");
    const debateResult = await askGemini(
      loadPrompt('prompt_debate.md'),
      "",
      `[Paik's Review]: ${paikRaw}\n\n[Ahn's Review]: ${ahnRaw}`,
      prBody
    );
    await createSafeReview("심사 결과", debateResult, "### 심사 결과");
  } catch (error) {
    console.error("Evaluation Process Error:", error);
  }
};