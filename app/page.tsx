"use client";

import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";

type Provider = "openai" | "gemini";
type AppStatus = "idle" | "reading" | "generating" | "success" | "error";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 200_000;
const MODELS: Record<Provider, { label: string; id: string }> = {
  openai: { label: "Luna", id: "gpt-5.6-luna" },
  gemini: { label: "Gemini 3.5 Flash-Lite", id: "gemini-3.5-flash-lite" },
};

const sampleMinutes = `# 회의록\n\n## 1. 회의 개요\n| 항목 | 내용 |\n|---|---|\n| 회의명 | AI 신약개발 플랫폼 구축지원사업 2단계 평가위원회 |\n| 일시 | 2026년 8월 10일 14:00 ~ 15:00 |\n| 참석자 | 평가위원 4명, 발표자 1명, 간사 1명 |\n\n## 2. 주요 논의사항\n- 검증 데이터셋 확보 계획과 모델 성능 검증 범위를 확인했습니다.\n- 선행기술조사와 특허 침해 가능성 분석이 필요합니다.\n- 파일럿 제약사와의 협력은 아직 협의 단계입니다.\n\n## 3. 결정사항\n1. 조건부 선정 및 A등급으로 의결했습니다.\n2. 지원금액은 10억 8천만 원으로 조정했습니다.\n\n## 4. 액션 아이템\n| 후속 조치 | 담당자 | 기한 |\n|---|---|---|\n| 데이터셋 확보 및 검증계획서 제출 | 담당자 미지정 | 협약 전 |\n| 선행기술조사 결과서 제출 | 담당자 미지정 | 협약 전 |\n| 파일럿 제약사 1곳 이상 MOU 체결 | 신청기관 | 협약 전 |`;

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderMarkdown(markdown: string) {
  return markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^\|(.+)\|$/gm, (line) => {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (cells.every((cell) => /^[-: ]+$/.test(cell))) return "";
      return `<div class="md-table-row">${cells.map((cell) => `<span>${cell}</span>`).join("")}</div>`;
    })
    .replace(/^- (.*)$/gm, "<li>$1</li>")
    .replace(/^(\d+)\. (.*)$/gm, "<li>$2</li>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n{2,}/g, "<br /><br />")
    .replace(/\n/g, "<br />");
}

async function extractDocxText(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder("utf-8");
  const eocd = 0x06054b50;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (view.getUint32(i, true) === eocd) { end = i; break; }
  }
  if (end < 0) throw new Error("DOCX 압축 구조를 읽을 수 없습니다.");
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  let cursor = centralOffset;
  let documentXml: string | null = null;
  while (cursor < centralOffset + centralSize) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + fileNameLength));
    if (name === "word/document.xml") {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(start, start + compressedSize);
      const raw = method === 0 ? compressed : await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
      documentXml = decoder.decode(raw);
    }
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  if (!documentXml) throw new Error("DOCX 본문을 찾을 수 없습니다.");
  const xml = new DOMParser().parseFromString(documentXml, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("DOCX 본문 XML을 해석할 수 없습니다.");
  const body = xml.getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "body")[0];
  const output: string[] = [];
  Array.from(body?.children ?? []).forEach((element) => {
    if (element.localName === "p") {
      const text = Array.from(element.getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "t")).map((node) => node.textContent ?? "").join("").trim();
      if (text) output.push(text);
    }
    if (element.localName === "tbl") {
      Array.from(element.getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "tr")).forEach((row) => {
        const cells = Array.from(row.getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "tc")).map((cell) => Array.from(cell.getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "t")).map((node) => node.textContent ?? "").join("").trim());
        if (cells.some(Boolean)) output.push(cells.join(" | "));
      });
    }
  });
  return output.join("\n").slice(0, MAX_TEXT_LENGTH);
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<Provider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [transcript, setTranscript] = useState("");
  const [result, setResult] = useState("");
  const [status, setStatus] = useState<AppStatus>("idle");
  const [error, setError] = useState("");
  const model = useMemo(() => MODELS[provider], [provider]);

  async function acceptFile(nextFile?: File) {
    if (!nextFile) return;
    setError(""); setResult(""); setStatus("reading");
    if (!nextFile.name.toLowerCase().endsWith(".docx")) { setError("DOCX 파일만 업로드할 수 있습니다."); setStatus("error"); return; }
    if (nextFile.size > MAX_FILE_SIZE) { setError("파일 크기는 10MB 이하만 지원합니다."); setStatus("error"); return; }
    try {
      const text = await extractDocxText(nextFile);
      if (!text.trim()) throw new Error("DOCX에서 읽을 수 있는 본문이 없습니다.");
      setFile(nextFile); setTranscript(text); setStatus("idle");
    } catch (err) { setError(err instanceof Error ? err.message : "파일을 읽지 못했습니다."); setStatus("error"); }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); void acceptFile(event.dataTransfer.files[0]); }
  function onChange(event: ChangeEvent<HTMLInputElement>) { void acceptFile(event.target.files?.[0]); }

  async function generateMinutes() {
    if (!apiKey.trim()) { setError("선택한 API의 키를 입력해 주세요."); setStatus("error"); return; }
    if (!transcript) { setError("먼저 DOCX 전사문을 업로드해 주세요."); setStatus("error"); return; }
    setError(""); setStatus("generating");
    try {
      const response = await fetch("/api/summarize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, model: model.id, apiKey, transcript }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "요약 요청에 실패했습니다.");
      setResult(data.markdown); setApiKey(""); setStatus("success");
    } catch (err) { setError(err instanceof Error ? err.message : "요약 중 오류가 발생했습니다."); setStatus("error"); }
  }

  function downloadResult() {
    const blob = new Blob([result], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "회의록.md"; anchor.click(); URL.revokeObjectURL(url);
  }

  return (
    <main>
      <header className="topbar"><div className="brand"><span className="brand-mark">M</span><span>회의록 작성기</span></div><span className="privacy-note">🔒 키와 문서는 저장하지 않습니다</span></header>
      <section className="hero"><div className="eyebrow">MEETING MINUTES / WORKSPACE</div><h1>전사문을<br /><em>실무용 회의록</em>으로.</h1><p>회의 전사문 DOCX를 올리고, 원하는 AI 엔진을 선택하면 공식 회의록이 바로 완성됩니다.</p><div className="hero-points"><span>01 · DOCX 업로드</span><span>02 · AI 엔진 선택</span><span>03 · Markdown 결과</span></div></section>
      <section className="workspace-grid">
        <div className="panel input-panel">
          <div className="panel-heading"><div><span className="step">STEP 01</span><h2>전사문 업로드</h2></div><span className="format-badge">.DOCX</span></div>
          <div className={`dropzone ${file ? "has-file" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop} onClick={() => inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }}>
            <input ref={inputRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={onChange} hidden />
            <div className="upload-icon">↑</div>{file ? <><strong>{file.name}</strong><span>{formatBytes(file.size)} · 본문 추출 완료</span></> : <><strong>DOCX 파일을 드래그하거나 클릭하세요</strong><span>최대 10MB · 전사문 200,000자까지</span></>}
          </div>
          <div className="divider"><span>요약 엔진 설정</span></div>
          <div className="provider-switch" role="group" aria-label="요약 엔진 선택"><button className={provider === "openai" ? "active" : ""} onClick={() => setProvider("openai")}><span className="provider-dot openai-dot">◒</span> OpenAI</button><button className={provider === "gemini" ? "active" : ""} onClick={() => setProvider("gemini")}><span className="provider-dot gemini-dot">✦</span> Gemini</button></div>
          <label className="field-label" htmlFor="api-key">{provider === "openai" ? "OpenAI" : "Gemini"} API 키 <span>필수</span></label>
          <input id="api-key" className="text-input" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="API 키를 입력하세요" autoComplete="off" />
          <div className="model-row"><span>기본 모델</span><strong>{model.label}</strong><code>{model.id}</code></div>
          <button className="primary-button" disabled={status === "reading" || status === "generating"} onClick={generateMinutes}>{status === "generating" ? "회의록 생성 중…" : status === "reading" ? "파일 읽는 중…" : "회의록 생성하기 →"}</button>
          {error && <div className="error-box" role="alert">{error}</div>}
          <p className="security-copy">API 키는 이 요청에만 사용되며 결과 생성 후 화면에서 즉시 비워집니다. 키와 전사문은 데이터베이스에 저장하지 않습니다.</p>
        </div>
        <div className="panel result-panel">
          <div className="panel-heading"><div><span className="step">STEP 02</span><h2>회의록 결과</h2></div>{result && <div className="result-actions"><button onClick={() => navigator.clipboard.writeText(result)}>복사</button><button onClick={downloadResult}>↓ .md</button></div>}</div>
          {!result ? <div className="empty-result"><div className="empty-orbit">✦</div><h3>생성된 회의록이 여기에 표시됩니다</h3><p>왼쪽에서 전사문을 업로드하고<br />AI 엔진을 선택해 보세요.</p><div className="sample-result" onClick={() => { setResult(sampleMinutes); setStatus("success"); }}><span>미리보기</span> 샘플 회의록 보기 →</div></div> : <div className="markdown-result" dangerouslySetInnerHTML={{ __html: renderMarkdown(result) }} />}
        </div>
      </section>
      <footer><span>회의록 작성기 · AI-powered meeting minutes</span><span>OpenAI · Gemini 선택 지원</span></footer>
    </main>
  );
}
