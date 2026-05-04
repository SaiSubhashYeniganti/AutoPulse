// StoryRow — the new compact unit shown in Today / This Week / Yesterday lists.

import type { HeroStory, SourceArticle, Story } from "@/lib/supabase";

type RowStory = Pick<
  HeroStory & Story,
  | "title"
  | "short_summary"
  | "summary"
  | "cars24_implication"
  | "importance"
  | "bucket"
  | "source_count"
  | "source_articles"
  | "primary_source_name"
  | "primary_source_url"
  | "published_at"
> & { story_id?: string; id?: string };

const BUCKET_LABEL: Record<string, string> = {
  MARKET: "Market",
  COMPETITOR: "Competitor",
  CARS24_PRESS: "Press",
  CARS24_PR: "PR",
};

function formatStoryTimestamp(iso: string): string {
  const ts = new Date(iso).getTime();
  const diffMs = Date.now() - ts;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

export function StoryRow({ story, index = 0 }: { story: RowStory; index?: number }) {
  const bucketLabel = BUCKET_LABEL[story.bucket] ?? story.bucket;
  const sourceLabel = story.primary_source_name ?? "source";
  const otherSources = story.source_articles
    ? story.source_articles.filter((a) => a.url !== story.primary_source_url)
    : [];

  const staggerClass = index < 5 ? `stagger-${index + 1}` : '';

  return (
    <details className={`group editorial-row px-2 sm:px-4 py-6 animate-fade-in-up opacity-0 ${staggerClass}`}>
      <summary className="cursor-pointer list-none outline-none">
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-medium text-apple-400">
              <span className="text-apple-800 font-semibold tracking-wide uppercase text-[10px]">
                {bucketLabel}
              </span>
              <span className="text-apple-300 font-normal" aria-hidden="true">/</span>
              <span className="tracking-wide">{formatStoryTimestamp(story.published_at)}</span>
              <span className="text-apple-300 font-normal" aria-hidden="true">/</span>
              <span className="tracking-wide">
                Sources <span className="text-apple-800 font-mono ml-0.5">{story.source_count}</span>
              </span>
            </div>

            <h3 className="mt-3 font-display text-[20px] sm:text-[26px] font-bold text-apple-900 leading-tight tracking-tight">
              {story.title}
            </h3>

            {story.short_summary && (
              <p className="mt-2.5 text-[15px] sm:text-[17px] text-apple-500 leading-relaxed font-sans">
                {story.short_summary}
              </p>
            )}

            {story.cars24_implication && (
              <div className="mt-6 border-l-[3px] border-apple-200 pl-4 py-1">
                <span className="block text-[11px] font-bold uppercase tracking-widest text-apple-400 mb-1.5">
                  Cars24 Impact
                </span>
                <p className="text-[14px] sm:text-[15px] leading-relaxed text-apple-700 font-sans font-medium">
                  {story.cars24_implication}
                </p>
              </div>
            )}
          </div>

          <span className="chevron mt-2 text-apple-300 text-2xl font-light group-open:rotate-90 group-hover:text-apple-500 transition-colors" aria-hidden="true">
            ›
          </span>
        </div>
      </summary>

      <div className="mt-6 pt-6 border-t border-apple-100 pl-4 sm:pl-0">
        <p className="text-[16px] leading-relaxed text-apple-700 font-sans">{story.summary}</p>

        {(story.primary_source_url || otherSources.length > 0) && (
          <details className="mt-8 group/sources">
            <summary className="cursor-pointer list-none outline-none flex items-center gap-2 text-[12px] font-semibold uppercase tracking-widest text-apple-500 hover:text-apple-800 transition-colors select-none w-fit">
              <span className="chevron group-open/sources:rotate-90 transition-transform text-lg leading-none mt-[-2px]">›</span>
              <span>Sources <span className="font-mono ml-1 bg-apple-100 text-apple-800 px-1.5 py-0.5 rounded">{story.source_count}</span></span>
            </summary>
            <ul className="border-t border-apple-100 mt-4">
              {story.primary_source_url && (
                <SourceLink
                  name={sourceLabel}
                  url={story.primary_source_url}
                  date={story.published_at}
                  primary
                />
              )}
              {otherSources.map((a: SourceArticle) => (
                <SourceLink
                  key={a.url}
                  name={a.name}
                  url={a.url}
                  date={a.published_at}
                />
              ))}
            </ul>
          </details>
        )}
      </div>
    </details>
  );
}

function SourceLink({
  name,
  url,
  date,
  primary,
}: {
  name: string;
  url: string;
  date: string;
  primary?: boolean;
}) {
  return (
    <li className="border-b border-apple-100">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="group/src flex items-center justify-between gap-4 py-3 px-1 hover:bg-apple-50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className={"text-[14px] truncate " + (primary ? "font-semibold text-apple-800" : "font-medium text-apple-700 group-hover/src:text-apple-blue")}>
            {name}
          </span>
          {primary && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-apple-blue bg-apple-50 px-1.5 py-0.5 rounded shrink-0">
              Primary
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[12px] font-mono text-apple-400">
            {new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
          </span>
          <span aria-hidden="true" className="text-apple-300 group-hover/src:text-apple-blue group-hover/src:translate-x-0.5 transition-all text-base">
            ↗
          </span>
        </div>
      </a>
    </li>
  );
}
