const fs = require('fs');
const path = require('path');

// --- [Part 1] Runner: node 명령으로 직접 실행될 때 ---
if (require.main === module) {
  try {
    const github = require('@actions/github');
    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);

    const context = {
      payload: {
        pull_request: {
          number: parseInt(process.env.PR_NUMBER),
          base: { ref: process.env.BASE_REF },
          head: { sha: process.env.HEAD_SHA },
          body: process.env.PR_BODY || ""
        }
      },
      repo: {
        owner: process.env.REPO_OWNER,
        repo: process.env.REPO_NAME
      },
      issue: {
        number: parseInt(process.env.PR_NUMBER)
      }
    };

    module.exports({ github: octokit, context }).catch(err => {
      console.error(err);
      process.exit(1);
    });
  } catch (e) {
    console.error("Missing @actions/github module. Please ensure it is installed.");
    process.exit(1);
  }
}

// --- [Part 2] Engine: 실제 리뷰 로직 ---
module.exports = async ({ github, context }) => {
  const { execSync } = require('child_process');

  const pr = context.payload.pull_request;
  const prNumber = pr.number;
  const headSha = pr.head.sha;
  const baseRef = pr.base.ref;
  const prBody = pr.body || "No description provided.";

  const repoOwner = context.repo.owner; // 추가
  const repoName = context.repo.repo;   // 추가

  const actionRoot = process.env.ACTION_PATH || process.cwd();
  const scriptsPath = path.join(actionRoot, 'scripts');

  console.log(`[System] Starting review for PR #${prNumber} in ${repoOwner}/${repoName}`);

  const changedFiles = execSync(`git diff --name-only origin/${baseRef} HEAD`).toString().trim().split('\n');
  const targetFile = changedFiles[0];

  if (!targetFile) {
    console.log("No changed files to review.");
    return;
  }

  const fileContent = fs.readFileSync(path.join(process.cwd(), targetFile), 'utf8');
  const fileContentWithLineNumbers = fileContent.split('\n')
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n');

  const diff = execSync(`git diff origin/${baseRef} HEAD ${targetFile}`).toString();
  if (!diff) return;

  const loadPrompt = (file) => fs.readFileSync(path.join(scriptsPath, file), 'utf8');

  async function askGemini(prompt, diffContent, fullCode, description) {
    const model = "gemini-1.5-flash"; // 2.5는 아직 존재하지 않으므로 1.5-flash 권장
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

              [전체 소스 코드]: ${fullCode}
              [수정된 Diff]: ${diffContent}
              [PR 설명]: ${description}
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

  async function createSafeReview(judgeName, rawData, title) {
    try {
      const cleanedData = rawData.replace(/```json|```/g, '').trim();
      let parsed = JSON.parse(cleanedData);
      let reviews = Array.isArray(parsed) ? parsed : (parsed.reviews || []);

      const validComments = reviews
        .filter(r => r && r.line && !isNaN(r.line))
        .map(r => ({
          path: targetFile,
          line: parseInt(r.line),
          body: `**${judgeName}**: ${r.comment}`
        }));

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
      }
    } catch (e) {
      console.error(`${judgeName} 데이터 처리 에러:`, e.message);
    }
  }

  try {
    const paikRaw = await askGemini(loadPrompt('prompt_paik.md'), diff, fileContentWithLineNumbers, prBody);
    await createSafeReview("백종원", paikRaw, "### 👨‍🍳 백종원의 실시간 코드 미감 체크");

    const ahnRaw = await askGemini(loadPrompt('prompt_ahn.md'), diff, fileContentWithLineNumbers, prBody);
    await createSafeReview("안성재", ahnRaw, "### 👓 안성재의 로직 익힘 심사");

    // debateResult 인자 수정 (description 자리에 prBody 전달)
    const debateResult = await askGemini(
      loadPrompt('prompt_debate.md'),
      "",
      `[Paik]: ${paikRaw}\n[Ahn]: ${ahnRaw}`,
      prBody
    );

    await github.rest.issues.createComment({
      owner: repoOwner,
      repo: repoName,
      issue_number: prNumber,
      body: `## 🤝 심사위원 끝장 토론 결과\n\n${debateResult}`
    });

  } catch (error) {
    console.error("Evaluation Error:", error);
  }
};