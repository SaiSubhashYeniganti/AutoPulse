"use client";

import { useState } from "react";

interface FeedTabsProps {
  marketCount: number;
  cars24Count: number;
  marketPane: React.ReactNode;
  cars24Pane: React.ReactNode;
}

export function FeedTabs({ marketCount, cars24Count, marketPane, cars24Pane }: FeedTabsProps) {
  const [tab, setTab] = useState<"market" | "cars24">("market");

  return (
    <div>
      <div className="flex items-center gap-6 border-b border-apple-300 mb-8">
        <TabButton
          isActive={tab === "market"}
          onClick={() => setTab("market")}
          label="Market & Competitors"
          count={marketCount}
        />
        <TabButton
          isActive={tab === "cars24"}
          onClick={() => setTab("cars24")}
          label="Cars24"
          count={cars24Count}
        />
      </div>
      <div className={tab === "market" ? "block animate-fade-in-up" : "hidden"}>{marketPane}</div>
      <div className={tab === "cars24" ? "block animate-fade-in-up" : "hidden"}>{cars24Pane}</div>
    </div>
  );
}

function TabButton({
  isActive,
  onClick,
  label,
  count,
}: {
  isActive: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "py-3 text-[15px] flex items-center gap-2 border-b-2 -mb-[1px] transition-all outline-none font-semibold " +
        (isActive
          ? "border-apple-800 text-apple-800"
          : "border-transparent text-apple-400 hover:text-apple-800")
      }
    >
      <span>{label}</span>
      <span className={
        "font-mono text-[12px] px-2 py-0.5 rounded-full font-medium " + (isActive ? "bg-apple-200 text-apple-800" : "bg-apple-100 text-apple-400")
      }>{count}</span>
    </button>
  );
}
