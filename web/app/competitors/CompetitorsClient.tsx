"use client";

import { useState } from "react";
import { StoryRow } from "@/components/StoryRow";
import type { Story, CompetitorSummary } from "@/lib/supabase";

interface CompetitorData {
  thisWeek: Story[];
  archive: Story[];
  weekly: CompetitorSummary | null;
  quarterly: CompetitorSummary | null;
  totalCount: number;
}

interface Props {
  ranked: string[];
  counts: Record<string, number>;
  initialSelected: string;
  dataMap: Record<string, CompetitorData>;
}

export function CompetitorsClient({ ranked, counts, initialSelected, dataMap }: Props) {
  const [selected, setSelected] = useState(initialSelected);

  const data = dataMap[selected];

  if (!data) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-10 items-start animate-fade-in-up stagger-1 opacity-0">
      <CompetitorPicker
        competitors={ranked}
        counts={counts}
        selected={selected}
        onSelect={setSelected}
      />
      <CompetitorDetail
        key={selected} // force re-render/re-animate on change
        competitor={selected}
        {...data}
      />
    </div>
  );
}

// ─── Left rail ─────────────────────────────────────────────────────────────────

function CompetitorPicker({
  competitors,
  counts,
  selected,
  onSelect,
}: {
  competitors: string[];
  counts: Record<string, number>;
  selected: string;
  onSelect: (c: string) => void;
}) {
  return (
    <aside className="lg:sticky lg:top-8 lg:self-start">
      <h2 className="text-[13px] font-bold text-apple-400 uppercase tracking-widest mb-4 px-1 pb-2">
        Companies <span className="font-mono ml-2 text-apple-800 bg-apple-200 px-2 py-0.5 rounded-full">{competitors.length}</span>
      </h2>
      <ul className="border-t border-b border-apple-100">
        {competitors.map((c) => {
          const count = counts[c] ?? 0;
          const isActive = c === selected;
          return (
            <li key={c}>
              <button
                onClick={() => onSelect(c)}
                className={
                  "w-full flex items-center justify-between gap-3 px-5 py-3.5 border-b border-apple-100 last:border-b-0 text-[15px] transition-colors outline-none " +
                  (isActive
                    ? "bg-apple-50 font-bold text-apple-800 border-l-2 border-l-apple-blue"
                    : "text-apple-500 hover:bg-apple-50 hover:text-apple-800 border-l-2 border-l-transparent text-left")
                }
              >
                <span className="truncate">{c}</span>
                <span className={"font-mono text-[12px] px-2 py-0.5 rounded-full font-medium " + (count === 0 ? "text-apple-400 bg-apple-100" : (isActive ? "bg-apple-200 text-apple-800" : "bg-apple-100 text-apple-500"))}>
                  {count}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

// ─── Right pane ────────────────────────────────────────────────────────────────

function CompetitorDetail({
  competitor,
  thisWeek,
  archive,
  weekly,
  quarterly,
  totalCount,
}: {
  competitor: string;
  thisWeek: Story[];
  archive: Story[];
  weekly: CompetitorSummary | null;
  quarterly: CompetitorSummary | null;
  totalCount: number;
}) {
  const isCars24 = competitor === "Cars24";
  return (
    <section className="animate-fade-in-up">
      <header className="border-b border-apple-300 pb-5 mb-8">
        <h2 className="font-display text-4xl font-bold text-apple-800 tracking-tight">{competitor}</h2>
        <p className="mt-4 text-[15px] text-apple-500 font-sans flex items-center flex-wrap gap-3 font-medium">
          <span className="font-mono text-apple-800 bg-apple-200 px-2 py-0.5 rounded-full">{thisWeek.length}</span> stor{thisWeek.length === 1 ? "y" : "ies"} this week
          <span className="text-apple-300" aria-hidden>|</span>
          <span className="font-mono text-apple-800 bg-apple-200 px-2 py-0.5 rounded-full">{totalCount}</span> last 90 days
          {isCars24 && (
            <>
              <span className="text-apple-300" aria-hidden>|</span>
              <span className="italic text-apple-400">how the press is covering us</span>
            </>
          )}
        </p>
      </header>

      <CompetitorSection title="This week" count={thisWeek.length}>
        {thisWeek.length === 0 ? (
          <EmptyHint message="No new coverage in the last 7 days." />
        ) : (
          <div>
            {thisWeek.map((s, i) => (
              <StoryRow key={s.id} story={{ ...s, story_id: s.id }} index={i} />
            ))}
          </div>
        )}
      </CompetitorSection>

      <CompetitorSection
        title={isCars24 ? "Press narratives" : "Strategic themes"}
        count={quarterly?.themed_summary?.themes?.length ?? 0}
        subtitle="Last 90 days"
      >
        {!quarterly ? (
          <EmptyHint message={
            totalCount === 0
              ? "No 90-day coverage yet. Themes appear once stories accumulate."
              : "Themes are still being built. Check back after the next pipeline run."
          } />
        ) : (
          <ThemedList summary={quarterly} />
        )}
      </CompetitorSection>

      <CompetitorSection title="Archive (last 90 days)" count={archive.length}>
        {archive.length === 0 ? (
          <EmptyHint message="No older stories to show." />
        ) : (
          <details className="border-t border-b border-apple-100 py-6 group">
            <summary className="cursor-pointer text-[14px] font-semibold text-apple-blue hover:text-apple-blueHover transition-colors outline-none flex items-center gap-2">
              <span className="chevron group-open:rotate-90">›</span>
              Expand all {archive.length} stor{archive.length === 1 ? "y" : "ies"}
            </summary>
            <div className="mt-6 border-t border-apple-200 pt-6">
              {archive.map((s) => (
                <StoryRow key={s.id} story={{ ...s, story_id: s.id }} />
              ))}
            </div>
          </details>
        )}
      </CompetitorSection>

      {weekly?.context_line && (
        <p className="mt-8 text-[15px] italic text-apple-500 border-t border-apple-300 pt-5 font-sans leading-relaxed">
          Last week's TL;DR: <span className="text-apple-800 font-medium">{weekly.context_line}</span>
        </p>
      )}
    </section>
  );
}

function CompetitorSection({
  title,
  count,
  subtitle,
  children,
}: {
  title: string;
  count: number;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-14">
      <header className="flex items-baseline justify-between border-b border-apple-300 pb-3 mb-6 gap-4">
        <h2 className="font-display text-2xl font-bold text-apple-800 tracking-tight">
          {title} <span className="font-mono text-[14px] font-medium text-apple-400 ml-2">{count}</span>
        </h2>
        {subtitle && (
          <span className="text-[12px] uppercase tracking-widest text-apple-400 font-semibold">{subtitle}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function EmptyHint({ message }: { message: string }) {
  return (
    <p className="text-[15px] text-apple-500 py-8 bg-[#F5F5F7] rounded-xl px-5 text-center font-sans border border-apple-200">{message}</p>
  );
}

function ThemedList({ summary }: { summary: CompetitorSummary }) {
  if (!summary.themed_summary || !summary.themed_summary.themes) return null;
  return (
    <div>
      {summary.themed_summary.themes.map((t, i) => (
        <div key={i} className="py-6 border-b border-apple-100 last:border-b-0 animate-fade-in-up" style={{ animationDelay: `${i * 60}ms`, animationFillMode: 'both' }}>
          <h3 className="font-display text-[18px] font-semibold text-apple-800 tracking-tight">
            {t.title}
          </h3>
          <ul className="mt-4 space-y-3">
            {t.bullets.map((b, j) => (
              <li key={j} className="text-[15px] leading-relaxed text-apple-700 font-sans flex items-start gap-3">
                <span className="text-apple-300 mt-1 leading-none text-xl shrink-0">•</span>
                <span>{renderInlineLinks(b)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function renderInlineLinks(text: string) {
  if (!text) return null;
  const regex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  const parts: React.ReactNode[] = [];
  let match;
  let i = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <a
        key={i++}
        href={match[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold text-apple-blue hover:text-apple-blueHover hover:underline transition-colors inline-block"
      >
        {match[1]}
      </a>
    );
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}
