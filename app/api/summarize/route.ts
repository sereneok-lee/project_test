const BASE_PROMPT = `당신은 공식 회의록 작성자입니다. 제공된 회의 전사문만 근거로 한국어 회의록을 작성하세요.
전사문에 없는 참석자, 담당자, 기한, 결론, 평가를 추정하지 마세요. 불확실한 정보는 확인 필요, 화자는 화자 미상, 담당자는 담당자 미지정, 기한은 기한 미정으로 표시하세요.
반복 발언과 의례적 표현은 줄이되 숫자, 금액, 일정, 등급, 조건, 고유명사는 보존하세요. 단순 질문이나 제안은 결정사항으로 승격하지 말고, 실제 합의·의결된 내용만 결정사항에 넣으세요.
반드시 다음 Markdown 순서로 출력하세요: # 회의록, ## 1. 회의 개요, ## 2. 주요 논의사항, ## 3. 결정사항, ## 4. 액션 아이템, ## 5. 미결사항 및 확인 필요 사항, ## 6. 다음 회의. 액션 아이템에는 후속 조치·담당자·기한·근거/상태 열을 둔 표를 사용하세요. 설명이나 서문 없이 Markdown만 반환하세요.`;

type Payload = { provider?: "openai" | "gemini"; model?: string; apiKey?: string; transcript?: string; style?: string; length?: string };

function errorResponse(message: string, status = 400) { return Response.json({ error: message }, { status }); }

export async function POST(request: Request) {
  let body: Payload;
  try { body = await request.json() as Payload; } catch { return errorResponse("요청 형식이 올바르지 않습니다."); }
  const { provider, model, apiKey, transcript, style = "formal", length = "standard" } = body;
  if (!apiKey?.trim()) return errorResponse("API 키가 필요합니다.");
  if (!transcript?.trim()) return errorResponse("회의 전사문이 필요합니다.");
  if (transcript.length > 200_000) return errorResponse("전사문은 200,000자 이하만 지원합니다.");
  if (provider !== "openai" && provider !== "gemini") return errorResponse("지원하지 않는 요약 엔진입니다.");

  const styleInstruction = { formal: "공식 보고서에 바로 사용할 수 있는 정중한 문체", concise: "중복을 과감히 줄이고 핵심 논점과 결정 중심의 간결한 문체", decision: "결정사항, 담당자, 기한, 후속 조치를 가장 선명하게 드러내는 문체" }[style as "formal" | "concise" | "decision"] || "공식 보고서에 바로 사용할 수 있는 정중한 문체";
  const lengthInstruction = { short: "짧게 작성하고 핵심만 남기세요.", standard: "핵심 논의와 결정 근거를 균형 있게 작성하세요.", detailed: "쟁점별 논의 흐름과 결정 근거를 충분히 포함하세요." }[length as "short" | "standard" | "detailed"] || "핵심 논의와 결정 근거를 균형 있게 작성하세요.";
  const systemPrompt = BASE_PROMPT + `\n이번 요청의 출력 기준:\n- 요약 스타일: ${styleInstruction}\n- 출력 분량: ${lengthInstruction}`;

  try {
    let markdown = "";
    if (provider === "openai") {
      const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: model || "gpt-5.6-luna", input: [{ role: "system", content: [{ type: "input_text", text: systemPrompt }] }, { role: "user", content: [{ type: "input_text", text: transcript }] }] }) });
      const data = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }>; error?: { message?: string } };
      if (!response.ok) return errorResponse(data.error?.message || "OpenAI API 요청이 거부되었습니다.", response.status === 401 ? 401 : 502);
      markdown = data.output_text || data.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("") || "";
    } else {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || "gemini-3.5-flash-lite")}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: "user", parts: [{ text: transcript }] }] }) });
      const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
      if (!response.ok) return errorResponse(data.error?.message || "Gemini API 요청이 거부되었습니다.", response.status === 401 || response.status === 403 ? 401 : 502);
      markdown = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") || "";
    }
    if (!markdown.trim()) return errorResponse("AI가 회의록을 반환하지 않았습니다.", 502);
    return Response.json({ markdown });
  } catch { return errorResponse("AI 제공자와 통신하지 못했습니다. 잠시 후 다시 시도해 주세요.", 502); }
}

