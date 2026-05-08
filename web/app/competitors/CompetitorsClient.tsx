"use client";

import { useState } from "react";
import { StoryRow } from "@/components/StoryRow";
import type {
  Story,
  CompetitorSummary,
  EventLedgerSummary,
  LedgerEvent,
  LedgerPattern,
  ThemedSummary,
} from "@/lib/supabase";
import { isEventLedger } from "@/lib/supabase";

type StoryLink = { url: string | null; source: string | null; title: string };

interface CompetitorData {
  thisWeek: Story[];
  archive: Story[];
  weekly: CompetitorSummary | null;
  quarterly: CompetitorSummary | null;
  totalCount: number;
  storyLinks: Record<string, StoryLink>;
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
          const isCars24 = c === "Cars24";
          return (
            <li key={c} className={isCars24 ? "border-t-4 border-t-apple-200" : ""}>
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
  storyLinks,
}: {
  competitor: string;
  thisWeek: Story[];
  archive: Story[];
  weekly: CompetitorSummary | null;
  quarterly: CompetitorSummary | null;
  totalCount: number;
  storyLinks: Record<string, StoryLink>;
}) {
  const isCars24 = competitor === "Cars24";
  const quarterlySummary = quarterly?.themed_summary ?? null;
  const isLedger = quarterlySummary !== null && isEventLedger(quarterlySummary);

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

      {/* ── Quarterly: TL;DR + ledger + patterns + Cars24 implications ── */}
      {quarterlySummary && totalCount > 0 && isLedger && (
        <QuarterlyLedger
          summary={quarterlySummary as EventLedgerSummary}
          storyLinks={storyLinks}
          isCars24={isCars24}
        />
      )}
      {/* Backwards-compat: rows written by the older themed-summary path */}
      {quarterlySummary && totalCount > 0 && !isLedger && (
        <CompetitorSection
          title={isCars24 ? "Press narratives" : "Strategic themes"}
          count={(quarterlySummary as ThemedSummary).themes?.length ?? 0}
          subtitle="Last 90 days"
        >
          <ThemedList summary={quarterlySummary as ThemedSummary} />
        </CompetitorSection>
      )}

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

// ─── Quarterly: Event ledger view ───────────────────────────────────────────
// Reads like an analyst brief: TL;DR up top, then an exhaustive event ledger
// grouped by type, then patterns (only if any were found), then Cars24
// implications. Each event links to its source story.

const EVENT_TYPE_LABEL: Record<string, string> = {
  funding: "Funding & corporate",
  acquisition: "Funding & corporate",
  product: "Product",
  expansion: "Expansion",
  hire: "People",
  departure: "People",
  partnership: "Partnerships",
  regulatory: "Regulatory & legal",
  layoff: "Restructuring",
  pricing: "Pricing",
  other: "Other",
};

const EVENT_GROUP_ORDER = [
  "Funding & corporate",
  "Product",
  "Expansion",
  "Partnerships",
  "People",
  "Pricing",
  "Regulatory & legal",
  "Restructuring",
  "Other",
];

function groupEventsByType(events: LedgerEvent[]): Record<string, LedgerEvent[]> {
  const out: Record<string, LedgerEvent[]> = {};
  for (const e of events) {
    const group = EVENT_TYPE_LABEL[e.type] ?? "Other";
    if (!out[group]) out[group] = [];
    out[group].push(e);
  }
  return out;
}

function formatEventDate(iso: string): string {
  // "2026-04-12" -> "Apr 12"
  try {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

function QuarterlyLedger({
  summary,
  storyLinks,
  isCars24,
}: {
  summary: EventLedgerSummary;
  storyLinks: Record<string, StoryLink>;
  isCars24: boolean;
}) {
  const grouped = groupEventsByType(summary.events);
  const orderedGroups = EVENT_GROUP_ORDER.filter((g) => grouped[g]?.length);

  return (
    <section className="mb-14">
      <header className="border-b border-apple-300 pb-3 mb-6 flex items-baseline justify-between gap-4">
        <h2 className="font-display text-2xl font-bold text-apple-800 tracking-tight">
          {isCars24 ? "Press narrative" : "Quarter in review"}{" "}
          <span className="font-mono text-[14px] font-medium text-apple-400 ml-2">
            {summary.events.length} event{summary.events.length === 1 ? "" : "s"}
          </span>
        </h2>
        <span className="text-[12px] uppercase tracking-widest text-apple-400 font-semibold">
          Last 90 days
        </span>
      </header>

      {/* TL;DR */}
      {summary.tldr && (
        <p className="text-[16px] leading-relaxed text-apple-800 font-sans mb-8 bg-apple-50 border-l-2 border-apple-blue px-5 py-4 rounded-r">
          {summary.tldr}
        </p>
      )}

      {/* Event ledger — exhaustive, grouped by type */}
      {summary.events.length === 0 ? (
        <EmptyHint message="No material events logged in the last 90 days." />
      ) : (
        <div>
          <h3 className="text-[12px] uppercase tracking-widest text-apple-400 font-semibold mb-4">
            What they did
          </h3>
          <div className="space-y-7">
            {orderedGroups.map((group) => (
              <div key={group}>
                <h4 className="font-display text-[15px] font-semibold text-apple-800 tracking-tight mb-2">
                  {group}
                </h4>
                <ul className="space-y-2">
                  {grouped[group].map((e, i) => (
                    <EventRow
                      key={`${e.story_id}-${i}`}
                      event={e}
                      link={storyLinks[e.story_id]}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Patterns — only if any were detected */}
      {summary.patterns.length > 0 && (
        <div className="mt-10">
          <h3 className="text-[12px] uppercase tracking-widest text-apple-400 font-semibold mb-4">
            Patterns worth flagging
          </h3>
          <ul className="space-y-4">
            {summary.patterns.map((p, i) => (
              <PatternRow
                key={i}
                pattern={p}
                storyLinks={storyLinks}
              />
            ))}
          </ul>
        </div>
      )}

      {/* Cars24 implications */}
      {!isCars24 && summary.cars24_implications.length > 0 && (
        <div className="mt-10 border-t border-apple-200 pt-6">
          <h3 className="text-[12px] uppercase tracking-widest text-apple-400 font-semibold mb-4">
            So what for Cars24
          </h3>
          <ul className="space-y-3">
            {summary.cars24_implications.map((line, i) => (
              <li
                key={i}
                className="text-[15px] leading-relaxed text-apple-800 font-sans flex items-start gap-3"
              >
                <span className="text-apple-blue mt-1 leading-none text-xl shrink-0">→</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function EventRow({
  event,
  link,
}: {
  event: LedgerEvent;
  link: StoryLink | undefined;
}) {
  const date = formatEventDate(event.date);
  return (
    <li className="text-[14.5px] leading-relaxed text-apple-700 font-sans flex items-start gap-3">
      <span className="font-mono text-[12.5px] text-apple-400 mt-0.5 shrink-0 w-14">
        {date}
      </span>
      <span className="flex-1">
        {event.headline}
        {link?.url && (
          <>
            {" "}
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12.5px] text-apple-blue hover:text-apple-blueHover hover:underline transition-colors whitespace-nowrap"
            >
              {link.source ? `↗ ${link.source}` : "↗ source"}
            </a>
          </>
        )}
      </span>
    </li>
  );
}

function PatternRow({
  pattern,
  storyLinks,
}: {
  pattern: LedgerPattern;
  storyLinks: Record<string, StoryLink>;
}) {
  return (
    <li className="border-l-2 border-apple-300 pl-4 py-1">
      <h4 className="font-display text-[16px] font-semibold text-apple-800 tracking-tight">
        {pattern.title}
      </h4>
      <p className="mt-1 text-[14.5px] leading-relaxed text-apple-700 font-sans">
        {pattern.description}
      </p>
      {pattern.story_ids.length > 0 && (
        <p className="mt-2 text-[12.5px] text-apple-500 font-sans flex flex-wrap gap-x-2 gap-y-1">
          <span className="text-apple-400">Supporting events:</span>
          {pattern.story_ids.map((id, i) => {
            const link = storyLinks[id];
            if (!link) return null;
            return link.url ? (
              <a
                key={id}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-apple-blue hover:text-apple-blueHover hover:underline transition-colors"
              >
                ↗ {link.source ?? "source"}
                {i < pattern.story_ids.length - 1 ? "" : ""}
              </a>
            ) : (
              <span key={id}>{link.title.slice(0, 40)}</span>
            );
          })}
        </p>
      )}
    </li>
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

function ThemedList({ summary }: { summary: ThemedSummary }) {
  if (!summary || !summary.themes) return null;
  return (
    <div>
      {summary.themes.map((t, i) => (
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
