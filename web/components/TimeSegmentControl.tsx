"use client";

import { useState } from "react";
import Link from "next/link";
import { StoryRow } from "@/components/StoryRow";
import type { HeroStory } from "@/lib/supabase";

export function TimeSegmentControl({
  todayLabel,
  todayStories,
  weeklyStories,
  weeklyLabel = "This week",
  yesterdayStories,
  yesterdayDate,
  seeAllHref,
}: {
  todayLabel: string;
  todayStories: HeroStory[];
  weeklyStories: HeroStory[];
  weeklyLabel?: string;
  yesterdayStories: HeroStory[];
  yesterdayDate: string | null;
  seeAllHref: string;
}) {
  const hasYesterday = yesterdayDate !== null;
  const [tab, setTab] = useState<"today" | "weekly" | "yesterday">("today");

  // Format yesterday date for tab
  const yesterdayText = yesterdayDate ? new Date(yesterdayDate).toLocaleDateString("en-IN", { weekday: "short" }) : "Yesterday";

  return (
    <div>
      {/* Apple-style segmented control */}
      <div className="bg-[#E8E8ED] p-1 rounded-lg flex items-center mb-8 w-full sm:w-auto sm:inline-flex">
        <SegmentButton 
          isActive={tab === "today"} 
          onClick={() => setTab("today")} 
          label="Today" 
        />
        <SegmentButton 
          isActive={tab === "weekly"} 
          onClick={() => setTab("weekly")} 
          label={weeklyLabel === "Earlier in the last 14 days" ? "Last 14 Days" : "Last 7 Days"} 
        />
        {hasYesterday && (
          <SegmentButton 
            isActive={tab === "yesterday"} 
            onClick={() => setTab("yesterday")} 
            label={yesterdayText} 
          />
        )}
      </div>

      {/* Content */}
      <div className="min-h-[400px]">
        {tab === "today" && (
          <div className="animate-fade-in-up">
            <SectionHeader title={todayLabel} count={todayStories.length} />
            {todayStories.length === 0 ? (
              <EmptyHint message="Nothing new in this window. Check back later." />
            ) : (
              <div>
                {todayStories.map((s, i) => (
                  <StoryRow key={s.story_id} story={s} index={i} />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "weekly" && (
          <div className="animate-fade-in-up">
            <SectionHeader 
              title={weeklyLabel} 
              count={weeklyStories.length} 
              action={
                <Link href={seeAllHref} className="text-[13px] font-medium text-apple-blue hover:text-apple-blueHover transition-colors">
                  See all →
                </Link>
              }
            />
            {weeklyStories.length === 0 ? (
              <EmptyHint message="Nothing else of high note in this window." />
            ) : (
              <div>
                {weeklyStories.map((s, i) => (
                  <StoryRow key={s.story_id} story={s} index={i} />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "yesterday" && hasYesterday && (
          <div className="animate-fade-in-up">
            <SectionHeader title={`Yesterday — ${new Date(yesterdayDate).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short"})}`} count={yesterdayStories.length} />
            {yesterdayStories.length === 0 ? (
              <EmptyHint message="No stories logged for yesterday in this lane." />
            ) : (
              <div>
                {yesterdayStories.map((s, i) => (
                  <StoryRow key={s.story_id} story={s} index={i} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SegmentButton({ isActive, onClick, label }: { isActive: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 sm:px-8 py-1.5 rounded-md text-[13px] font-medium transition-all duration-200 outline-none ${
        isActive 
          ? "bg-white text-apple-900 shadow-[0_3px_8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)]" 
          : "text-apple-500 hover:text-apple-800"
      }`}
    >
      {label}
    </button>
  );
}

function SectionHeader({ title, count, action }: { title: string; count: number; action?: React.ReactNode }) {
  return (
    <header className="flex items-baseline justify-between border-b border-apple-300 pb-3 mb-5">
      <h2 className="font-display text-2xl font-bold text-apple-800 tracking-tight">
        {title} <span className="font-mono text-[13px] font-medium text-apple-400 ml-2">{count}</span>
      </h2>
      {action}
    </header>
  );
}

function EmptyHint({ message }: { message: string }) {
  return (
    <p className="text-[15px] text-apple-500 py-6 font-sans text-center">{message}</p>
  );
}
