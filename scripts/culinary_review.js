const fs = require('fs');
const path = require('path');

module.exports = async ({ github, context }) => {
  const { execSync } = require('child_process');

  const pr = context.payload.pull_request;
  if (!pr) return;

  const repoOwner = context.repo.owner;
  const repoName = context.repo.repo;
  const prNumber = pr.number;
  const headSha = pr.head.sha;
  const baseRef = pr.base.ref;
  const prBody = pr.body || "No description provided.";
  const actionRoot = process.env.ACTION_PATH;
  const scriptsPath = path.join(actionRoot, 'scripts');

  // [1] 변경된 파일 찾기 및 Diff 분석
  let changedFiles = execSync(`git diff --name-only origin/${baseRef} HEAD`).toString().trim().split('\n');
  const targetFile = changedFiles[0];
  if (!targetFile) return;

  const diff = execSync(`git diff origin/${baseRef} HEAD ${targetFile}`).toString();

  // [핵심] 실제 수정된 라인 번호들(Hunks)만 추출하는 함수
  function getValidDiffLines(diffText) {
    const lines = new Set();
    const hunks = diffText.split(/^@@/m).slice(1);

    hunks.forEach(hunk => {
      const header = hunk.split('\n')[0];
      const match = header.match(/\+(\d+),?(\d+)?/); // 새 파일의 시작 라인과 길이
      if (!match) return;

      let currentLine = parseInt(match[1]);
      const contentLines = hunk.split('\n').slice(1);

      contentLines.forEach(line => {
        if (line.startsWith('+')) {
          lines.add(currentLine);
          currentLine++;
        } else if (!line.startsWith('-')) {
          currentLine++;
        }
      });
    });
    return lines;
  }

  const validLines = getValidDiffLines(diff);
  const fileContent = fs.readFileSync(path.join(process.cwd(), targetFile), 'utf8');
  const fileContentWithLineNumbers = fileContent.split('\n')
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n');

  // [2] Gemini API 호출 함수
  async function askGemini(prompt, diffContent, fullCode, description) {
    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `${prompt}
              [RULES]
              - ONLY comment on lines that exist in the [Valid Line Numbers].
              - [Valid Line Numbers]: ${Array.from(validLines).join(', ')}
              - If no valid lines deserve comment, return {"reviews": []}.

              [Full Source]:
              ${fullCode}

              [Diff]:
              ${diffContent}`
          }]
        }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates[0].content.parts[0].text;
  }

  // [3] 리뷰 수집 함수
  function collectComments(judgeName, rawData, validLines) {
    try {
      const cleanedData = rawData.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleanedData);
      const reviews = Array.isArray(parsed) ? parsed : (parsed.reviews || []);

      return reviews
        .filter(r => r.comment && validLines.has(parseInt(r.line)))
        .map(r => ({
          path: targetFile,
          line: parseInt(r.line),
          side: "RIGHT",
          body: `**${judgeName}**: ${r.comment}`
        }));
    } catch (e) {
      console.error(`${judgeName} 파싱 실패:`, e.message);
      return [];
    }
  }

    // [수정] @@ -L,n +L,n @@ 범위 내의 모든 라인을 허용하는 로직
  function getValidDiffLines(diffText) {
    const lines = new Set();
    const hunks = diffText.split(/^@@/m).slice(1);

    hunks.forEach(hunk => {
      const header = hunk.split('\n')[0];
      // +67,18 같은 패턴에서 시작번호(67)와 길이(18)를 추출
      const match = header.match(/\+(\d+)(?:,(\d+))?/);
      if (!match) return;

      const startLine = parseInt(match[1]);
      const lineCount = match[2] ? parseInt(match[2]) : 1;

      // 해당 Hunk(덩어리) 범위 내의 모든 라인 번호를 허용 리스트에 추가
      for (let i = 0; i < lineCount; i++) {
        lines.add(startLine + i);
      }
    });
    return lines;
  }

  // [4] 프로세스 실행
  try {
    const loadPrompt = (f) => fs.readFileSync(path.join(scriptsPath, f), 'utf8');

    const validLines = getValidDiffLines(diff); // 위에서 수정한 함수 사용

    const paikRaw = await askGemini(loadPrompt('prompt_paik.md'), diff, fileContentWithLineNumbers, prBody);
    const ahnRaw = await askGemini(loadPrompt('prompt_ahn.md'), diff, fileContentWithLineNumbers, prBody);

    const allComments = [
      ...collectComments("백종원", paikRaw, validLines),
      ...collectComments("안성재", ahnRaw, validLines)
    ];

    // 단 한 번의 API 호출로 모든 심사평 게시
    if (allComments.length > 0) {
      await github.rest.pulls.createReview({
        owner: repoOwner,
        repo: repoName,
        pull_number: prNumber,
        commit_id: headSha,
        body: "### 👨‍🍳👓 흑백요리사 합동 심사",
        event: 'COMMENT',
        comments: allComments
      });
      console.log(`[System] Posted ${allComments.length} comments from both judges.`);
    }
  } catch (e) {
    console.log('prompt error: ', e)
  }
}