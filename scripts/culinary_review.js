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

  // [3] 리뷰 생성 함수
  async function createSafeReview(judgeName, rawData, title) {
    try {
      const cleanedData = rawData.replace(/```json|```/g, '').trim();
      let parsed = JSON.parse(cleanedData);
      let reviews = Array.isArray(parsed) ? parsed : (parsed.reviews || []);

      const validComments = reviews
        .filter(r => {
          const lineNum = parseInt(r.line);
          // 실제 수정된 범위(validLines) 안에 있는 번호만 통과
          return r.comment && validLines.has(lineNum);
        })
        .map(r => ({
          path: targetFile,
          line: parseInt(r.line),
          side: "RIGHT",
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
      console.error(`${judgeName} 처리 에러:`, e.message);
    }
  }

  // [4] 프로세스 실행
  try {
    const loadPrompt = (f) => fs.readFileSync(path.join(scriptsPath, f), 'utf8');

    const paikRaw = await askGemini(loadPrompt('prompt_paik.md'), diff, fileContentWithLineNumbers, prBody);
    await createSafeReview("백종원", paikRaw, "### 👨‍🍳 백종원의 심사");

    const ahnRaw = await askGemini(loadPrompt('prompt_ahn.md'), diff, fileContentWithLineNumbers, prBody);
    await createSafeReview("안성재", ahnRaw, "### 👓 안성재의 심사");

    const debateRaw = await askGemini(
      loadPrompt('prompt_debate.md'),
      "",
      `[Paik's Review]: ${paikRaw}\n\n[Ahn's Review]: ${ahnRaw}`,
      prBody
    );

    let finalDebateText = "";
    try {
      // 1. JSON 문자열만 정교하게 추출 (앞뒤 쓰레기 텍스트 제거)
      const jsonStart = debateRaw.indexOf('{');
      const jsonEnd = debateRaw.lastIndexOf('}') + 1;
      const jsonString = debateRaw.substring(jsonStart, jsonEnd);

      const parsed = JSON.parse(jsonString);

      if (Array.isArray(parsed)) {
        // [핵심] JSON 배열을 마크다운 대화 형식으로 변환
        finalDebateText = parsed.map(item => {
          let emoji = "💬";
          let speaker = item.speaker;

          if (speaker.includes("Baek") || speaker.includes("백종원")) {
            emoji = "👨‍🍳 **백종원**";
          } else if (speaker.includes("Ahn") || speaker.includes("안성재")) {
            emoji = "👓 **안성재**";
          } else if (speaker.includes("Mediator") || speaker.includes("중재자")) {
            emoji = "🎤 **중재자**";
          }

          const lineInfo = item.line_number_referenced ? ` (L${item.line_number_referenced})` : "";

          return `> ${emoji}: ${item.statement}${lineInfo}`;
        }).join('\n\n');
      } else {
        finalDebateText = parsed.debate || JSON.stringify(parsed, null, 2);
      }

      // 2. 여러가지 필드명 대응 (debate, comment, result 등)
      finalDebateText = parsed.debate || parsed.comment || parsed.result || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));

      // 만약 여전히 객체라면 문자열화
      if (typeof finalDebateText === 'object') {
        finalDebateText = JSON.stringify(finalDebateText, null, 2);
      }
    } catch (e) {
      // JSON 파싱 실패 시 마크다운 코드 블록만 제거하고 원문 사용
      finalDebateText = debateRaw.replace(/```json|```/g, '').trim();
    }

    // [중요] createSafeReview 대신 createComment를 사용하여 대화 형식으로 출력
    await github.rest.issues.createComment({
      owner: repoOwner,
      repo: repoName,
      issue_number: prNumber,
      body: `## 🤝 심사 결과\n\n${finalDebateText}`
    });
    console.log("[System] Final debate posted.");
  } catch (e) {
    console.log('prompt error: ', e)
  }
}