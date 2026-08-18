import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "회의록 자동 생성기 | Input · Process · Output",
  description: "회의 전사문을 3단계로 입력하고 다듬어 실무용 회의록으로 완성하세요.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}

