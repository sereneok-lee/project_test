import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "회의록 작성기 | 전사문을 실무용 회의록으로",
  description: "DOCX 회의 전사문을 OpenAI 또는 Gemini로 공식 회의록으로 변환하세요.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
